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

import { buildHarnessManifest, costLines, claudeWallet, describeCostLines, geminiDoor, workerLineOf, HARNESS_NAME, RUNTIME_NAME } from "../../plugin/agy/manifest.mjs";

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

test("claudeWallet and geminiDoor read the fallback wallet from the environment, and say when it cannot decide", () => {
  assert.equal(claudeWallet({}).arm, null);
  assert.equal(claudeWallet({ ANTHROPIC_API_KEY: "k" }).wallet, "anthropic");
  const both = claudeWallet({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_VERTEX: "1" });
  assert.equal(both.arm, null, "no silent preference for Vertex");
  assert.equal(both.wallet, null);
  assert.match(both.note, /both set/);
  const policy = { select: { "gemini-flash": { default: "flash-completion" } } };
  assert.deepEqual(geminiDoor(policy, { GEMINI_API_KEY: "g" }), { leaf: "flash-completion", wallet: "gemini-api-key" });
  assert.deepEqual(geminiDoor(policy, { MMO_SELECT: "gemini-flash=flash-agsdk-worker", GEMINI_API_KEY: "g" }), { leaf: "flash-agsdk-worker", wallet: "gcp" });
  assert.deepEqual(geminiDoor(policy, {}), { leaf: "flash-completion", wallet: "gcp" });
  assert.deepEqual(geminiDoor(policy, { GEMINI_API_KEY: "g", GEMINI_BACKEND: "vertex" }), { leaf: "flash-completion", wallet: "gcp" }, "GEMINI_BACKEND beats the key, as in the bridge");
  assert.deepEqual(geminiDoor(policy, { GEMINI_BACKEND: "api-key" }), { leaf: "flash-completion", wallet: "gemini-api-key" });
});

const STAMP = {
  seat: { name: "claude-seat", source: "reported", arm: "seat", api_key_source: "none", api_provider: "firstParty" },
  keyA: { name: "anthropic", source: "reported", arm: "A", api_key_source: "ANTHROPIC_API_KEY" },
  geminiKey: { name: "gemini-api-key", source: "transport", backend: "api-key", location: "" },
  geminiVertex: { name: "gcp", source: "transport", backend: "vertex-adc", location: "global" },
};

/** A run directory whose telemetry carries the given events, and no policy snapshot (an interactive run). */
function stampedRunDir(events) {
  const dir = runDir();
  for (const f of ["policy_snapshot.yaml", "driver-manifest.json", "driver-cost-modeled.jsonl"]) rmSync(join(dir, f));
  writeFileSync(join(dir, "telemetry.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

const opusOn = (wallet, over = {}) => ev({ phase: "requirements_analysis", model: "claude-opus-5", model_id: "opus", adapter: "claude-agent-sdk", cost_usd: 0.05, wallet, ...over });
const flashOn = (wallet, over = {}) => ev({ model_id: "flash-completion", adapter: "mcp:model-dispatch", wallet, ...over });

test("stamped events give the same wallets and cost lines whatever the manifest writer's environment holds", () => {
  const dir = stampedRunDir([opusOn(STAMP.seat), flashOn(STAMP.geminiKey), flashOn(STAMP.geminiKey, { cost_usd: 0.002 })]);
  try {
    const build = (env, login) => buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: "r1", env, login, version: "1.2.3", now: () => "N" });
    const bare = build({}, null);
    const views = [
      build({ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, null),
      build({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p", GEMINI_BACKEND: "vertex" }, null),
      build({}, { loggedIn: true, method: "claude.ai", subscription: "max" }),
    ];
    for (const m of views) {
      assert.deepEqual(m.cost, bare.cost);
      assert.deepEqual([m.harness.arm, m.harness.provider_source, m.harness.cable], [bare.harness.arm, bare.harness.provider_source, bare.harness.cable]);
    }
    const byLine = Object.fromEntries(bare.cost.lines.map((l) => [l.line, l]));
    assert.equal(byLine.claude_worker.wallet, "claude-seat");
    assert.equal(byLine.claude_worker.kind, "modeled");
    assert.equal(byLine.claude_worker.wallet_source, "events");
    assert.equal(byLine.gemini_workers.wallet, "gemini-api-key");
    assert.equal(byLine.gemini_workers.wallet_source, "events");
    assert.equal(bare.cost.claude_seat_modeled_usd, 0.05);
    assert.equal(bare.cost.dispatched_cash_usd, 0.003125);
    assert.equal(bare.harness.arm, "seat");
    assert.equal(bare.harness.cable.summary, "antigravity-cli driver → model-dispatch bridge (claude-opus-5 via claude-agent-sdk, gemini-3.8-flash via mcp:model-dispatch)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("events without the stamp fall back to the manifest writer's environment, and the line says so", () => {
  const dir = runDir();
  try {
    const m = buildHarnessManifest({ runDir: dir, env: { ANTHROPIC_API_KEY: "k" } });
    const byLine = Object.fromEntries(m.cost.lines.map((l) => [l.line, l]));
    assert.equal(byLine.claude_worker.wallet, "anthropic");
    assert.equal(byLine.claude_worker.wallet_source, "env at manifest time");
    assert.equal(byLine.gemini_workers.wallet, "gcp");
    assert.equal(byLine.gemini_workers.wallet_source, "env at manifest time");
    assert.match(m.harness.cable.summary, /claude-opus-5 via adapter not recorded/);
    assert.doesNotMatch(m.harness.cable.summary, /claude -p/);

    const both = buildHarnessManifest({ runDir: dir, env: { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_VERTEX: "1" } });
    const claude = both.cost.lines.find((l) => l.line === "claude_worker");
    assert.equal(claude.wallet, null);
    assert.match(claude.wallet_note, /both set/);
    assert.equal(both.harness.arm, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const partly = stampedRunDir([flashOn(STAMP.geminiKey), ev({ model_id: "flash-completion" })]);
  try {
    const gemini = buildHarnessManifest({ runDir: partly, policyName: POLICY, runId: "r1", env: { GEMINI_API_KEY: "g" } }).cost.lines[1];
    assert.equal(gemini.wallet, "gemini-api-key");
    assert.equal(gemini.wallet_source, "events + env at manifest time");
  } finally { rmSync(partly, { recursive: true, force: true }); }
});

test("a worker whose events show more than one wallet is flagged, and only its seat share leaves the cash figure", () => {
  const dir = stampedRunDir([
    opusOn(STAMP.keyA, { cost_usd: 0.04 }),
    opusOn(STAMP.seat, { cost_usd: 0.05 }),
    flashOn(STAMP.geminiKey),
    ev({ model_id: "flash-agsdk-worker", adapter: "antigravity-worker", wallet: STAMP.geminiVertex, cost_usd: 0.002 }),
  ]);
  try {
    const m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: "r1", env: {} });
    const byLine = Object.fromEntries(m.cost.lines.map((l) => [l.line, l]));
    const claude = byLine.claude_worker;
    assert.equal(claude.wallet, "mixed");
    assert.equal(claude.arm, "mixed");
    assert.equal(claude.kind, "mixed");
    assert.deepEqual(claude.mixed_wallets, [{ worker: "opus", wallets: ["anthropic", "claude-seat"] }]);
    assert.deepEqual(claude.wallets.map((w) => [w.wallet, w.calls, w.cost_usd]), [["anthropic", 1, 0.04], ["claude-seat", 1, 0.05]]);
    assert.equal(m.cost.claude_seat_modeled_usd, 0.05);
    assert.equal(m.total_cost_usd, 0.093125);
    assert.equal(m.cost.dispatched_cash_usd, 0.043125, "the keyed Opus call and both Gemini calls");
    assert.equal(m.harness.arm, "mixed");
    assert.equal(m.harness.cable.claude_worker_auth, "mixed: Anthropic API key + claude.ai seat (OAuth) — not the metered API");

    const gemini = byLine.gemini_workers;
    assert.equal(gemini.wallet, "mixed", "two Gemini doors, one per leaf");
    assert.equal(gemini.mixed_wallets, undefined, "each leaf kept to one wallet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("costLines partitions bridge events by the policy's Claude-worker models", () => {
  const policy = { models: [{ adapter: "claude-agent-sdk", model_name: "claude-opus-5" }, { adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" }] };
  const lines = costLines({ dispatched: [ev({ model: "claude-opus-5", cost_usd: 1 }), ev({ cost_usd: 2 })], modeled: [], policy, pin: null, env: {} });
  assert.equal(lines.find((l) => l.line === "claude_worker").cost_usd, 1);
  assert.equal(lines.find((l) => l.line === "gemini_workers").cost_usd, 2);
  assert.equal(lines.find((l) => l.line === "driver").cost_usd, 0);
  assert.equal(lines.find((l) => l.line === "driver").kind, "unmeasured", "no driver record: the $0 is not a measurement");
  const withNone = costLines({ dispatched: [ev({ model: null, provenance: "none", cost_usd: 0 })], modeled: [], policy, pin: null, env: {} });
  assert.equal(withNone.find((l) => l.line === "gemini_workers").calls, 0, "a provenance:none receipt is not a worker call");
});

test("workerLineOf reads the event's adapter, then its leaf or model in the policy, then the model prefix", () => {
  const policy = { models: [{ id: "opus", adapter: "claude-agent-sdk", model_name: "claude-opus-5" }, { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" }] };
  assert.equal(workerLineOf({ model: "some-model", adapter: "claude-cli" }), "claude_worker");
  assert.equal(workerLineOf({ model: "claude-opus-5", adapter: "antigravity-worker" }), "gemini_workers", "the stamped adapter beats the name");
  assert.equal(workerLineOf({ model: "renamed", model_id: "opus" }, policy), "claude_worker");
  assert.equal(workerLineOf({ model: "gemini-3.8-flash" }, { models: [{ adapter: "claude-agent-sdk", model_name: "claude-opus-5" }] }), "gemini_workers", "an entry with no id never matches an event with no model_id");
  assert.equal(workerLineOf({ model: "claude-opus-5" }), "claude_worker", "no adapter, no policy: the name decides");
  assert.equal(workerLineOf({ model: "gemini-3.8-flash" }), "gemini_workers");
  assert.equal(workerLineOf({ model: "claude-opus-5", adapter: "builtin-anthropic" }), "unclassified", "not a Claude-worker wallet");
  assert.equal(workerLineOf({ model: "mystery-1" }), "unclassified");
});

test("an event no rule recognises goes on an unclassified line, never on Gemini's", () => {
  const lines = costLines({ dispatched: [ev({ model: "mystery-1", cost_usd: 3 }), ev({ cost_usd: 2 })], modeled: [], policy: null, pin: null, env: {} });
  assert.equal(lines.find((l) => l.line === "gemini_workers").cost_usd, 2);
  const unclassified = lines.find((l) => l.line === "unclassified");
  assert.equal(unclassified.cost_usd, 3);
  assert.deepEqual(unclassified.models, ["mystery-1"]);
  assert.match(unclassified.basis, /^UNCLASSIFIED/);
  assert.equal(costLines({ dispatched: [ev({})], modeled: [], policy: null, pin: null, env: {} }).length, 3, "the line is absent when every event is classified");
});

test("an interactive run with no policy snapshot still books Opus on the Claude line, and on the seat keeps it out of cash", () => {
  const dir = runDir();
  try {
    for (const f of ["policy_snapshot.yaml", "driver-manifest.json", "driver-cost-modeled.jsonl"]) rmSync(join(dir, f));
    const login = { loggedIn: true, method: "claude.ai", subscription: "max" };
    const m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: "r1", env: { GEMINI_API_KEY: "g" }, login });
    const byLine = Object.fromEntries(m.cost.lines.map((l) => [l.line, l]));
    assert.equal(byLine.claude_worker.cost_usd, 0.05);
    assert.deepEqual(byLine.claude_worker.models, ["claude-opus-5"]);
    assert.equal(byLine.gemini_workers.cost_usd, 0.003125);
    assert.deepEqual(byLine.gemini_workers.models, ["gemini-3.8-flash"]);
    assert.equal(byLine.unclassified, undefined);
    assert.equal(m.cost.claude_seat_modeled_usd, 0.05);
    assert.equal(m.cost.dispatched_cash_usd, 0.003125, "seat Opus is not cash");
    assert.equal(m.harness.pin, null, "no snapshot, no pin to assert");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an interactive run (no driver-manifest.json, no modeled lines) carries the driver as NOT MEASURED, never as a modeled $0", () => {
  const dir = runDir();
  try {
    rmSync(join(dir, "driver-manifest.json"));
    rmSync(join(dir, "driver-cost-modeled.jsonl"));
    const m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: "r1" });
    const driver = m.cost.lines.find((l) => l.line === "driver");
    assert.equal(driver.kind, "unmeasured");
    assert.equal(m.harness.driver_cost_usd, 0);
    assert.match(m.harness.driver_cost_basis, /NOT MEASURED/);
    assert.match(m.harness.driver_cost_basis, /unmeasured, never free/, "the studies console's wording for an unmeasured driver");
    assert.doesNotMatch(m.harness.driver_cost_basis, /MODELED/);
    assert.equal(m.cost.driver_measured, false);
    assert.equal(m.usage.driver.provenance, "unmeasured");
    const r = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Driver loop — not measured/);
    assert.match(r.stdout, /NOT MEASURED/);
    assert.doesNotMatch(r.stdout, /modeled, not measured/);
    const cli = spawnSync(process.execPath, [join(ROOT, "plugin", "agy", "manifest.mjs"), dir, `--policy=${POLICY}`, "--run-id=r1"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /· driver NOT MEASURED$/m, "the line the interactive conductor relays");
    assert.doesNotMatch(cli.stdout, /driver modeled/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a headless run whose record exists but reported no usage stays modeled, and names the missing invocation", () => {
  const dir = runDir();
  try {
    rmSync(join(dir, "driver-cost-modeled.jsonl"));
    const dm = JSON.parse(readFileSync(join(dir, "driver-manifest.json"), "utf8"));
    dm.driver_usage = { resume_check: { check: 16, state: "pending" }, reading: "per-invocation", cost_usd: 0, cost_usd_low: 0, cost_usd_high: 0, invocations: [], invocations_without_usage: [1] };
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify(dm));
    const m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: "r1" });
    assert.equal(m.cost.lines[0].kind, "modeled");
    assert.deepEqual(m.harness.driver_invocations_without_usage, [1]);
    assert.match(m.harness.driver_cost_basis, /invocation\(s\) 1 reported no usage/);
    const r = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No driver turns recorded/);
    assert.match(r.stdout, /invocation\(s\) 1 reported no usage/, "the notice prints even with no modeled turn");
    rmSync(join(dir, "telemetry.jsonl"));
    const bare = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(bare.status, 0, "a driver record with lost usage is still a run to report, not a preflight halt");
    assert.match(bare.stdout, /invocation\(s\) 1 reported no usage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    assert.match(r.stdout, /— gemini workers cash \$0\.003125 · claude worker (cash|modeled) \$0\.05 · driver modeled \$0\.001418$/m, "each line with its kind, workers first");
    assert.doesNotMatch(r.stdout, /dispatched cash/, "no figure that would read as the run's total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI prints driver NOT MEASURED for an interactive run, never a modeled $0", () => {
  const dir = runDir();
  try {
    rmSync(join(dir, "driver-manifest.json"));
    rmSync(join(dir, "driver-cost-modeled.jsonl"));
    const r = spawnSync(process.execPath, [join(ROOT, "plugin", "agy", "manifest.mjs"), dir, "--agy-version=1.2.3"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /· driver NOT MEASURED$/m);
    assert.doesNotMatch(r.stdout, /driver modeled/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("describeCostLines names each line's kind, puts the driver last and adds nothing up", () => {
  const lines = [
    { line: "driver", kind: "modeled", cost_usd: 0.004658, cost_usd_low: 0.003241 },
    { line: "gemini_workers", kind: "cash", cost_usd: 0.6 },
    { line: "claude_worker", kind: "modeled", cost_usd: 5.6 },
    { line: "unclassified", kind: "cash", cost_usd: 0.1 },
  ];
  assert.equal(describeCostLines(lines), "gemini workers cash $0.6 · claude worker modeled $5.6 · unclassified cash $0.1 · driver modeled $0.004658 (range $0.003241–$0.004658)");
  assert.equal(describeCostLines([{ line: "driver", kind: "unmeasured", cost_usd: 0 }]), "driver NOT MEASURED");
});

test("an injected wallet decides the Claude line's kind over the environment", () => {
  const seat = claudeWallet({}, { loggedIn: true, method: "claude.ai", subscription: "max" });
  const lines = costLines({ dispatched: [ev({ model: "claude-opus-5", cost_usd: 1 })], modeled: [], policy: null, pin: null, env: { ANTHROPIC_API_KEY: "k" }, wallet: seat });
  assert.equal(lines.find((l) => l.line === "claude_worker").kind, "modeled");
  const dir = runDir();
  try {
    const m = buildHarnessManifest({ runDir: dir, env: { ANTHROPIC_API_KEY: "k" }, wallet: seat });
    assert.equal(m.harness.arm, "seat");
    assert.equal(m.cost.claude_seat_modeled_usd, 0.05);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools/report.mjs reads the same run directory and keeps the modeled line apart", () => {
  const dir = runDir();
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /driver\s+modeled\s+1\s+.*\$0\.0014/);
    assert.match(r.stdout, /Modeled cost\s+\$0\.0014/);
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

test("the driver line names the dated period it was priced at, and the harness block carries the model and reading checks", () => {
  const dir = runDir();
  try {
    const modeled = JSON.parse(readFileSync(join(dir, "driver-cost-modeled.jsonl"), "utf8"));
    writeFileSync(join(dir, "driver-cost-modeled.jsonl"), JSON.stringify({ ...modeled, price_basis: "list", price_period: { from: "2026-09-02", to: "2026-12-31" } }) + "\n");
    const dm = JSON.parse(readFileSync(join(dir, "driver-manifest.json"), "utf8"));
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({
      ...dm, driver_reported_models: ["gemini-3.1-pro-high"], driver_model_mismatch: ["gemini-3.1-pro-high"],
      driver_usage: { token_readings: { "cache-apart+thinking-apart (no_total)": 1 }, results_with_unproven_reading: 1, invocations: [], invocations_without_usage: [] },
    }));
    const m = buildHarnessManifest({ runDir: dir, env: {}, now: () => "N" });
    assert.match(m.cost.lines[0].basis, /dated price list for gemini-3\.8-flash \(period 2026-09-02\.\.2026-12-31\)/);
    assert.deepEqual(m.harness.driver_model_mismatch, ["gemini-3.1-pro-high"]);
    assert.equal(m.harness.driver_results_with_unproven_reading, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a directory shared by two runs books only this run's events and this run's launcher record", () => {
  const dir = runDir();
  try {
    const other = (over) => JSON.stringify(ev({ pass: "r0", cost_usd: 40, ...over }));
    writeFileSync(join(dir, "telemetry.jsonl"), readFileSync(join(dir, "telemetry.jsonl"), "utf8") + other({}) + "\n" + other({ model: "claude-opus-5", phase: "security_review" }) + "\n");
    writeFileSync(join(dir, "driver-cost-modeled.jsonl"), readFileSync(join(dir, "driver-cost-modeled.jsonl"), "utf8") + JSON.stringify({ pass: "r0", tier: "orchestrator", provenance: "modeled", cost_usd: 9, input_tokens: 1, input_tokens_cached: 0, output_tokens: 1 }) + "\n");
    const m = buildHarnessManifest({ runDir: dir, runId: "r1", env: { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, now: () => "N" });
    assert.equal(m.total_cost_usd, 0.053125, "run r0's $80 is not in r1's figure");
    assert.equal(m.cost.driver_modeled_usd, 0.001418, "run r0's driver turn is not in r1's driver line");
    assert.deepEqual(m.harness.other_runs_in_directory, ["r0"]);

    const r0 = buildHarnessManifest({ runDir: dir, runId: "r0", env: { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, now: () => "N" });
    assert.equal(r0.total_cost_usd, 80);
    assert.equal(r0.harness.agy_invocations, null, "r1's launcher record is not r0's");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
