/**
 * The fields the studies console reads from an Antigravity manifest
 * (plugin/agy/telemetry/consoleFields.mjs): harness.worker_cost_usd split into
 * cash and modeled, harness.driver_work, and the cable's display strings.
 * Each must agree with cost.lines and never add one kind of dollar to another.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";
import { WORKER_SDK, workerCostSplit } from "../../plugin/agy/telemetry/consoleFields.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = "antigravity-flash38-plus-opus5";

const ev = (over) => ({
  ts: "2026-09-16T10:00:00.000Z", pass: "r1", phase: "codegen", task_type: "dto", task_id: "t", module: "m",
  model: "gemini-3.8-flash", model_id: "flash-completion", adapter: "mcp:model-dispatch", routed_by: "orchestrator", provenance: "vendor",
  routing: { policy_name: POLICY, policy_version: 1, rule_index: 0, rule_reason: "x" },
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.001, latency_ms: 10, success: true, retry_count: 0,
  wallet: { name: "gemini-api-key", source: "transport" },
  ...over,
});
const opus = (wallet, cost_usd) => ev({ phase: "requirements_analysis", model: "claude-opus-5", model_id: "opus", adapter: "claude-agent-sdk", cost_usd, wallet });
const KEY_A = { name: "anthropic", source: "reported", arm: "A" };
const SEAT = { name: "claude-seat", source: "reported", arm: "seat" };

function runDir(events, { driverTurns = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "console-fields-"));
  copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(dir, "policy_snapshot.yaml"));
  writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (driverTurns) {
    const turn = (n) => JSON.stringify({ pass: "r1", tier: "orchestrator", provenance: "modeled", model: "gemini-3.8-flash", input_tokens: 600, input_tokens_cached: 400, output_tokens: 250, output_tokens_reasoning: 50, cost_usd: 0.0014 * n });
    writeFileSync(join(dir, "driver-cost-modeled.jsonl"), [turn(1), turn(2)].join("\n") + "\n");
  }
  return dir;
}

const build = (dir) => buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: "r1", env: {}, version: "1.3.0", now: () => "N" });

// The cable keys apps/dashboard/src/lib/types.ts declares as required strings.
const CONSOLE_CABLE_STRINGS = ["driver_runtime", "driver_display", "worker_sdk", "worker_sdk_label", "worker_display", "worker_transport", "summary", "handoff_note", "driver_cost_note", "billing_note"];

const cashOf = (lines) => lines.filter((l) => l.line !== "driver").reduce((s, l) => s + (l.kind === "modeled" ? 0 : l.cost_usd - (l.seat_modeled_usd ?? 0)), 0);

test("worker_cost_usd is the cash worker lines of cost.lines, and the cable carries every display string the console reads", () => {
  const dir = runDir([opus(KEY_A, 0.05), ev({}), ev({ cost_usd: 0.002 })]);
  try {
    const m = build(dir);
    const h = m.harness;
    assert.equal(h.worker_cost_usd, Math.round(cashOf(m.cost.lines) * 1e6) / 1e6);
    assert.equal(h.worker_cost_usd, m.cost.dispatched_cash_usd);
    assert.equal(h.worker_cost_usd_modeled, 0);
    assert.match(h.worker_cost_basis, /^CASH: gemini workers \$0\.003 \+ claude worker \$0\.05/);
    for (const key of CONSOLE_CABLE_STRINGS) assert.ok(typeof h.cable[key] === "string" && h.cable[key].length, `cable.${key}`);
    assert.deepEqual(h.cable.driver_models, ["gemini-3.8-flash"]);
    assert.equal(h.cable.worker_sdk, WORKER_SDK);
    assert.match(h.cable.driver_display, /^antigravity-cli 1\.3\.0 · gemini-3\.8-flash \(high\) · Google seat/);
    assert.match(h.cable.worker_display, /claude-opus-5 via claude-agent-sdk, gemini-3\.8-flash via mcp:model-dispatch/);
    assert.equal(h.cable.worker_transport, "Gemini: Gemini API key · Claude: Anthropic API key");
    assert.match(h.cable.driver_cost_note, /MODELED, not invoiced/);
    assert.equal(h.driver_cost_usd, m.cost.lines[0].cost_usd);
    assert.deepEqual(Object.keys(h).filter((k) => /total/.test(k)), [], "no figure that adds the driver to the workers");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("driver_work reads the driver line in the console's units: the whole prompt as input, cache reads as its slice", () => {
  const dir = runDir([ev({})]);
  try {
    const m = build(dir);
    const driver = m.cost.lines.find((l) => l.line === "driver");
    assert.deepEqual({ ...m.harness.driver_work, what_it_spent_on: undefined }, {
      turns: 2, input_tokens: 2000, input_tokens_cached: 800, output_tokens: 500, thinking_tokens: 100, what_it_spent_on: undefined,
    });
    assert.equal(m.harness.driver_work.input_tokens, driver.input_tokens + driver.input_tokens_cached);
    assert.equal(m.harness.driver_work.output_tokens, driver.output_tokens, "thinking is already inside the billed output");
    assert.match(m.harness.driver_work.what_it_spent_on, /^orchestration/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("seat-modeled Claude dollars stay out of worker_cost_usd and go to worker_cost_usd_modeled", () => {
  const dir = runDir([opus(SEAT, 0.05), opus(KEY_A, 0.04), ev({})]);
  try {
    const m = build(dir);
    assert.equal(m.cost.lines.find((l) => l.line === "claude_worker").kind, "mixed");
    assert.equal(m.harness.worker_cost_usd, 0.041, "the keyed Opus call and the Gemini call");
    assert.equal(m.harness.worker_cost_usd_modeled, 0.05);
    assert.equal(m.harness.worker_cost_usd_modeled, m.cost.claude_seat_modeled_usd);
    assert.match(m.harness.worker_cost_basis, /\$0\.05, are MODELED .* not here/);
    assert.deepEqual(workerCostSplit(m.cost.lines), { cash_usd: 0.041, modeled_usd: 0.05 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const seatOnly = runDir([opus(SEAT, 0.05), ev({})]);
  try {
    const m = build(seatOnly);
    assert.deepEqual([m.harness.worker_cost_usd, m.harness.worker_cost_usd_modeled], [0.001, 0.05]);
  } finally { rmSync(seatOnly, { recursive: true, force: true }); }
});

test("an unmeasured driver writes no driver_work and says its $0 is not free", () => {
  const dir = runDir([ev({})], { driverTurns: false });
  try {
    const m = build(dir);
    assert.equal(m.harness.driver_work, undefined, "the console shows driver_work only once a run records driver usage");
    assert.equal(m.harness.driver_cost_usd, 0);
    assert.match(m.harness.driver_cost_basis, /^NOT MEASURED/);
    assert.match(m.harness.cable.driver_cost_note, /unmeasured, not free/);
    assert.match(m.harness.cable.billing_note, /not measured/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
