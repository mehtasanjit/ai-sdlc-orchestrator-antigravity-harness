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

import { parseEventStream, parseInvocations, extractTurnUsage, modeledDriverCostEvents, driverUsage, conversationIdFrom, extractToolCalls, reportsUsage, RESUME_USAGE, tokenReading } from "../../plugin/agy/telemetry/event-reader.mjs";
import { RECORDED_READING, readingsThatFit } from "../../plugin/agy/telemetry/tokenLayouts.mjs";
import { driverRange, driverRangeNote, driverRangeNotes } from "../../plugin/agy/telemetry/driverRange.mjs";
import { readPin, driverSlug, assertPinnedInvocation, findPinRejection, pendingPinChecks, pinVerification, LIVE_PIN_CHECKS } from "../../plugin/agy/telemetry/fairnessPin.mjs";
import { inlineMcpConfig, materialiseRunRoot, removeRunRoot, defaultRunRoot, LINKED_PLUGIN_DIRS } from "../../plugin/agy/runRoot.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(ROOT, "plugin");
const policy = (name) => parseYaml(readFileSync(join(PLUGIN, "config", "policies", `${name}.yaml`), "utf8"));

// (prompt incl. cache reads, visible output, thinking, cache reads), laid out
// as agy 1.3.0 reports them (check 17): cache beside input and outside the
// total, thinking inside output.
const usage = (i, o, t, c) => ({ input_tokens: i - c, output_tokens: o + t, thinking_tokens: t, cache_read_tokens: c, total_tokens: i - c + o + t });
const result = (conv, u, extra = {}) => JSON.stringify({ event: "result", result: { conversation_id: conv, status: "OK", response: "", num_turns: 1, usage: u, ...extra } });

// ── event reader ──────────────────────────────────────────────────────────

test("parseEventStream keeps every well-formed line, stamps a clock, and skips junk", () => {
  const text = ['{"event":"init","conversation_id":"c1"}', "not json", "", result("c1", usage(10, 2, 0, 0))].join("\n");
  const events = parseEventStream(text, () => "T");
  assert.equal(events.length, 2);
  assert.equal(events[0].ts, "T");
  assert.equal(events[0].event, "init");
});

const OBSERVED_ERROR = '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}';

test("the observed auth-failure envelope parses and reports no usage, so it yields no turn", () => {
  const events = parseEventStream(OBSERVED_ERROR);
  assert.equal(events.length, 1);
  assert.equal(reportsUsage(events[0].result), false);
  assert.deepEqual(extractTurnUsage(events), []);
  assert.equal(conversationIdFrom(events), null, "an empty conversation id is not an id");
});

test("extractTurnUsage differences cumulative results of the same conversation (check 8)", () => {
  const text = [result("c1", usage(1000, 100, 10, 200)), result("c1", usage(2500, 300, 30, 900))].join("\n");
  const turns = extractTurnUsage(parseEventStream(text));
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].usage, { input_tokens: 800, output_tokens: 220, thinking_tokens: 20, cache_read_tokens: 700, total_tokens: 1020 });
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

// ── check 16: usage across a --conversation resume ─────────────────────────

const PRICING = { input: 0.75, input_cached: 0.075, output: 3.75 };
const OPTS = { pass: "r", model: "gemini-3.8-flash", pricing: PRICING, policyName: "p" };
const twoLaunches = () => parseInvocations([result("c1", usage(1000, 100, 0, 0)), result("c1", usage(2500, 300, 0, 0))]);

test("parseInvocations tags each process's events with its launch index", () => {
  const events = parseInvocations(['{"event":"init","conversation_id":"c1"}\n' + result("c1", usage(1, 1, 0, 0)), result("c1", usage(2, 2, 0, 0))], () => "T");
  assert.deepEqual(events.map((e) => [e.event, e.invocation]), [["init", 1], ["result", 1], ["result", 2]]);
});

test("across processes, the cumulative reading differences and the per-invocation reading restarts", () => {
  const cumulative = extractTurnUsage(twoLaunches(), { resume: "cumulative" });
  const fresh = extractTurnUsage(twoLaunches(), { resume: "per-invocation" });
  assert.equal(cumulative[1].usage.input_tokens, 1500);
  assert.equal(fresh[1].usage.input_tokens, 2500);
  assert.deepEqual(fresh.map((u) => u.invocation), [1, 2]);
});

test("within one process both readings difference consecutive results (a kept-open session, check 8)", () => {
  const events = parseInvocations([[result("c1", usage(1000, 100, 0, 0)), result("c1", usage(2500, 300, 0, 0))].join("\n")]);
  for (const resume of ["cumulative", "per-invocation"]) {
    assert.equal(extractTurnUsage(events, { resume })[1].usage.input_tokens, 1500, resume);
  }
});

test("extractTurnUsage refuses a reading that is not one of the two", () => {
  assert.throws(() => extractTurnUsage([], { resume: "pending" }), /not one of/);
});

test("while check 16 is pending the driver line carries the per-invocation upper bound and both figures", () => {
  const { modeled, summary } = driverUsage(twoLaunches(), OPTS, { invocations: [{ status: 0, wall_ms: 5 }, { status: 0, wall_ms: 7 }], resumeUsage: { check: 16, state: "pending" } });
  assert.equal(summary.reading, "per-invocation");
  assert.ok(summary.cost_usd_low < summary.cost_usd_high);
  assert.equal(summary.cost_usd, summary.cost_usd_high);
  assert.equal(modeled[1].input_tokens, 2500);
  assert.equal(modeled[1].usage_reading, "per-invocation");
  assert.deepEqual(summary.invocations.map((i) => [i.invocation, i.exit_status, i.wall_ms, i.result_events, i.num_turns]), [[1, 0, 5, 1, 1], [2, 0, 7, 1, 1]]);
  assert.deepEqual(summary.invocations[1].cumulative_usage, usage(2500, 300, 0, 0), "the raw counters check 16 is decided from");
});

test("a recorded check 16 prices the lines under its reading", () => {
  const recorded = driverUsage(twoLaunches(), OPTS, { invocations: [{}, {}], resumeUsage: { check: 16, state: "cumulative" } });
  assert.equal(recorded.summary.cost_usd, recorded.summary.cost_usd_low);
  assert.equal(recorded.modeled[1].input_tokens, 1500);
  assert.throws(() => driverUsage(twoLaunches(), OPTS, { resumeUsage: { check: 16, state: "maybe" } }), /not pending, cumulative or per-invocation/);
});

test("a process that ended without a result is named, not silently priced at zero", () => {
  const events = parseInvocations([result("c1", usage(1000, 100, 0, 0)), '{"event":"init","conversation_id":"c1"}']);
  const { summary } = driverUsage(events, OPTS, { invocations: [{ status: 0 }, { status: null }] });
  assert.deepEqual(summary.invocations_without_usage, [2]);
  assert.equal(summary.cost_usd_low, summary.cost_usd_high, "one result: the readings agree");
});

test("driverRange shows the bounds only while pending and they differ, and always names missing usage", () => {
  const check = { check: 16, state: "pending" };
  const pending = { resume_check: check, cost_usd_low: 1, cost_usd_high: 2, tokens_low: { input_tokens: 5 }, invocations_without_usage: [] };
  assert.deepEqual(driverRange(pending), { cost_usd_low: 1, cost_usd_high: 2, tokens_low: { input_tokens: 5 }, resume_check: check });
  assert.deepEqual(driverRange({ ...pending, cost_usd_high: 1 }), {});
  assert.deepEqual(driverRange({ ...pending, resume_check: { check: 16, state: "cumulative" } }), {});
  assert.deepEqual(driverRange({ ...pending, cost_usd_high: 1, invocations_without_usage: [3] }), { invocations_without_usage: [3] });
  assert.deepEqual(driverRange({ ...pending, cost_usd_high: 1, resumed_without_earlier_record: true }), { resumed_without_earlier_record: true, resume_check: check });
  assert.deepEqual(driverRange(null), {});
  assert.match(driverRangeNote(pending), /range \$1–\$2: check 16 .* pending, the figure is the per-invocation reading, the upper bound/);
  assert.equal(driverRangeNote(null), "");
});

test("with an invocation missing, the notes stop calling the figure an upper bound", () => {
  const notes = driverRangeNotes({ resume_check: { check: 16, state: "pending" }, cost_usd_low: 1, cost_usd_high: 2, invocations_without_usage: [3] });
  assert.doesNotMatch(notes.join(" "), /upper bound/);
  assert.match(notes.join(" "), /invocation\(s\) 3 reported no usage, so the true figure may be higher/);
});

test("an all-zero error result between two processes neither breaks the baseline nor hides the range (check 8's envelope)", () => {
  const r1 = result("c1", usage(1000, 200, 50, 400));
  const r3 = result("c1", usage(2500, 500, 80, 1200));
  const events = parseInvocations([r1, OBSERVED_ERROR, r3]);
  const { summary } = driverUsage(events, OPTS, { invocations: [{ status: 0 }, { status: 1 }, { status: 0 }] });
  assert.equal(summary.cost_usd_low, 0.003241, "r3 is differenced against r1, not against the zeros");
  assert.equal(summary.cost_usd_high, 0.004658);
  assert.deepEqual(summary.invocations_without_usage, [2]);
  assert.equal(summary.invocations[1].results_without_usage, 1);
  assert.equal(summary.invocations[1].last_status, "ERROR");
  const withId = parseInvocations([r1, result("c1", usage(0, 0, 0, 0), { status: "ERROR" }), r3]);
  assert.equal(driverUsage(withId, OPTS, { invocations: [{}, {}, {}] }).summary.cost_usd_low, 0.003241, "an error result that keeps the id fails the same way without the fix");
});

test("interleaved conversations keep separate baselines under the cumulative reading", () => {
  const events = parseEventStream([result("a", usage(100, 10, 0, 0)), result("b", usage(50, 5, 0, 0)), result("a", usage(300, 30, 0, 0))].join("\n"));
  assert.deepEqual(extractTurnUsage(events).map((u) => u.usage.input_tokens), [100, 50, 200]);
});

test("the token bounds travel with the cost bounds", () => {
  const { summary } = driverUsage(twoLaunches(), OPTS, { invocations: [{}, {}] });
  assert.equal(summary.tokens_low.input_tokens, 2500, "cumulative reading: 1000 + 1500");
  assert.equal(summary.tokens_high.input_tokens, 3500, "per-invocation reading: 1000 + 2500");
});

// ── check 17: how agy's counters nest ─────────────────────────────────────

// Recorded live on agy 1.3.0 (p1 check 17): five model calls in one process.
const CACHE_READING_RESULT = { input_tokens: 50394, output_tokens: 2649, thinking_tokens: 2002, cache_read_tokens: 114232, total_tokens: 53043 };

test("a result with cache reads and thinking fits only the recorded reading, and books its tokens once", () => {
  assert.deepEqual(readingsThatFit(CACHE_READING_RESULT), [RECORDED_READING.name]);
  const r = tokenReading(CACHE_READING_RESULT, { input: 0.75, input_cached: 0.075, output: 3.75 });
  assert.equal(r.name, RECORDED_READING.name);
  assert.equal(r.check, "adds_up");
  assert.deepEqual(r.tokens, { input: 50394, input_cached: 114232, output: 2649 }, "cache beside input, thinking inside output");
});

test("check 17's recorded reading matches its row in the verification doc", () => {
  const doc = readFileSync(join(ROOT, "docs", "verification", "p1-agy-runtime.md"), "utf8");
  const row = doc.split("\n").find((l) => l.startsWith(`| ${RECORDED_READING.check} |`));
  assert.ok(row, `check ${RECORDED_READING.check} has a row`);
  assert.match(row, /\*\*PASS/);
  assert.ok(row.includes(`\`${RECORDED_READING.name}\``), "the row names the reading the code records");
});

test("check 16's state in code matches its row in the verification doc", () => {
  const doc = readFileSync(join(ROOT, "docs", "verification", "p1-agy-runtime.md"), "utf8");
  const row = doc.split("\n").find((l) => l.startsWith(`| ${RESUME_USAGE.check} |`));
  assert.ok(row, `check ${RESUME_USAGE.check} has a row`);
  if (RESUME_USAGE.state === "pending") assert.match(row, /\*\*PENDING/);
  else assert.match(row, /\*\*PASS/);
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

test("the pin is verified only when agy named the conducting model and every name is the pin", () => {
  assert.deepEqual(pinVerification({ pending: [], observed: ["gemini-3.8-flash-high"], offPin: [] }), { verified: true });
  assert.deepEqual(pinVerification({ pending: [], observed: [], offPin: [] }), { verified: false, unverified_reason: "no_model_observed" }, "passed checks alone prove nothing about the run");
  assert.deepEqual(pinVerification({ pending: [], observed: ["gemini-3.8-flash", "gemini-3.1-pro"], offPin: ["gemini-3.1-pro"] }), { verified: false, unverified_reason: "model_mismatch" });
  assert.deepEqual(pinVerification({ pending: [16], observed: ["gemini-3.8-flash"], offPin: [] }), { verified: false, unverified_reason: "pending_checks" });
  assert.deepEqual(pinVerification({ pending: [16], observed: ["gemini-3.1-pro"], offPin: ["gemini-3.1-pro"] }), { verified: false, unverified_reason: "model_mismatch" }, "a wrong model outranks a pending check");
});
