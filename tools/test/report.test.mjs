/**
 * tools/report.mjs prints the manifest's labelled cost lines — computed by
 * the same code — with a cash figure that never takes in a modeled dollar,
 * and one named row per phase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");
const POLICY = "antigravity-flash38-plus-opus5";
const SEAT = { loggedIn: true, method: "claude.ai", subscription: "max" };

const ev = (over) => ({
  ts: "2026-09-16T10:00:00.000Z", pass: "r1", phase: "codegen", task_type: "dto", task_id: "t", module: "m",
  model: "gemini-3.8-flash", adapter: "mcp:model-dispatch", routed_by: "orchestrator", provenance: "vendor",
  routing: { policy_name: POLICY, policy_version: 1, rule_index: 0, rule_reason: "x" },
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.001125, latency_ms: 10, success: true, retry_count: 0,
  ...over,
});

const OPUS = { phase: "requirements_analysis", task_type: "requirements", model: "claude-opus-5", adapter: "claude-agent-sdk", cost_usd: 0.05 };

/** A run directory with a code-written manifest.json recording the wallet the run ended on. */
function runDir(events, { env = {}, login = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agy-report-"));
  copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(dir, "policy_snapshot.yaml"));
  writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const m = buildHarnessManifest({ runDir: dir, runId: "r1", env, login });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  return dir;
}

const report = (dir, ...flags) => {
  const r = spawnSync(process.execPath, [REPORT, dir, ...flags], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "shell-key" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("on a seat run the report prints separate lines, a cash figure without the Opus line, and no blended total", () => {
  const dir = runDir([ev(OPUS), ev({}), ev({ phase: "tests", task_type: "unit", cost_usd: 0.002 })], { env: { GEMINI_API_KEY: "g" }, login: SEAT });
  try {
    const text = report(dir);
    assert.match(text, /gemini workers\s+cash\s+2\s+.*\$0\.0031/);
    assert.match(text, /claude worker\s+modeled\s+1\s+.*\$0\.0500/);
    assert.match(text, /driver\s+NOT MEASURED/);
    assert.match(text, /Cash\s+\$0\.0031\n/, "the seat's Opus dollars stay out of cash");
    assert.match(text, /Claude wallet: claude-seat \(arm seat\), recorded in manifest\.json/, "the recorded wallet beats the shell's key");
    assert.doesNotMatch(text, /\$0\.0531/, "0.05 + 0.003125 appears nowhere");
    assert.doesNotMatch(text, /Vendor-metered total|SDLC total|Runner overhead/);
    assert.match(text, /requirements_analysis\s+V\s+1\s+.*\$0\.0000\s+\$0\.0500/, "the phase table splits cash from modeled");

    const md = report(dir, "--markdown");
    assert.match(md, /\| claude worker \| \*\*modeled\*\* \| 1 \|/);
    assert.match(md, /\| \*\*Cash\*\* \| \| \| \| \*\*\$0\.0031\*\* \|/);
    assert.match(md, /\| Phase \| Prov \| Calls \| Tokens \(in \/ out\) \| Cash \| Modeled \|/);
    assert.doesNotMatch(md, /\$0\.0531/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("on a metered arm the Claude line is cash and the cash figure takes it in", () => {
  const dir = runDir([ev(OPUS), ev({})], { env: { ANTHROPIC_API_KEY: "k" } });
  try {
    const text = report(dir);
    assert.match(text, /claude worker\s+cash\s+1/);
    assert.match(text, /Cash\s+\$0\.0511\n/);
    assert.doesNotMatch(text, /Cash\s+Modeled/, "no modeled column when no worker line is modeled");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a tier:orchestrator event in telemetry.jsonl stays out of every sum", () => {
  const conductor = ev({ phase: "codegen", tier: "orchestrator", provenance: "modeled", model: "gemini-3.8-flash", input_tokens: 90000, output_tokens: 9000, cost_usd: 9.99 });
  const dir = runDir([ev({}), conductor], { env: { ANTHROPIC_API_KEY: "k" } });
  try {
    const text = report(dir);
    assert.match(text, /^\s+codegen\s+V\s+1\s+1\.0K \/ 100\s+\$0\.0011/m, "one codegen call, the vendor one");
    assert.match(text, /gemini workers\s+cash\s+1\s/);
    assert.match(text, /Cash\s+\$0\.0011\n/);
    assert.doesNotMatch(text, /\$9\.99|\$10\./);
    assert.match(text, /1 tier:"orchestrator" event\(s\)/);
    assert.match(text, /Dispatched events: 1 vendor\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a phase outside the greenfield list gets its own named row", () => {
  const dir = runDir([ev({}), ev({ phase: "flow_tests", task_type: "e2e", cost_usd: 0.004 }), ev({ phase: "discovery", task_type: "scan", cost_usd: 0.003 })], { env: { ANTHROPIC_API_KEY: "k" } });
  try {
    const text = report(dir);
    assert.match(text, /^\s+flow_tests\s+V\s+1\s+.*\$0\.0040/m);
    assert.match(text, /^\s+discovery\s+V\s+1\s+.*\$0\.0030/m);
    assert.ok(text.indexOf("discovery") < text.indexOf("codegen") && text.indexOf("codegen") < text.indexOf("flow_tests"), "state-machine order");
    assert.match(text, /All phases\s+3\s/);
    assert.doesNotMatch(text, /Runner overhead/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a manifest.json that books the lines differently is named, with the command that rebuilds it", () => {
  const dir = runDir([ev(OPUS), ev({})], { login: SEAT });
  try {
    assert.doesNotMatch(report(dir), /books these lines differently/);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.cost.lines.find((l) => l.line === "gemini_workers").cost_usd = 0.051125;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    const text = report(dir);
    assert.match(text, /manifest\.json books these lines differently/);
    assert.match(text, /node plugin\/agy\/manifest\.mjs '/);
    assert.match(text, /gemini workers\s+cash\s+1\s+.*\$0\.0011/, "the report books from telemetry, not from the stale file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("packets the policy default routed are listed with their kind of dollar", () => {
  const fallback = { routing: { policy_name: POLICY, policy_version: 1, rule_index: -1, rule_reason: "Unrecognized task — fail safe to premium", fallback: true } };
  const dir = runDir([ev({}), ev({ ...OPUS, phase: "codegen", task_type: "code_fix", task_id: "tp_fix", model_id: "opus", cost_usd: 0.25, ...fallback })], { env: { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" } });
  try {
    const text = report(dir);
    assert.match(text, /Packets no policy rule matched \(sent to the policy default\): cash \$0\.2500/);
    assert.match(text, /tp_fix\s+codegen\s+code_fix\s+opus → cash \$0\.2500/);
    const md = report(dir, "--markdown");
    assert.match(md, /\| `tp_fix` \| codegen \| code_fix \| opus \| 1 \| cash \$0\.2500 \|/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run with no fallback packet prints no fallback section", () => {
  const dir = runDir([ev({})], { env: { GEMINI_API_KEY: "g" } });
  try {
    assert.doesNotMatch(report(dir), /no policy rule matched/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
