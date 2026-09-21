/**
 * The agy driver's telemetry pieces: the stream-json reader, the pin read
 * off the policy's driver block, and the per-run root that inlines env for
 * the check-5 fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { parseEventStream, extractTurnUsage, modeledDriverCostEvents, conversationIdFrom, extractToolCalls } from "../../plugin/agy/telemetry/event-reader.mjs";
import { readPin, driverSlug, assertPinnedInvocation, findPinRejection, pendingPinChecks, LIVE_PIN_CHECKS } from "../../plugin/agy/telemetry/fairnessPin.mjs";
import { inlineMcpConfig, materialiseRunRoot, removeRunRoot, defaultRunRoot, LINKED_PLUGIN_DIRS } from "../../plugin/agy/runRoot.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(ROOT, "plugin");
const policy = (name) => parseYaml(readFileSync(join(PLUGIN, "config", "policies", `${name}.yaml`), "utf8"));

const usage = (i, o, t, c) => ({ input_tokens: i, output_tokens: o, thinking_tokens: t, cache_read_tokens: c, total_tokens: i + o + t });
const result = (conv, u, extra = {}) => JSON.stringify({ event: "result", result: { conversation_id: conv, status: "OK", response: "", num_turns: 1, usage: u, ...extra } });

// ── event reader ──────────────────────────────────────────────────────────

test("parseEventStream keeps every well-formed line, stamps a clock, and skips junk", () => {
  const text = ['{"event":"init","conversation_id":"c1"}', "not json", "", result("c1", usage(10, 2, 0, 0))].join("\n");
  const events = parseEventStream(text, () => "T");
  assert.equal(events.length, 2);
  assert.equal(events[0].ts, "T");
  assert.equal(events[0].event, "init");
});

test("the observed auth-failure envelope parses and yields one zero-usage turn", () => {
  const observed = '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}';
  const events = parseEventStream(observed);
  const turns = extractTurnUsage(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].usage.total_tokens, 0);
  assert.equal(conversationIdFrom(events), null, "an empty conversation id is not an id");
});

test("extractTurnUsage differences cumulative results of the same conversation (check 8)", () => {
  const text = [result("c1", usage(1000, 100, 10, 200)), result("c1", usage(2500, 300, 30, 900))].join("\n");
  const turns = extractTurnUsage(parseEventStream(text));
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].usage, { input_tokens: 1500, output_tokens: 200, thinking_tokens: 20, cache_read_tokens: 700, total_tokens: 1720 });
});

test("a result for a different conversation starts a fresh baseline", () => {
  const text = [result("c1", usage(1000, 100, 0, 0)), result("c2", usage(500, 50, 0, 0))].join("\n");
  const turns = extractTurnUsage(parseEventStream(text));
  assert.equal(turns[1].usage.input_tokens, 500);
});

test("modeledDriverCostEvents prices at the driver card: thinking at output, cache reads at cached", () => {
  const pricing = { input: 0.75, input_cached: 0.075, output: 3.75 };
  const [e] = modeledDriverCostEvents(parseEventStream(result("c1", usage(1000, 200, 50, 400))), { pass: "r", model: "gemini-3.8-flash", pricing, policyName: "p" });
  assert.equal(e.input_tokens, 600);
  assert.equal(e.input_tokens_cached, 400);
  assert.equal(e.output_tokens, 250);
  assert.equal(e.cost_usd, Math.round(((600 * 0.75 + 400 * 0.075 + 250 * 3.75) / 1e6) * 1e6) / 1e6);
  assert.equal(e.provenance, "modeled");
  assert.equal(e.tier, "orchestrator");
  assert.equal(e.routing.policy_name, "p");
  assert.equal(e.task_id, "driver-turn-1");
});

test("conversationIdFrom reads init first, then result", () => {
  assert.equal(conversationIdFrom(parseEventStream('{"event":"init","conversation_id":"abc"}')), "abc");
  assert.equal(conversationIdFrom(parseEventStream(result("xyz", usage(1, 1, 0, 0)))), "xyz");
});

test("extractToolCalls tolerates the step shapes it may see", () => {
  const text = [
    '{"event":"step_update","step":{"tool_call":{"name":"run_command"},"step_idx":1}}',
    '{"event":"step_update","step":{"toolCall":{"name":"mcp_tool"},"stepIdx":2}}',
    '{"event":"step_update","step":{"type":"finish"}}',
  ].join("\n");
  assert.deepEqual(extractToolCalls(parseEventStream(text, () => "T")).map((c) => c.name), ["run_command", "mcp_tool", "finish"]);
});

// ── fairness pin ──────────────────────────────────────────────────────────

test("readPin reads the pin off the shipped policies' driver block and derives the slug", () => {
  for (const name of ["antigravity-flash38-plus-opus5"]) {
    const pin = readPin(policy(name));
    assert.equal(driverSlug(pin), "gemini-3.8-flash-high");
    assert.equal(pin.billing_mode, "seat");
    assert.equal(typeof pin.pricing.output, "number");
  }
});

test("readPin refuses a policy without a driver block, or with a bad effort or billing mode", () => {
  assert.throws(() => readPin({ name: "x" }), /no top-level driver: block/);
  assert.throws(() => readPin({ name: "x", driver: { runtime: "codex", model_name: "m", reasoning: { effort: "high" } } }), /not 'agy'/);
  assert.throws(() => readPin({ name: "x", driver: { runtime: "agy", model_name: "m", reasoning: { effort: "max" }, pricing: {} } }), /effort 'max'/);
  assert.throws(() => readPin({ name: "x", driver: { runtime: "agy", model_name: "m", reasoning: { effort: "high" }, billing_mode: "card", pricing: {} } }), /billing_mode/);
  assert.throws(() => readPin({ name: "x", driver: { runtime: "agy", model_name: "m", reasoning: { effort: "high" } } }), /pricing\.input/);
});

test("assertPinnedInvocation aborts on a drifted slug", () => {
  const p = policy("antigravity-flash38-plus-opus5");
  assert.equal(assertPinnedInvocation({ model: "gemini-3.8-flash-high" }, p).model, "gemini-3.8-flash");
  assert.throws(() => assertPinnedInvocation({ model: "gemini-3.1-pro-high" }, p), /fairness pin violated/);
});

test("findPinRejection reads a model rejection out of result.error and ignores unrelated errors", () => {
  assert.match(findPinRejection(parseEventStream(result("", usage(0, 0, 0, 0), { status: "ERROR", error: "unknown model: gemini-9" }))), /unknown model/);
  assert.equal(findPinRejection(parseEventStream(result("", usage(0, 0, 0, 0), { status: "ERROR", error: "authentication failed or timed out" }))), null);
  assert.equal(findPinRejection(parseEventStream(result("c", usage(1, 1, 0, 0)))), null);
});

test("the headless pin checks are recorded as passed in the verification doc, row for row", () => {
  assert.deepEqual(Object.keys(LIVE_PIN_CHECKS).map(Number), [2, 4, 6, 10]);
  assert.deepEqual(pendingPinChecks({ 1: "pass", 2: "pending" }), [2]);
  assert.deepEqual(pendingPinChecks(), [], "the headless path is live-verified; run.mjs no longer needs --allow-unverified-pin");
  const doc = readFileSync(join(ROOT, "docs", "verification", "p1-agy-runtime.md"), "utf8");
  for (const [n, state] of Object.entries(LIVE_PIN_CHECKS)) {
    const row = doc.split("\n").find((l) => l.startsWith(`| ${n} |`));
    assert.ok(row, `check ${n} has a row`);
    if (state === "pass") assert.ok(/\*\*PASS/.test(row), `check ${n} passes in code but the doc row does not say PASS`);
  }
});

// ── per-run root (check 5 fallback) ───────────────────────────────────────

test("inlineMcpConfig replaces ${VAR} with the launching env and drops unset variables", () => {
  const config = { mcpServers: { "model-dispatch": { command: "node", args: ["x"], env: { A: "${A}", B: "${B}", LIT: "plain" } } } };
  const out = inlineMcpConfig(config, { A: "secret-a" });
  assert.deepEqual(out.mcpServers["model-dispatch"].env, { A: "secret-a", LIT: "plain" });
  assert.equal(config.mcpServers["model-dispatch"].env.A, "${A}", "the input is not mutated");
});

test("materialiseRunRoot builds .agents/plugins/mmo with symlinked directories and an inlined config, outside the repo", () => {
  const base = mkdtempSync(join(tmpdir(), "agy-runroot-"));
  const runRoot = defaultRunRoot("t/1", base);
  try {
    assert.ok(runRoot.startsWith(base));
    assert.ok(!runRoot.startsWith(ROOT));
    const { pluginDir } = materialiseRunRoot({ runRoot, pluginRoot: PLUGIN, env: { GEMINI_API_KEY: "AIza-x" } });
    assert.ok(lstatSync(join(pluginDir, "skills")).isSymbolicLink());
    assert.ok(lstatSync(join(pluginDir, "mcp")).isSymbolicLink());
    for (const d of LINKED_PLUGIN_DIRS) if (existsSync(join(PLUGIN, d))) assert.ok(existsSync(join(pluginDir, d)), d);
    assert.equal(JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8")).name, "mmo");
    assert.ok(existsSync(join(pluginDir, "hooks.json")));
    const env = JSON.parse(readFileSync(join(pluginDir, "mcp_config.json"), "utf8")).mcpServers["model-dispatch"].env;
    assert.equal(env.GEMINI_API_KEY, "AIza-x");
    assert.ok(!("ANTHROPIC_API_KEY" in env));
    removeRunRoot(runRoot);
    assert.ok(!existsSync(runRoot));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
