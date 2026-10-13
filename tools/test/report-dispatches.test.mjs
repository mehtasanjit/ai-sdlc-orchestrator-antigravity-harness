/**
 * The report groups attempts by dispatch, not by packet: output-cap doubling
 * shows under the output-cap section, a packet dispatched twice shows as two
 * rows of its own, and each worker line counts dispatches, attempts and the
 * spend on failed attempts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");
const POLICY = "antigravity-flash38-plus-opus5";

const ev = (over) => ({
  ts: "2026-09-30T11:49:49.000Z", pass: "r1", phase: "codegen", task_type: "dto", task_id: "t", module: "m",
  model: "gemini-3.8-flash", adapter: "mcp:model-dispatch", routed_by: "orchestrator", provenance: "vendor",
  routing: { policy_name: POLICY, policy_version: 1, rule_index: 0, rule_reason: "x" },
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.01, latency_ms: 10, success: true, retry_count: 0,
  ...over,
});

const OPUS = { phase: "requirements_analysis", task_type: "requirements", task_id: "phase-1-requirements", model: "claude-opus-5", adapter: "claude-agent-sdk", attempt_number: 1, ceiling_used: null };

const EVENTS = [
  ev({ task_id: "c1", dispatch_id: "d-1", attempt_number: 1, ceiling_used: 3000, hit_output_cap: true, success: false, cost_usd: 0.012 }),
  ev({ task_id: "c1", dispatch_id: "d-1", attempt_number: 2, ceiling_used: 6000, hit_output_cap: true, success: false, cost_usd: 0.023 }),
  ev({ task_id: "c1", dispatch_id: "d-1", attempt_number: 3, ceiling_used: 8192, hit_output_cap: true, success: false, cost_usd: 0.031, terminal_reason: "output_cap_at_model_absolute" }),
  ev({ ...OPUS, dispatch_id: "d-2", success: false, cost_usd: 0.56569, terminal_reason: "vendor_error" }),
  ev({ ...OPUS, dispatch_id: "d-3", success: true, cost_usd: 0.345283, terminal_reason: "success" }),
];

function runDir(events) {
  const dir = mkdtempSync(join(tmpdir(), "agy-report-dispatches-"));
  copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(dir, "policy_snapshot.yaml"));
  writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

const report = (dir, ...flags) => {
  const r = spawnSync(process.execPath, [REPORT, dir, "--run-id=r1", ...flags], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("each worker line counts dispatches apart from attempts, with the failed spend", () => {
  const dir = runDir(EVENTS);
  try {
    const m = buildHarnessManifest({ runDir: dir, runId: "r1", env: { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" } });
    const gemini = m.cost.lines.find((l) => l.line === "gemini_workers");
    const claude = m.cost.lines.find((l) => l.line === "claude_worker");
    assert.deepEqual([gemini.calls, gemini.attempts, gemini.dispatches, gemini.failed_attempts, gemini.failed_cost_usd], [3, 3, 1, 3, 0.066]);
    assert.deepEqual([claude.calls, claude.attempts, claude.dispatches, claude.failed_attempts, claude.failed_cost_usd], [2, 2, 2, 1, 0.56569]);
    assert.equal(m.model_breakdown["claude-opus-5"].dispatches, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only the doubling dispatch is under the output cap; the packet dispatched twice is two rows of its own", () => {
  const dir = runDir(EVENTS);
  try {
    const text = report(dir);
    const capped = text.slice(text.indexOf("Packets that hit the output cap"), text.indexOf("Packets dispatched more than once"));
    assert.match(capped, /c1\s+codegen\s+3 attempts → still truncated · cash \$0\.0660/);
    assert.doesNotMatch(capped, /phase-1-requirements/, "a re-dispatch is not an output-cap retry");
    assert.match(text, /phase-1-requirements\s+dispatch 1 of 2\s+claude-opus-5\s+1 attempt\(s\) → failed · cash \$0\.5657/);
    assert.match(text, /phase-1-requirements\s+dispatch 2 of 2\s+claude-opus-5\s+1 attempt\(s\) → converged · cash \$0\.3453/);
    const notes = text.replace(/\n\s+/g, " ");
    assert.match(notes, /gemini workers: 3 of 3 attempt\(s\) failed, \$0\.0660 cash of the line's \$0\.0660, over 1 dispatch\(es\)\./);
    assert.match(notes, /claude worker: 1 of 2 attempt\(s\) failed, \$0\.5657 cash/);

    const md = report(dir, "--markdown");
    assert.match(md, /\| `c1` \| codegen \| 3 \| 8192 \| still truncated \| \$0\.0660 \|/);
    assert.match(md, /\| `phase-1-requirements` \| 1 of 2 \| claude-opus-5 \| 1 \| failed \| \$0\.5657 \|/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("events written before dispatch_id still split two dispatches of one packet", () => {
  const legacy = EVENTS.map(({ dispatch_id, hit_output_cap, terminal_reason, ...e }) => ({ ...e, ...(e.attempt_number > 1 ? { retry_reason: "output_cap" } : {}) }));
  const dir = runDir(legacy);
  try {
    const text = report(dir);
    assert.match(text, /phase-1-requirements\s+dispatch 2 of 2/);
    const capped = text.slice(text.indexOf("Packets that hit the output cap"), text.indexOf("Packets dispatched more than once"));
    assert.match(capped, /c1\s+codegen\s+3 attempts/);
    assert.doesNotMatch(capped, /phase-1-requirements/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
