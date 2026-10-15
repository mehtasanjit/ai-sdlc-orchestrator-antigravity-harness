/**
 * The setup checker's pure decision logic (plugin/agy/verify-setup.mjs) and
 * the brownfield env checks (plugin/agy/env-checks.mjs). No binary is
 * spawned: probes are injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluate, claudeArmState, pluginDiscoveryState, probeAgyCli, probeClaudeCli, probeClaudeLogin, parseVersionTriple, meetsMinVersion,
  MIN_AGY_VERSION, observePolicy, policyAdapters, DECLARED_ENV, isUnexpandedPlaceholder, usableEnv, unexpandedDeclaredEnv,
  parseSelectSpec, selectSpecProblem, selectsAgentWorker, enableAgentPath, DEFAULT_POLICY, nextStepsBanner,
} from "../../plugin/agy/verify-setup.mjs";
import { OUR_COMMAND_NAMES, checkPluginConflicts, commandNamesFrom, runChecks } from "../../plugin/agy/env-checks.mjs";
import { DEFAULT_POLICY as RUN_DEFAULT_POLICY } from "../../plugin/agy/run.mjs";
import { readMmoSelectFile } from "../../plugin/agy/mmoSelect.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(ROOT, "plugin");

const HEALTHY = {
  nodeMajor: 22,
  agyCli: { present: true, version: [1, 2, 3] },
  claudeCli: { present: true, version: [2, 1, 89] },
  hasNodeModules: true,
  hasDist: true,
  discovery: { ok: true, problems: [] },
  env: { ANTHROPIC_API_KEY: "sk-ant-x", GEMINI_API_KEY: "AIza-x" },
  vertex: { state: "none" },
  policy: { name: DEFAULT_POLICY, usesClaudeCli: true, usesGemini: true },
};

test("a healthy arm-A install evaluates clean", () => {
  const state = evaluate(HEALTHY);
  assert.deepEqual(state, { ok: true, problems: [] });
});

test("the two default-policy constants agree", () => {
  assert.equal(DEFAULT_POLICY, RUN_DEFAULT_POLICY);
});

test("missing agy is blocking; an old agy is blocking; a refused probe is only a warning", () => {
  assert.ok(evaluate({ ...HEALTHY, agyCli: { present: false } }).problems.some((p) => p.id === "agy-cli" && p.severity === "blocking"));
  assert.ok(evaluate({ ...HEALTHY, agyCli: { present: true, version: [1, 1, 16] } }).problems.some((p) => p.id === "agy-cli" && /older than the pinned 1\.2\.3/.test(p.message)));
  const p = evaluate({ ...HEALTHY, agyCli: { present: false, unprovable: true, detail: "EPERM" } }).problems.find((p) => p.id === "agy-cli-unprovable");
  assert.equal(p.severity, "warning");
});

test("the bridge must be installed and built", () => {
  const ids = evaluate({ ...HEALTHY, hasNodeModules: false, hasDist: false }).problems.map((p) => p.id);
  assert.ok(ids.includes("mcp-dependencies") && ids.includes("mcp-build"));
});

test("plugin discovery failure is blocking and names the file", () => {
  const p = evaluate({ ...HEALTHY, discovery: { ok: false, problems: ["/x/.agents/plugins.json is missing"] } }).problems.find((p) => p.id === "plugin-discovery");
  assert.equal(p.severity, "blocking");
  assert.match(p.message, /plugins\.json is missing/);
  assert.match(p.fix, /never `agy plugin install`/);
});

test("claudeArmState names the wallet the shell selects", () => {
  assert.equal(claudeArmState({}).arm, "none");
  assert.equal(claudeArmState({ ANTHROPIC_API_KEY: "k" }).arm, "A");
  const b = claudeArmState({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p", CLOUD_ML_REGION: "global" });
  assert.equal(b.arm, "B"); assert.deepEqual(b.missing, []);
  assert.deepEqual(claudeArmState({ CLAUDE_CODE_USE_VERTEX: "1" }).missing, ["ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"]);
  assert.equal(claudeArmState({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_VERTEX: "1" }).arm, "both");
  assert.equal(claudeArmState({ ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" }).arm, "none", "an unexpanded placeholder is not a key");
});

test("no Claude wallet blocks a policy that bills a Claude worker, and is a warning for one that does not", () => {
  const blocked = evaluate({ ...HEALTHY, env: { GEMINI_API_KEY: "x" } }).problems.find((p) => p.id === "claude-arm");
  assert.equal(blocked.severity, "blocking");
  const warned = evaluate({ ...HEALTHY, env: { GEMINI_API_KEY: "x" }, policy: { name: "flash-only", usesClaudeWorker: false, usesClaudeCli: false, usesGemini: true } }).problems.find((p) => p.id === "claude-arm");
  assert.equal(warned, undefined, "a policy with no Claude worker needs no Claude wallet at all");
});

test("a claude-agent-sdk policy needs a wallet but not `claude` on PATH", () => {
  // The Agent SDK ships its own Claude Code binary, so the PATH probe is
  // irrelevant to it — but the wallet still has to be selected.
  const sdkOnly = { name: "agent-sdk-only", usesClaudeWorker: true, usesClaudeCli: false, usesGemini: true };
  const withNoBinary = evaluate({ ...HEALTHY, claudeCli: { present: false }, policy: sdkOnly }).problems;
  assert.equal(withNoBinary.find((p) => p.id === "claude-cli"), undefined, "no PATH complaint for the SDK transport");
  const noWallet = evaluate({ ...HEALTHY, env: { GEMINI_API_KEY: "x" }, policy: sdkOnly }).problems.find((p) => p.id === "claude-arm");
  assert.equal(noWallet?.severity, "blocking", "the wallet is still required");
});

test("both arms set is blocking; an incomplete arm B is blocking", () => {
  assert.match(evaluate({ ...HEALTHY, env: { ...HEALTHY.env, CLAUDE_CODE_USE_VERTEX: "1" } }).problems.find((p) => p.id === "claude-arm").message, /Both Claude arms/);
  assert.match(evaluate({ ...HEALTHY, env: { GEMINI_API_KEY: "x", CLAUDE_CODE_USE_VERTEX: "1" } }).problems.find((p) => p.id === "claude-arm").message, /incomplete/);
});

test("no Gemini credential blocks a policy with a Gemini tier; a broken ADC is always blocking", () => {
  assert.equal(evaluate({ ...HEALTHY, env: { ANTHROPIC_API_KEY: "k" } }).problems.find((p) => p.id === "gemini-credentials").severity, "blocking");
  assert.equal(evaluate({ ...HEALTHY, env: { ANTHROPIC_API_KEY: "k" }, vertex: { state: "broken", source: "gcloud ADC file", detail: "missing refresh_token" } }).problems.find((p) => p.id === "gemini-credentials-broken").severity, "blocking");
});

test("unexpanded ${VAR} placeholders are reported, and a bad MMO_SELECT is blocking", () => {
  assert.deepEqual(unexpandedDeclaredEnv({ GEMINI_API_KEY: "${GEMINI_API_KEY}", MMO_SELECT: "a=b" }), ["GEMINI_API_KEY"]);
  assert.ok(evaluate({ ...HEALTHY, env: { ...HEALTHY.env, CLOUD_ML_REGION: "${CLOUD_ML_REGION}" } }).problems.some((p) => p.id === "env-placeholders"));
  assert.equal(selectSpecProblem({ MMO_SELECT: "flash-agsdk-worker" }).severity, "blocking");
  assert.equal(selectsAgentWorker({ MMO_SELECT: "gemini-flash=flash-agsdk-worker" }), true);
  assert.ok(isUnexpandedPlaceholder("${X}") && !isUnexpandedPlaceholder("$X"));
  assert.deepEqual(usableEnv({ A: "", B: "${B}", C: "c" }), { C: "c" });
  assert.deepEqual(parseSelectSpec("a=b, c=d").pairs, { a: "b", c: "d" });
});

test("the agent worker needs Vertex ADC — an API key alone is refused", () => {
  const p = evaluate({ ...HEALTHY, env: { ...HEALTHY.env, MMO_SELECT: "gemini-flash=flash-agsdk-worker" }, agentWorker: { hasVenv: true, sdkImportable: true } }).problems.find((p) => p.id === "agent-worker-credentials");
  assert.equal(p.severity, "blocking");
});

test("DECLARED_ENV matches plugin/mcp_config.json exactly", () => {
  const env = JSON.parse(readFileSync(join(PLUGIN, "mcp_config.json"), "utf8")).mcpServers["model-dispatch"].env;
  assert.deepEqual([...DECLARED_ENV].sort(), Object.keys(env).sort());
});

test("pluginDiscoveryState passes on the real repo and fails when the mount is missing a piece", () => {
  const real = pluginDiscoveryState(PLUGIN);
  assert.deepEqual(real, { ok: true, problems: [], mount: join(ROOT, ".agents", "plugins", "mmo") });
  const bad = pluginDiscoveryState(PLUGIN, readFileSync, (p) => !p.endsWith(join("mmo", "skills")));
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /skills is missing \(the discovery mount\)/);
});

test("observePolicy reads the real default policy and its adapters", () => {
  const p = observePolicy(PLUGIN, "/nonexistent");
  assert.equal(p.name, DEFAULT_POLICY);
  assert.equal(p.selected, false);
  // The shipped policy's judgment tier is claude-agent-sdk, which is a Claude
  // worker (so the wallet is required) but needs no `claude` on PATH.
  assert.equal(p.usesClaudeWorker, true);
  assert.equal(p.usesClaudeCli, false);
  assert.equal(p.usesGemini, true);
  assert.deepEqual(policyAdapters("models:\n  - adapter: claude-cli\n  - adapter: mcp:model-dispatch # x"), ["claude-cli", "mcp:model-dispatch"]);
});

test("version probes parse agy and claude output and treat ENOENT as absent, EPERM as unprovable", () => {
  assert.deepEqual(parseVersionTriple("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersionTriple("2.1.89 (Claude Code)"), [2, 1, 89]);
  assert.ok(meetsMinVersion([1, 2, 3], MIN_AGY_VERSION) && !meetsMinVersion([1, 2, 2], MIN_AGY_VERSION));
  assert.deepEqual(probeAgyCli(() => ({ status: 0, stdout: "1.2.3\n" })), { present: true, version: [1, 2, 3] });
  assert.equal(probeAgyCli(() => ({ error: { code: "ENOENT" } })).unprovable, false);
  assert.equal(probeAgyCli(() => ({ error: { code: "EPERM" } })).unprovable, true);
  assert.deepEqual(probeClaudeCli(() => ({ status: 0, stdout: "2.1.89 (Claude Code)" })), { present: true, version: [2, 1, 89] });
});

test("enableAgentPath writes and clears the project-local selection file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-select-"));
  try {
    const on = enableAgentPath({ projectRoot: dir, enabled: true });
    assert.equal(on.spec, "gemini-flash=flash-agsdk-worker");
    assert.equal(readMmoSelectFile(dir), "gemini-flash=flash-agsdk-worker");
    const off = enableAgentPath({ projectRoot: dir, enabled: false });
    assert.equal(off.spec, undefined);
    assert.equal(readMmoSelectFile(dir), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the next-steps banner names the repo-discovery route and the sign-in caveat, never agy plugin install", () => {
  const banner = nextStepsBanner("/nonexistent", true);
  assert.match(banner, /\.agents|\/plugins lists mmo/);
  assert.match(banner, /agy models/);
  assert.ok(!/plugin install/.test(banner));
  assert.equal(nextStepsBanner("/nonexistent", false), null);
});

test("the banner starts the chat on the project's driver pin, or says why it cannot", () => {
  const banner = nextStepsBanner("/nonexistent", true);
  assert.ok(banner.includes(`cd "/nonexistent" && agy --model gemini-3.8-flash-high\n`), banner);
  assert.match(banner, /Without --model the chat runs on agy's default model/);
  assert.doesNotMatch(banner, /open `agy` in the repo root/);
  const other = nextStepsBanner("/p", true, { command: "agy --model gemini-3.8-flash-low", slug: "gemini-3.8-flash-low" });
  assert.ok(other.includes(`cd "/p" && agy --model gemini-3.8-flash-low\n`), other);
  const none = nextStepsBanner("/p", true, { command: null, error: "fairness pin: policy 'x' has no top-level driver: block" });
  assert.match(none, /✗ No command to start a chat on the driver pin: fairness pin: policy 'x' has no top-level driver: block/);
  assert.doesNotMatch(none, /agy --model/);
});

// ── env-checks ────────────────────────────────────────────────────────────

test("OUR_COMMAND_NAMES is exactly the shipped skill directories", () => {
  const skills = readdirSync(join(PLUGIN, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual([...OUR_COMMAND_NAMES].sort(), skills);
});

test("checkPluginConflicts handles the 1.2.3 'No imported plugins.' reply, a missing binary, and a collision", () => {
  assert.equal(checkPluginConflicts(() => ({ status: 0, stdout: "No imported plugins.\n" })).scanned, 0);
  assert.match(checkPluginConflicts(() => ({ error: { code: "ENOENT" } })).note, /is agy on PATH/);
  const r = checkPluginConflicts(() => ({ status: 0, stdout: JSON.stringify([{ name: "other", skills: ["pass", "unrelated"] }, { name: "mmo", skills: ["pass"] }]) }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, [{ plugin: "other", command: "pass" }]);
  assert.deepEqual(commandNamesFrom({ skills: { greenfield: {}, x: {} } }), ["greenfield", "x"]);
});

test("runChecks on this machine reports a schema and never throws", () => {
  const report = runChecks();
  assert.equal(report.schema_version, 1);
  assert.equal(report.checks.length, 4);
});

// ── the seat: Claude Code signed in to claude.ai ─────────────────────────

test("probeClaudeLogin parses `claude auth status` JSON and treats a failed spawn as signed out", () => {
  const json = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "x@y" });
  assert.deepEqual(probeClaudeLogin(() => ({ status: 0, stdout: json })), { loggedIn: true, method: "claude.ai", subscription: "max" });
  assert.equal(probeClaudeLogin(() => ({ error: { code: "ENOENT" } })).loggedIn, false);
  assert.equal(probeClaudeLogin(() => ({ status: 0, stdout: JSON.stringify({ loggedIn: false }) })).loggedIn, false);
});

test("a claude.ai sign-in with no key is the seat; a key or Vertex still wins over it", () => {
  const login = { loggedIn: true, method: "claude.ai", subscription: "max" };
  assert.equal(claudeArmState({}, login).arm, "seat");
  assert.match(claudeArmState({}, login).detail, /max/);
  assert.equal(claudeArmState({ ANTHROPIC_API_KEY: "k" }, login).arm, "A");
  assert.equal(claudeArmState({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p", CLOUD_ML_REGION: "global" }, login).arm, "B");
  assert.equal(claudeArmState({}, { loggedIn: true, method: "console" }).arm, "none", "an API-console login is not a seat");
});

test("on the seat, evaluate passes with a warning that the Opus line is modeled", () => {
  const state = evaluate({ ...HEALTHY, env: { GEMINI_API_KEY: "g" }, claudeLogin: { loggedIn: true, method: "claude.ai", subscription: "max" } });
  assert.equal(state.ok, true);
  const p = state.problems.find((p) => p.id === "claude-seat");
  assert.equal(p.severity, "warning");
  assert.match(p.message, /modeled/);
  assert.ok(!state.problems.some((p) => p.id === "claude-arm"));
});
