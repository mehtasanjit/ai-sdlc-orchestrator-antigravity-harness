/**
 * The driver entry (plugin/agy/run.mjs) and the dispatch fallback
 * (plugin/agy/dispatch.mjs). Offline and free: the bridge connection is
 * injected and agy is never spawned. What these protect is the argv the
 * fairness argument rests on — every pin in docs/verification/
 * p1-agy-runtime.md has to survive into the real invocation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgyArgs,
  buildRunArtifacts,
  priorInvocations,
  assertResumable,
  terminated,
  loadPolicyFile,
  renderPrompt,
  renderSkills,
  renderHandover,
  validIntents,
  runIsComplete,
  envPresence,
  redactPrompt,
  pinGateMessage,
  GATE_MODES,
  RESUME_PROMPT,
  DEFAULT_MAX_TURNS,
  DEFAULT_POLICY,
  DEFAULT_PRINT_TIMEOUT,
  PLUGIN_ROOT,
  HARNESS_ROOT,
  parseArgs as parseRunArgs,
} from "../../plugin/agy/run.mjs";
import {
  parseArgs as parseDispatchArgs,
  buildExecuteArgs,
  buildPreflightArgs,
  buildLogEventArgs,
  bridgeEnv,
  summarize,
  runDispatch,
} from "../../plugin/agy/dispatch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN = join(ROOT, "plugin", "agy", "run.mjs");

function tmp() { return mkdtempSync(join(tmpdir(), "agy-driver-test-")); }
function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }

const SLUG = "gemini-3.8-flash-high";
const PIN = { model: "gemini-3.8-flash", effort: "high", billing_mode: "seat", pricing: { input: 0.75, input_cached: 0.075, output: 3.75 } };

// ── the pinned invocation ──────────────────────────────────────────────────

test("buildAgyArgs carries every pin from the verification doc", () => {
  const argv = buildAgyArgs({ slug: SLUG, promptText: "do the thing", projectRoot: "/p", outputDir: "/p/.sdlc" });
  assert.equal(argv[argv.indexOf("--model") + 1], SLUG, "effort is baked into the slug (check 14)");
  assert.ok(!argv.includes("--effort"), "no separate --effort: the slug is the one place the pin lives");
  assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
  assert.ok(argv.includes("--dangerously-skip-permissions"), "print mode soft-denies every tool otherwise (check 6)");
  assert.ok(!argv.includes("--sandbox"), "the bridge is a piped subprocess (check 2)");
  assert.equal(argv[argv.indexOf("--print-timeout") + 1], DEFAULT_PRINT_TIMEOUT);
  assert.equal(argv[argv.indexOf("--add-dir") + 1], "/p", "--add-dir is mandatory");
});

test("buildAgyArgs passes the prompt as the value of --print", () => {
  const argv = buildAgyArgs({ slug: SLUG, promptText: "---\nname: x\n---\nbody", projectRoot: "/p" });
  assert.equal(argv[0], "--print");
  assert.equal(argv[1], "---\nname: x\n---\nbody");
});

test("buildAgyArgs adds the output dir to the workspace only when it is outside the project", () => {
  const inside = buildAgyArgs({ slug: SLUG, promptText: "x", projectRoot: "/p", outputDir: "/p/.sdlc" });
  assert.equal(inside.filter((a) => a === "--add-dir").length, 1);
  const outside = buildAgyArgs({ slug: SLUG, promptText: "x", projectRoot: "/p", outputDir: "/runs/r1" });
  assert.deepEqual(outside.filter((a, i) => outside[i - 1] === "--add-dir"), ["/p", "/runs/r1"]);
});

test("a resumed turn passes --conversation and keeps every pin", () => {
  const argv = buildAgyArgs({ slug: SLUG, promptText: RESUME_PROMPT, projectRoot: "/p", resumeConversationId: "conv-1" });
  assert.equal(argv[argv.indexOf("--conversation") + 1], "conv-1");
  assert.equal(argv[argv.indexOf("--model") + 1], SLUG);
  assert.ok(argv.includes("--dangerously-skip-permissions"));
  const fresh = buildAgyArgs({ slug: SLUG, promptText: "x", projectRoot: "/p" });
  assert.ok(!fresh.includes("--conversation"));
});

test("the resume prompt tells the model not to redo finished work", () => {
  assert.match(RESUME_PROMPT, /do not redo completed phases/);
  assert.match(RESUME_PROMPT, /SUMMARY\.md/);
});

test("the turn cap is a positive integer with room for a real project", () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_TURNS) && DEFAULT_MAX_TURNS >= 4);
});

test("loadPolicyFile reads the real default policy and it carries the driver pin", () => {
  const policy = loadPolicyFile(DEFAULT_POLICY);
  assert.equal(policy.driver.runtime, "agy");
  assert.equal(policy.driver.model_name, "gemini-3.8-flash");
  assert.equal(policy.driver.reasoning.effort, "high");
});

test("loadPolicyFile throws a clear error for a policy that doesn't exist", () => {
  assert.throws(() => loadPolicyFile("no-such-policy"), /not found/);
});

test("parseArgs handles --key=value and bare flags", () => {
  assert.deepEqual(parseRunArgs(["--brief=/b.md", "--dry-run", "--gates=auto-approve"]), {
    brief: "/b.md", "dry-run": true, gates: "auto-approve",
  });
});

test("HARNESS_ROOT is the repo root that carries the .agents/plugins/mmo mount — the launcher's cwd", () => {
  assert.equal(HARNESS_ROOT, ROOT);
  assert.ok(existsSync(join(HARNESS_ROOT, ".agents", "plugins", "mmo", "plugin.json")));
  assert.equal(PLUGIN_ROOT, join(ROOT, "plugin"));
});

// ── prompt rendering ───────────────────────────────────────────────────────

test("renderPrompt substitutes {{KEY}} markers and ${CLAUDE_PLUGIN_ROOT}", () => {
  const out = renderPrompt("a {{X}} b ${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs", { X: "1", PLUGIN_ROOT: "/plug" });
  assert.equal(out, "a 1 b /plug/scripts/x.mjs");
});

test("renderPrompt throws on an unrendered placeholder rather than shipping it to the model", () => {
  assert.throws(() => renderPrompt("{{OUTPUT_DIR}} {{NOPE}}", { OUTPUT_DIR: "/o" }), /unrendered placeholder.*NOPE/);
});

const RENDER_VALUES = {
  PLUGIN_ROOT: "/plug", PROJECT_ROOT: "/proj", OUTPUT_DIR: "/out", CODE_DIR: "/proj/src", BRIEF_PATH: "/proj/brief.md",
  POLICY: DEFAULT_POLICY, RUN_ID: "r1", GATE_INSTRUCTION: GATE_MODES.prompt, HANDOVER: "",
};

test("the shipped conductor prompt renders with no placeholder left behind", () => {
  const template = readFileSync(join(ROOT, "plugin", "agy", "prompts", "conductor.md"), "utf8");
  const rendered = renderPrompt(template, RENDER_VALUES);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(rendered));
  assert.match(rendered, /\/out\/telemetry\.jsonl/);
});

test("the shipped conductor prompt states the rules the study rests on", () => {
  const text = readFileSync(join(ROOT, "plugin", "agy", "prompts", "conductor.md"), "utf8");
  assert.match(text, /author no shipped content/);
  assert.match(text, /You are Gemini\. Opus 5 is a worker behind the bridge/);
  assert.match(text, /execute_with_model/, "the bridge tool is named");
  assert.match(text, /agy\/dispatch\.mjs/, "headless dispatch goes through the script — print mode loads no plugin");
  assert.match(text, /--preflight --auth-mode=vendor/, "rule 0 is the dispatch form");
  assert.match(text, /manifest\.json` is written by the launcher/, "the model does not write the manifest");
  assert.match(text, /'\{\{PLUGIN_ROOT\}\}\/agy\/dispatch\.mjs'/, "paths that may contain spaces are quoted");
});

test("every documented gate mode has instruction text and the default waits for a person", () => {
  assert.deepEqual(Object.keys(GATE_MODES).sort(), ["auto-abort", "auto-approve", "prompt"]);
  assert.match(GATE_MODES.prompt, /wait for their answer/);
  assert.match(GATE_MODES["auto-approve"], /Do not ask a question you cannot receive an answer to/);
  assert.match(GATE_MODES["auto-approve"], /reviewer would have rejected/);
  assert.match(GATE_MODES["auto-abort"], /stop the run there/);
});

test("renderSkills writes the pipeline and brownfield guide with every placeholder resolved", () => {
  const dir = tmp();
  try {
    const written = renderSkills(dir, RENDER_VALUES);
    assert.equal(written.length, 2);
    for (const path of written) {
      const text = readFileSync(path, "utf8");
      assert.ok(!text.includes("${CLAUDE_PLUGIN_ROOT}"), `${path} still names the Claude plugin root`);
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(text), `${path} has an unrendered marker`);
    }
    assert.match(readFileSync(join(dir, "skills", "pipeline.md"), "utf8"), /\/plug\/scripts\//);
  } finally { cleanup(dir); }
});

// ── the brownfield handover ────────────────────────────────────────────────

test("validIntents reads the ids from intents.json rather than duplicating them", () => {
  const ids = validIntents();
  assert.ok(ids.includes("bugfix") && ids.includes("docs"));
});

test("renderHandover emits nothing when no job was supplied, and the keys the guide reads otherwise", () => {
  assert.equal(renderHandover({}), "");
  const block = renderHandover({ mode: "brownfield", intent: "bugfix", seed: "line one\nline two" });
  assert.match(block, /^mode: brownfield$/m);
  assert.match(block, /^intent: bugfix$/m);
  assert.match(block, /^seed_description: line one line two$/m);
});

test("renderHandover marks an inferred intent, and only an inferred one", () => {
  const inferred = renderHandover({ mode: "brownfield", intent: "docs", seed: "x", intentSource: "inferred" });
  assert.match(inferred, /^intent: docs$/m);
  assert.match(inferred, /^intent_source: inferred$/m);
  for (const intentSource of ["flag", undefined]) {
    const block = renderHandover({ mode: "brownfield", intent: "docs", seed: "x", intentSource });
    assert.ok(!/intent_source/.test(block), `intentSource=${intentSource} must not mark the handover`);
  }
});

test("an empty handover leaves no stray placeholder in the rendered prompt", () => {
  const template = readFileSync(join(ROOT, "plugin", "agy", "prompts", "conductor.md"), "utf8");
  assert.match(template, /\{\{HANDOVER\}\}/);
  assert.ok(!renderPrompt(template, RENDER_VALUES).includes("{{HANDOVER}}"));
});

// ── run artifacts ─────────────────────────────────────────────────────────

test("runIsComplete keys on SUMMARY.md, the artifact only the final phase writes", () => {
  assert.equal(runIsComplete("/o", (p) => p.endsWith("SUMMARY.md")), true);
  assert.equal(runIsComplete("/o", () => false), false);
});

const STREAM = [
  JSON.stringify({ event: "init", conversation_id: "c1", model: SLUG }),
  JSON.stringify({ event: "step_update", step: { tool_call: { name: "mcp_tool" }, step_idx: 3 } }),
  JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "OK", response: "done", num_turns: 4,
    usage: { input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1650 } } }),
].join("\n");

test("buildRunArtifacts models the driver's own cost from the result usage, labelled modeled", () => {
  const { events, rejection, modeled } = buildRunArtifacts({ jsonl: STREAM, pin: PIN, passId: "r1", policyName: DEFAULT_POLICY, now: () => "2026-09-16T00:00:00.000Z" });
  assert.equal(events.length, 3);
  assert.equal(rejection, null);
  assert.equal(modeled.length, 1);
  const e = modeled[0];
  assert.equal(e.provenance, "modeled");
  assert.equal(e.tier, "orchestrator");
  assert.equal(e.billing_mode, "seat");
  // total_tokens 1650 = 1000 + 400 + 200 + 50: the cache reads are on top of input_tokens, not inside it.
  assert.equal(e.token_reading, "cache-apart+thinking-apart");
  assert.equal(e.token_reading_check, "adds_up");
  assert.equal(e.input_tokens, 1000, "the counters' own total says input_tokens holds no cache reads");
  assert.equal(e.input_tokens_cached, 400);
  assert.equal(e.output_tokens, 250, "thinking tokens bill at the output rate");
  assert.equal(e.output_tokens_reasoning, 50);
  const expected = (1000 * 0.75 + 400 * 0.075 + 250 * 3.75) / 1e6;
  assert.ok(Math.abs(e.cost_usd - expected) <= 1e-6, `priced by computeCostUsd: ${e.cost_usd} vs ${expected}`);
});

const resultWith = (usage) => JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "OK", usage } });

test("each result is booked under the token reading its total_tokens adds up to", () => {
  const book = (usage) => buildRunArtifacts({ jsonl: resultWith(usage), pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T" }).modeled[0];
  const inside = book({ input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1250 });
  assert.equal(inside.token_reading, "cache-in-input+thinking-apart");
  assert.deepEqual([inside.input_tokens, inside.input_tokens_cached, inside.output_tokens], [600, 400, 250]);
  const thinkingInside = book({ input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1600 });
  assert.equal(thinkingInside.token_reading, "cache-apart+thinking-in-output");
  assert.deepEqual([thinkingInside.input_tokens, thinkingInside.output_tokens, thinkingInside.output_tokens_reasoning], [1000, 200, 50]);
});

test("counters that add up to no reading, or no total, are booked at the dearest reading and flagged", () => {
  for (const [usage, check] of [
    [{ input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 9999 }, "does_not_add_up"],
    [{ input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400 }, "no_total"],
  ]) {
    const { modeled, driverUsage } = buildRunArtifacts({ jsonl: resultWith(usage), pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T" });
    assert.equal(modeled[0].token_reading_check, check);
    assert.equal(modeled[0].input_tokens, 1000, "nothing subtracted");
    assert.equal(modeled[0].output_tokens, 250, "thinking added");
    assert.equal(driverUsage.results_with_unproven_reading, 1);
  }
});

test("two readings that both add up but price differently book the dearer and say ambiguous", () => {
  // cache 50 and thinking 50: input+output+thinking and input+cache+output are both 1250.
  const usage = { input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 50, total_tokens: 1250 };
  const e = buildRunArtifacts({ jsonl: resultWith(usage), pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T" }).modeled[0];
  assert.equal(e.token_reading_check, "ambiguous");
  assert.equal(e.token_reading, "cache-in-input+thinking-apart", "thinking at the output rate costs more than 50 more fresh input");
});

test("the driver line is priced from the dated list on the day each agy process started", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1_000_000 };
  const driver = { model_name: "gemini-3.8-flash", pricing: PIN.pricing };
  const { modeled, driverUsage } = buildRunArtifacts({
    invocations: [
      { stdout: resultWith(usage), status: 0, wall_ms: 1, started_at: "2026-12-31T23:00:00Z" },
      { stdout: JSON.stringify({ event: "result", result: { conversation_id: "c2", status: "OK", usage } }), status: 0, wall_ms: 1, started_at: "2027-01-01T01:00:00Z" },
    ],
    pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T", driver,
  });
  assert.deepEqual(modeled.map((e) => e.cost_usd), [0.75, 1.5], "the introductory card ends 31 Dec 2026; the next card bills from 1 Jan 2027");
  assert.deepEqual(modeled.map((e) => e.price_period.from), ["2026-09-02", "2027-01-01"]);
  assert.equal(modeled[0].price_basis, "list");
  assert.ok(driverUsage.price_warnings?.length, "the 2026 card in the driver block differs from the 2027 list and says so");
});

test("a driver model with no price on the run's day is refused", () => {
  const driver = { model_name: "gemini-3.8-flash", pricing: PIN.pricing };
  assert.throws(
    () => buildRunArtifacts({ invocations: [{ stdout: STREAM, status: 0, wall_ms: 1, started_at: "2026-08-01T00:00:00Z" }], pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T", driver }),
    /driver model 'gemini-3\.8-flash' has no price on 2026-08-01/,
  );
});

test("a model the stream names is recorded, and one that is not the pin is flagged", () => {
  const ok = buildRunArtifacts({ jsonl: STREAM, pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T" });
  assert.deepEqual(ok.reportedModels, [SLUG]);
  assert.deepEqual(ok.offPinModels, []);
  const other = STREAM.replace(`"model":"${SLUG}"`, '"model":"gemini-3.1-pro-high"');
  assert.deepEqual(buildRunArtifacts({ jsonl: other, pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T" }).offPinModels, ["gemini-3.1-pro-high"]);
  assert.deepEqual(buildRunArtifacts({ jsonl: resultWith({ input_tokens: 1, total_tokens: 1 }), pin: PIN, passId: "r", policyName: DEFAULT_POLICY, now: () => "T" }).reportedModels, [], "agy names no model: nothing to check, nothing assumed");
});

test("buildRunArtifacts records each invocation's line count, so a later --resume can split the stream", () => {
  const second = JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "OK", usage: { input_tokens: 3000, output_tokens: 400, thinking_tokens: 60, cache_read_tokens: 900, total_tokens: 3460 } } });
  const { modeled, driverUsage } = buildRunArtifacts({
    invocations: [{ stdout: STREAM, status: 0, wall_ms: 10 }, { stdout: second, status: 0, wall_ms: 20 }],
    pin: PIN, passId: "r1", policyName: DEFAULT_POLICY, now: () => "T",
  });
  assert.deepEqual(modeled.map((e) => e.invocation), [1, 2]);
  assert.deepEqual(driverUsage.invocations.map((i) => i.lines), [3, 1], "an unterminated last line still counts as a line");
  assert.equal(driverUsage.resume_check.check, 16);
});

test("a pin rejection in a carried invocation is not reported again by the launch that resumes it", () => {
  const rejected = JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "ERROR", error: "model is overloaded, try again later", usage: {} } });
  const ok = JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "OK", usage: { input_tokens: 10, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 11 } } });
  const carried = buildRunArtifacts({ invocations: [{ stdout: rejected, carried: true }, { stdout: ok, status: 0 }], pin: PIN, passId: "r1" });
  assert.equal(carried.rejection, null);
  const fresh = buildRunArtifacts({ invocations: [{ stdout: rejected, status: 1 }], pin: PIN, passId: "r1" });
  assert.match(fresh.rejection, /model/);
});

test("assertResumable refuses to carry a record made under another pin or policy", () => {
  const prior = { invocations: [{ stdout: "", carried: true }], pin: { slug: "gemini-3.8-flash-high" }, policy: "p1" };
  assert.doesNotThrow(() => assertResumable(prior, { slug: "gemini-3.8-flash-high", policyName: "p1" }));
  assert.throws(() => assertResumable(prior, { slug: "gemini-3.1-pro-high", policyName: "p1" }), /ran on 'gemini-3\.8-flash-high'.*--policy=p1/);
  assert.throws(() => assertResumable(prior, { slug: "gemini-3.8-flash-high", policyName: "p2" }), /ran under policy 'p1'/);
  assert.doesNotThrow(() => assertResumable({ invocations: [], pin: { slug: "x" }, policy: "y" }, { slug: "z", policyName: "w" }), "nothing carried, nothing to compare");
});

test("a resume that carries no earlier record is flagged, since check 16 decides what its first counters include", () => {
  const ok = JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "OK", usage: { input_tokens: 10, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 11 } } });
  assert.equal(buildRunArtifacts({ invocations: [{ stdout: ok }], pin: PIN, passId: "r1", resumedFirst: true }).driverUsage.resumed_without_earlier_record, true);
  assert.equal(buildRunArtifacts({ invocations: [{ stdout: ok }], pin: PIN, passId: "r1" }).driverUsage.resumed_without_earlier_record, undefined);
});

test("terminated adds the missing newline, so two invocations never share a line", () => {
  assert.equal(terminated('{"a":1}'), '{"a":1}\n');
  assert.equal(terminated('{"a":1}\n'), '{"a":1}\n');
  assert.equal(terminated(""), "");
  assert.equal(terminated(undefined), "");
});

test("priorInvocations reads the earlier launch of the same conversation back, split at the recorded boundaries", () => {
  const dir = tmp();
  try {
    const a = '{"event":"init","conversation_id":"c1"}\n{"event":"result","result":{"conversation_id":"c1","usage":{"input_tokens":1}}}\n';
    const b = '{"event":"result","result":{"conversation_id":"c1","usage":{"input_tokens":2}}}\n';
    writeFileSync(join(dir, "driver-events.jsonl"), a + b);
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ conversation_id: "c1", started_at: "S", driver_usage: { invocations: [{ lines: 2, exit_status: 0, wall_ms: 9 }, { lines: 1, exit_status: 1, wall_ms: 4 }] } }));
    const prior = priorInvocations(dir, "c1");
    assert.equal(prior.started_at, "S");
    assert.deepEqual(prior.invocations.map((i) => [terminated(i.stdout), i.status, i.wall_ms, i.carried]), [[a, 0, 9, true], [b, 1, 4, true]]);
    assert.deepEqual(priorInvocations(dir, "other").invocations, [], "a different conversation carries nothing");
    assert.deepEqual(priorInvocations(dir, null).invocations, []);

    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ conversation_id: "c1", agy_exit_status: 0, pin: { slug: "s" }, policy: "p" }));
    const legacy = priorInvocations(dir, "c1");
    assert.equal(legacy.invocations.length, 1, "no recorded boundaries and one init: one invocation");
    assert.equal(terminated(legacy.invocations[0].stdout), a + b);
    assert.deepEqual([legacy.pin, legacy.policy], [{ slug: "s" }, "p"]);

    const second = '{"event":"init","conversation_id":"c1"}\n' + b;
    writeFileSync(join(dir, "driver-events.jsonl"), a + second);
    const split = priorInvocations(dir, "c1");
    assert.deepEqual(split.invocations.map((i) => terminated(i.stdout)), [a, second], "a pre-boundary stream is split at each init event");

    writeFileSync(join(dir, "driver-manifest.json"), "not json");
    assert.deepEqual(priorInvocations(dir, "c1").invocations, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildRunArtifacts surfaces a pin rejection from the result envelope", () => {
  const bad = JSON.stringify({ event: "result", result: { status: "ERROR", error: "model gemini-9-flash-high not found", usage: {} } });
  const { rejection } = buildRunArtifacts({ jsonl: bad, pin: PIN, passId: "r1" });
  assert.match(rejection, /not found/);
});

test("envPresence reports which variables are set and never their values", () => {
  const out = envPresence({ ANTHROPIC_API_KEY: "sk-secret", GEMINI_API_KEY: "" });
  assert.equal(out.ANTHROPIC_API_KEY, true);
  assert.equal(out.GEMINI_API_KEY, false);
  assert.ok(!JSON.stringify(out).includes("sk-secret"));
});

test("redactPrompt truncates the prompt in a printed argv", () => {
  const argv = redactPrompt(["--print", "x".repeat(500), "--model", SLUG], 20);
  assert.match(argv[1], /^x{20}… \(500 chars\)$/);
  assert.equal(argv[3], SLUG);
});

test("the pin gate names the pending checks and the override", () => {
  const msg = pinGateMessage([1, 5]);
  assert.match(msg, /checks 1, 5/);
  assert.match(msg, /--allow-unverified-pin/);
});

// ── the real script, dry-run ──────────────────────────────────────────────

test("run.mjs --dry-run prints the pinned invocation without spawning agy, secrets redacted", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const r = spawnSync(process.execPath, [RUN, "--dry-run", `--project-root=${dir}`, `--output-dir=${join(dir, "out")}`, "--run-id=t"], {
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-should-not-print", GEMINI_API_KEY: "AIza-should-not-print" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pin.slug, SLUG);
    assert.equal(out.cwd, ROOT);
    assert.equal(out.argv[out.argv.indexOf("--model") + 1], SLUG);
    assert.equal(out.env_present.ANTHROPIC_API_KEY, true);
    assert.ok(!r.stdout.includes("should-not-print"));
    assert.ok(!existsSync(join(dir, "out")), "a dry run writes nothing");
  } finally { cleanup(dir); }
});

function dryRun(dir, ...flags) {
  return spawnSync(process.execPath, [RUN, "--dry-run", `--project-root=${dir}`, `--output-dir=${join(dir, "out")}`, "--run-id=t", ...flags], { encoding: "utf8" });
}

test("a brownfield --seed with no --intent resolves the job type at launch and records how", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const r = dryRun(dir, "--mode=brownfield", '--seed=add README section "Board features" documenting the WIP limit');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, "brownfield");
    assert.deepEqual(out.intent, { resolved: "docs", source: "inferred" });
  } finally { cleanup(dir); }
});

test("an explicit --intent is recorded as the flag, even beside a seed that reads differently", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const r = dryRun(dir, "--mode=brownfield", "--intent=bugfix", "--seed=extract LaneHeader component from Lane");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).intent, { resolved: "bugfix", source: "flag" });
  } finally { cleanup(dir); }
});

test("an ambiguous seed refuses to launch and names the colliding job types", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const r = dryRun(dir, "--mode=brownfield", "--seed=fix the 500 and add a regression test");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /did not resolve to one job type/);
    assert.match(r.stderr, /candidates: bugfix, test/);
    assert.match(r.stderr, /--intent=</);
  } finally { cleanup(dir); }
});

test("a seed on a greenfield run is passed through and infers nothing", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const r = dryRun(dir, "--seed=extract LaneHeader component from Lane");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, null);
    assert.equal(out.intent, null);
  } finally { cleanup(dir); }
});

test("run.mjs reaches the spawn without --allow-unverified-pin now that the headless checks pass", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const r = spawnSync(process.execPath, [RUN, `--project-root=${dir}`, "--agy-bin=/nonexistent/agy"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not launch/);
    assert.ok(!/not live-verified/.test(r.stderr));
  } finally { cleanup(dir); }
});

test("run.mjs with the override reaches the spawn and reports a missing agy binary", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const out = join(dir, "out");
    const r = spawnSync(process.execPath, [RUN, `--project-root=${dir}`, `--output-dir=${out}`, "--allow-unverified-pin", "--agy-bin=/nonexistent/agy", "--run-id=t"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not launch '\/nonexistent\/agy'/);
    assert.ok(existsSync(join(out, "policy_snapshot.yaml")), "the policy is snapshotted at launch");
    assert.ok(existsSync(join(out, "skills", "pipeline.md")));
  } finally { cleanup(dir); }
});

test("run.mjs rejects an unknown gate mode and an intent on a greenfield run", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    let r = spawnSync(process.execPath, [RUN, "--dry-run", `--project-root=${dir}`, "--gates=yolo"], { encoding: "utf8" });
    assert.equal(r.status, 1); assert.match(r.stderr, /--gates=yolo/);
    r = spawnSync(process.execPath, [RUN, "--dry-run", `--project-root=${dir}`, "--mode=greenfield", "--intent=bugfix"], { encoding: "utf8" });
    assert.equal(r.status, 1); assert.match(r.stderr, /--intent applies to brownfield/);
  } finally { cleanup(dir); }
});

// ── dispatch.mjs (pattern b) ───────────────────────────────────────────────

test("buildExecuteArgs includes only the fields actually supplied", () => {
  const packet = { id: "p1" };
  assert.deepEqual(buildExecuteArgs({ packet }), { packet });
  assert.deepEqual(
    buildExecuteArgs({ packet, policy: DEFAULT_POLICY, projectRoot: "/p", telemetryPath: "/t.jsonl", workDir: "/w" }),
    { packet, policy_name: DEFAULT_POLICY, project_root: "/p", telemetry_path: "/t.jsonl", work_dir: "/w" },
  );
});

test("buildPreflightArgs always carries auth_mode", () => {
  assert.deepEqual(buildPreflightArgs({ authMode: "vendor" }), { auth_mode: "vendor" });
});

test("buildLogEventArgs writes a zero-cost provenance:none event and refuses without a telemetry path", () => {
  const args = buildLogEventArgs({ phase: "security_review", taskType: "skipped", telemetryPath: "/t.jsonl" });
  assert.equal(args.event.provenance, "none");
  assert.equal(args.event.cost_usd, 0);
  assert.throws(() => buildLogEventArgs({ phase: "docs" }), /--telemetry/);
  assert.equal(args.event.pass, null);
  assert.equal(buildLogEventArgs({ phase: "docs", taskType: "skipped", telemetryPath: "/t.jsonl", runId: "r7" }).event.pass, "r7", "--run-id stamps the run");
});

test("runDispatch refuses a packet dispatch without --telemetry, before connecting to the bridge", async () => {
  const dir = tmp();
  try {
    const packetPath = join(dir, "packet.json");
    writeFileSync(packetPath, JSON.stringify({ id: "p1", phase: "docs" }));
    let connected = false;
    const connect = async () => { connected = true; return { callTool: async () => ({}), close: async () => {} }; };
    await assert.rejects(() => runDispatch({ packet: packetPath, out: join(dir, "r.json") }, { connect }), /--telemetry=<path> is required for a packet dispatch/);
    assert.equal(connected, false, "no bridge, so no paid call");
  } finally { cleanup(dir); }
});

test("bridgeEnv folds in the stored MMO_SELECT, but an explicit export wins", () => {
  assert.deepEqual(bridgeEnv("/p", {}, () => "gemini-flash=flash-agsdk-worker"), { MMO_SELECT: "gemini-flash=flash-agsdk-worker" });
  assert.equal(bridgeEnv("/p", { MMO_SELECT: "already=set" }, () => "stored=value"), undefined);
});

test("summarize prints a compact line with no result body", () => {
  const line = summarize("execute_with_model", { decision: { modelId: "opus" }, result: { success: true, cost_usd: 0.0123 } });
  assert.match(line, /model=opus/); assert.match(line, /success=true/); assert.match(line, /cost_usd=0\.0123/);
  assert.match(summarize("preflight_dispatch", { ok: false, models: [{ id: "opus", ok: false }] }), /opus:FAILED/);
});

test("runDispatch writes the full result to --out and returns only a summary", async () => {
  const dir = tmp();
  try {
    const packetPath = join(dir, "packet.json");
    const outPath = join(dir, "result.json");
    writeFileSync(packetPath, JSON.stringify({ id: "p1", phase: "docs" }));
    const fakeResult = { decision: { modelId: "opus" }, result: { success: true, cost_usd: 0.5 } };
    const calls = [];
    const connect = async () => ({ callTool: async (name, args) => { calls.push({ name, args }); return fakeResult; }, close: async () => {} });
    const out = await runDispatch({ packet: packetPath, out: outPath, policy: DEFAULT_POLICY, telemetry: join(dir, "telemetry.jsonl") }, { connect });
    assert.equal(calls[0].name, "execute_with_model");
    assert.equal(calls[0].args.telemetry_path, join(dir, "telemetry.jsonl"));
    assert.equal(calls[0].args.policy_name, DEFAULT_POLICY);
    assert.deepEqual(JSON.parse(readFileSync(outPath, "utf8")), fakeResult);
    assert.match(out.summary, /success=true/);
  } finally { cleanup(dir); }
});

test("runDispatch reports ok:false when preflight fails and always closes the bridge", async () => {
  const dir = tmp();
  try {
    let closed = false;
    const connect = async () => ({ callTool: async () => ({ ok: false, halt_reason: "no credential", models: [] }), close: async () => { closed = true; } });
    const out = await runDispatch({ preflight: true, "auth-mode": "vendor", out: join(dir, "p.json") }, { connect });
    assert.equal(out.ok, false);
    assert.equal(closed, true);
    await assert.rejects(() => runDispatch({ preflight: true, out: "/tmp/x.json" }, { connect }), /--auth-mode/);
    await assert.rejects(() => runDispatch({ packet: "/tmp/p.json" }, { connect }), /--out=<path> is required/);
  } finally { cleanup(dir); }
});

test("parseDispatchArgs handles --key=value and bare flags", () => {
  assert.deepEqual(parseDispatchArgs(["--packet=/p.json", "--preflight"]), { packet: "/p.json", preflight: true });
});
