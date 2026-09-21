/**
 * The code-written manifest.json (plugin/agy/manifest.mjs): the bridge's
 * buildManifest shape plus the harness block the console and the store read,
 * with the three cost lines labeled and never summed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHarnessManifest, costLines, claudeWallet, geminiDoor, HARNESS_NAME, RUNTIME_NAME } from "../../plugin/agy/manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = "antigravity-flash38-plus-opus5";

const ev = (over) => ({
  ts: "2026-09-16T10:00:00.000Z", pass: "r1", phase: "codegen", task_type: "dto", task_id: "t", module: "m",
  model: "gemini-3.8-flash", routed_by: "orchestrator", provenance: "vendor",
  routing: { policy_name: POLICY, policy_version: 1, rule_index: 0, rule_reason: "x" },
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.001125, latency_ms: 10, success: true, retry_count: 0,
  ...over,
});

function runDir() {
  const dir = mkdtempSync(join(tmpdir(), "agy-manifest-"));
  copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(dir, "policy_snapshot.yaml"));
  writeFileSync(join(dir, "telemetry.jsonl"), [
    ev({ phase: "requirements_analysis", task_type: "requirements", model: "claude-opus-5", cost_usd: 0.05, cli_reported_cost_usd: 0.049, ts: "2026-09-16T09:00:00.000Z" }),
    ev({}),
    ev({ ts: "2026-09-16T11:00:00.000Z", phase: "tests", task_type: "unit", cost_usd: 0.002 }),
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "driver-cost-modeled.jsonl"), JSON.stringify({
    ts: "T", pass: "r1", phase: "driver_loop", task_type: "conductor", task_id: "driver-turn-1", module: "driver", model: "gemini-3.8-flash",
    tier: "orchestrator", provenance: "modeled", routed_by: "manual", routing: { policy_name: POLICY, policy_version: 1, rule_index: -1, rule_reason: "x" },
    input_tokens: 600, input_tokens_cached: 400, output_tokens: 250, output_tokens_reasoning: 50, cost_usd: 0.001418, latency_ms: null, success: true, retry_count: 0,
  }) + "\n");
  writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({
    harness: "antigravity", run_id: "r1", policy: POLICY, gates: "auto-approve",
    pin: { model: "gemini-3.8-flash", effort: "high", slug: "gemini-3.8-flash-high", billing_mode: "seat", verified: false, pending_checks: [1, 2, 4, 5, 6] },
    started_at: "2026-09-16T08:59:00.000Z", ended_at: "2026-09-16T11:30:00.000Z", agy_exit_status: 0, driver_turns: 1, agy_invocations: 1, completed: true,
    driver_cost_usd_modeled: 0.001418, pin_rejection: null, events_captured: 3, inline_env: false, agy_version: "1.2.3",
  }));
  return dir;
}

test("buildHarnessManifest keeps the bridge's shape and adds the harness block", () => {
  const dir = runDir();
  try {
    const m = buildHarnessManifest({ runDir: dir, env: { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, now: () => "N" });
    assert.equal(m.pass, "r1");
    assert.equal(m.policy_name, POLICY);
    assert.equal(m.total_cost_usd, 0.053125, "dispatched cash only");
    assert.ok(m.phase_breakdown.codegen && m.model_breakdown["claude-opus-5"]);
    assert.equal(m.started_at, "2026-09-16T08:59:00.000Z", "the launcher's window wins over the first event");
    assert.equal(m.harness.name, HARNESS_NAME);
    assert.equal(m.harness.runtime.name, RUNTIME_NAME);
    assert.equal(m.harness.runtime.version, "1.2.3");
    assert.equal(m.harness.auth_mode, "vendor");
    assert.equal(m.harness.arm, "A");
    assert.equal(m.harness.provider_source.claude, "anthropic-api");
    assert.equal(m.harness.provider_source.driver, "google-seat");
    assert.deepEqual(m.harness.cable.driver_models, ["gemini-3.8-flash"]);
    assert.deepEqual(m.harness.cable.worker_models.sort(), ["claude-opus-5", "gemini-3.8-flash"]);
    assert.equal(m.harness.pin.slug, "gemini-3.8-flash-high");
    assert.equal(m.harness.pin.verified, false);
    assert.equal(m.harness.completed, true);
    assert.equal(m.harness.gates, "auto-approve");
    assert.match(m.harness.driver_cost_basis, /^MODELED/, "the console keys its caption on this prefix");
    assert.equal(m.harness.driver_cost_usd, 0.001418);
    assert.equal(m.harness.written_by, "plugin/agy/manifest.mjs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the three cost lines are labeled by kind and never summed", () => {
  const dir = runDir();
  try {
    const m = buildHarnessManifest({ runDir: dir, env: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "proj", CLOUD_ML_REGION: "global", GEMINI_API_KEY: "g" } });
    const byLine = Object.fromEntries(m.cost.lines.map((l) => [l.line, l]));
    assert.equal(byLine.driver.kind, "modeled");
    assert.equal(byLine.driver.cost_usd, 0.001418);
    assert.equal(byLine.driver.thinking_tokens, 50);
    assert.equal(byLine.gemini_workers.kind, "cash");
    assert.equal(byLine.gemini_workers.cost_usd, 0.003125);
    assert.equal(byLine.gemini_workers.wallet, "gemini-api-key");
    assert.equal(byLine.claude_worker.kind, "cash");
    assert.equal(byLine.claude_worker.wallet, "gcp");
    assert.equal(byLine.claude_worker.arm, "B");
    assert.equal(byLine.claude_worker.cost_usd, 0.05);
    assert.equal(byLine.claude_worker.cli_reported_cost_usd, 0.049, "the CLI's own figure is kept as a check, not the figure of record");
    assert.equal(m.cost.dispatched_cash_usd, 0.053125);
    assert.equal(m.cost.driver_modeled_usd, 0.001418);
    assert.ok(!("total_cost_usd" in m.cost), "no blended total");
    assert.match(m.cost.note, /not summed/);
    assert.equal(m.usage.driver.provenance, "modeled");
    assert.equal(m.harness.cable.claude_worker_auth, "Vertex on GCP project proj (global)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claudeWallet and geminiDoor read the arm and the door from the environment", () => {
  assert.equal(claudeWallet({}).arm, null);
  assert.equal(claudeWallet({ ANTHROPIC_API_KEY: "k" }).wallet, "anthropic");
  assert.equal(claudeWallet({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_VERTEX: "1" }).arm, "B", "Vertex wins when both are set; verify-setup refuses that state before a run");
  const policy = { select: { "gemini-flash": { default: "flash-completion" } } };
  assert.deepEqual(geminiDoor(policy, { GEMINI_API_KEY: "g" }), { leaf: "flash-completion", wallet: "gemini-api-key" });
  assert.deepEqual(geminiDoor(policy, { MMO_SELECT: "gemini-flash=flash-agsdk-worker", GEMINI_API_KEY: "g" }), { leaf: "flash-agsdk-worker", wallet: "gcp" });
  assert.deepEqual(geminiDoor(policy, {}), { leaf: "flash-completion", wallet: "gcp" });
});

test("costLines partitions bridge events by the policy's claude-cli models", () => {
  const policy = { models: [{ adapter: "claude-cli", model_name: "claude-opus-5" }, { adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" }] };
  const lines = costLines({ dispatched: [ev({ model: "claude-opus-5", cost_usd: 1 }), ev({ cost_usd: 2 })], modeled: [], policy, pin: null, env: {} });
  assert.equal(lines.find((l) => l.line === "claude_worker").cost_usd, 1);
  assert.equal(lines.find((l) => l.line === "gemini_workers").cost_usd, 2);
  assert.equal(lines.find((l) => l.line === "driver").cost_usd, 0);
  const withNone = costLines({ dispatched: [ev({ model: null, provenance: "none", cost_usd: 0 })], modeled: [], policy, pin: null, env: {} });
  assert.equal(withNone.find((l) => l.line === "gemini_workers").calls, 0, "a provenance:none receipt is not a worker call");
});

test("a run with no telemetry at all still yields a manifest, with empty dispatched sums", () => {
  const dir = runDir();
  try {
    rmSync(join(dir, "telemetry.jsonl"));
    const m = buildHarnessManifest({ runDir: dir });
    assert.equal(m.total_cost_usd, 0);
    assert.equal(m.cost.driver_modeled_usd, 0.001418);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with no run id anywhere the manifest refuses rather than inventing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-manifest-empty-"));
  try {
    assert.throws(() => buildHarnessManifest({ runDir: dir }), /no run id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI writes manifest.json into the run directory", () => {
  const dir = runDir();
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "plugin", "agy", "manifest.mjs"), dir, "--agy-version=1.2.3"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, "manifest.json")));
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(m.harness.runtime.name, RUNTIME_NAME);
    assert.match(r.stdout, /driver modeled \$0\.001418/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools/report.mjs reads the same run directory and keeps the modeled line apart", () => {
  const dir = runDir();
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /modeled/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("on the seat the Claude line is modeled, leaves the cash figure, and the cable names the seat", () => {
  const dir = runDir();
  try {
    const login = { loggedIn: true, method: "claude.ai", subscription: "max" };
    const m = buildHarnessManifest({ runDir: dir, env: { GEMINI_API_KEY: "g" }, login });
    const byLine = Object.fromEntries(m.cost.lines.map((l) => [l.line, l]));
    assert.equal(byLine.claude_worker.kind, "modeled");
    assert.equal(byLine.claude_worker.wallet, "claude-seat");
    assert.match(byLine.claude_worker.basis, /^MODELED/);
    assert.equal(m.cost.claude_seat_modeled_usd, 0.05);
    assert.equal(m.cost.dispatched_cash_usd, 0.003125, "only the Gemini calls are cash on the seat");
    assert.equal(m.harness.arm, "seat");
    assert.equal(m.harness.provider_source.claude, "claude-seat");
    assert.match(m.harness.cable.claude_worker_auth, /claude\.ai max seat/);
    assert.equal(claudeWallet({}, login).arm, "seat");
    assert.equal(claudeWallet({ ANTHROPIC_API_KEY: "k" }, login).arm, "A");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
