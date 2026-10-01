/**
 * Every dispatched attempt records the wallet it billed, from what the
 * adapter saw at dispatch: the Agent SDK's init frame and the result's
 * modelUsage for Claude, the transport the adapter built for Gemini. The
 * manifest books wallets from this stamp instead of re-reading whatever
 * environment rebuilds it later.
 *
 * Offline: the SDK query, the `claude` spawn and the Gemini transport are
 * fakes, and the Antigravity worker is refused before it would spawn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeDispatchWallet, geminiDispatchWallet, reportedProviders } from "../dist/adapters/dispatchWallet.js";
import { ClaudeAgentSdkAdapter } from "../dist/adapters/ClaudeAgentSdkAdapter.js";
import { ClaudeCliAdapter } from "../dist/adapters/ClaudeCliAdapter.js";
import { GeminiFlashAdapter } from "../dist/adapters/GeminiFlashAdapter.js";
import { AntigravityWorkerAdapter } from "../dist/adapters/AntigravityWorkerAdapter.js";
import { WORKER_PYTHON_ENV } from "../dist/delegation/workerProcess.js";

const NOW = () => new Date("2026-09-14T12:00:00Z");

const PACKET = {
  id: "pkt-wallet",
  phase: "codegen",
  task_type: "controller_handler",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: ["valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "wallet",
};

const SONNET = { id: "sonnet", adapter: "claude-agent-sdk", model_name: "claude-sonnet-5" };

const VERTEX_ENV = { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "proj-b", CLOUD_ML_REGION: "global" };

function resultFrame(provider) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"ok":true}',
    total_cost_usd: 0.0007,
    stop_reason: "end_turn",
    usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        webSearchRequests: 0, costUSD: 0.0007, ...(provider ? { provider } : {}),
      },
    },
  };
}

const initFrame = (apiKeySource) => ({ type: "system", subtype: "init", apiKeySource, claude_code_version: "2.3.4", model: "claude-sonnet-5" });

function sdkAdapter(frames, env, seen = {}) {
  const queryFn = (args) => {
    seen.options = args.options;
    return (async function* () { for (const f of frames) yield f; })();
  };
  return new ClaudeAgentSdkAdapter(SONNET, { queryFn, now: NOW, env });
}

test("claudeDispatchWallet: what Claude Code reported decides, the bridge's env fills in", () => {
  const cases = [
    [{}, { apiKeySource: "ANTHROPIC_API_KEY" }, "A", "anthropic", "reported"],
    [{}, { apiKeySource: "apiKeyHelper" }, "A", "anthropic", "reported"],
    [{}, { apiKeySource: "none" }, "seat", "claude-seat", "reported"],
    [{ ANTHROPIC_API_KEY: "stale" }, { apiKeySource: "oauth" }, "seat", "claude-seat", "reported"],
    [{ ANTHROPIC_AUTH_TOKEN: "t" }, { apiKeySource: "none" }, "unknown", null, "reported"],
    [{}, { apiKeySource: "none", providers: ["vertex"] }, "B", "gcp", "reported"],
    [VERTEX_ENV, { apiKeySource: "ANTHROPIC_API_KEY", providers: ["firstParty"] }, "A", "anthropic", "reported"],
    [{}, { providers: ["bedrock"] }, "unknown", null, "reported"],
    [VERTEX_ENV, {}, "B", "gcp", "env"],
    [{ ANTHROPIC_API_KEY: "k" }, {}, "A", "anthropic", "env"],
    [{}, { providers: ["firstParty"] }, "unknown", null, "env"],
    [{}, {}, "unknown", null, "env"],
  ];
  for (const [env, facts, arm, name, source] of cases) {
    const w = claudeDispatchWallet(env, facts);
    const label = `${JSON.stringify(env)} ${JSON.stringify(facts)}`;
    assert.equal(w.arm, arm, label);
    assert.equal(w.name, name, label);
    assert.equal(w.source, source, label);
  }
  const b = claudeDispatchWallet(VERTEX_ENV);
  assert.equal(b.project, "proj-b");
  assert.equal(b.region, "global");
  assert.equal(claudeDispatchWallet({ ANTHROPIC_VERTEX_PROJECT_ID: "p" }, { apiKeySource: "none" }).project, undefined, "project only on arm B");
});

test("reportedProviders reads every modelUsage provider, once", () => {
  assert.deepEqual(reportedProviders({ a: { provider: "vertex" }, b: { provider: "vertex" }, c: {} }), ["vertex"]);
  assert.deepEqual(reportedProviders(undefined), []);
});

test("claude-agent-sdk: the init frame's apiKeySource sets the arm on the attempt", async () => {
  const keyed = await sdkAdapter([initFrame("ANTHROPIC_API_KEY"), resultFrame("firstParty")], {}).execute(PACKET);
  assert.deepEqual(keyed.attempts[0].wallet, {
    name: "anthropic", source: "reported", arm: "A",
    api_key_source: "ANTHROPIC_API_KEY", api_provider: "firstParty", claude_code_version: "2.3.4",
  });

  const seat = await sdkAdapter([initFrame("none"), resultFrame("firstParty")], { ANTHROPIC_API_KEY: "stale" }).execute(PACKET);
  assert.equal(seat.attempts[0].wallet.arm, "seat", "the SDK said no key was used, whatever the env holds");
  assert.equal(seat.attempts[0].wallet.name, "claude-seat");

  const vertex = await sdkAdapter([initFrame("none"), resultFrame("vertex")], VERTEX_ENV).execute(PACKET);
  assert.equal(vertex.attempts[0].wallet.arm, "B");
  assert.equal(vertex.attempts[0].wallet.project, "proj-b");
});

test("claude-agent-sdk: a call with no result still records the wallet, and the env never reaches the SDK", async () => {
  const seen = {};
  const out = await sdkAdapter([initFrame("ANTHROPIC_API_KEY")], {}, seen).execute(PACKET);
  assert.equal(out.success, false);
  assert.equal(out.attempts[0].wallet.arm, "A", "the init frame arrived before the stream died");
  assert.equal(seen.options.env, undefined, "the SDK inherits the bridge's environment");

  const refused = await new ClaudeAgentSdkAdapter({ ...SONNET, model_name: "claude-not-a-real-model" }, { now: NOW, env: VERTEX_ENV }).execute(PACKET);
  assert.equal(refused.attempts[0].wallet.arm, "B");
  assert.equal(refused.attempts[0].wallet.source, "env");
});

function fakeSpawn(stdout) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

test("claude-cli: the result's modelUsage provider sets the arm; no key and no init frame leaves it unsettled", async () => {
  const cli = (provider, env) => new ClaudeCliAdapter({ ...SONNET, adapter: "claude-cli" }, {
    spawnFn: fakeSpawn(JSON.stringify({ ...resultFrame(provider), session_id: "s" })),
    probeBinary: () => {},
    projectsDir: mkdtempSync(join(tmpdir(), "wallet-cli-")),
    now: NOW,
    env,
  }).execute(PACKET);
  assert.equal((await cli("vertex", {})).attempts[0].wallet.arm, "B");
  const unsettled = (await cli("firstParty", {})).attempts[0].wallet;
  assert.equal(unsettled.name, null);
  assert.equal(unsettled.api_provider, "firstParty");
});

const GEMINI_ENV_KEYS = ["GEMINI_API_KEY", "GEMINI_BACKEND", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", WORKER_PYTHON_ENV];
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(GEMINI_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of GEMINI_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of GEMINI_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const FLASH = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };

test("mcp:model-dispatch: each attempt carries the door and location its transport used", async () => {
  const doors = [
    [{ GEMINI_API_KEY: "test-key", GEMINI_BACKEND: "api-key" }, { name: "gemini-api-key", source: "transport", backend: "api-key", location: "" }],
    [{ GEMINI_BACKEND: "vertex", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "asia-south1" },
      { name: "gcp", source: "transport", backend: "vertex-adc", location: "asia-south1" }],
  ];
  for (const [env, wallet] of doors) {
    const out = await withEnv(env, async () => {
      const adapter = new GeminiFlashAdapter(FLASH, { now: NOW });
      const real = adapter.transport;
      adapter.transport = {
        backend: real.backend,
        location: real.location,
        createCache: async () => undefined,
        generate: async () => ({ text: '{"ok":true}', usage: { promptTokenCount: 10, candidatesTokenCount: 5 }, finishReason: "STOP" }),
      };
      return adapter.execute(PACKET);
    });
    assert.equal(out.success, true);
    assert.deepEqual(out.attempts[0].wallet, wallet, JSON.stringify(env));
  }
});

test("antigravity-worker: always Vertex, at the leaf's location, even on a refused delegation", async () => {
  const out = await withEnv({ GOOGLE_CLOUD_PROJECT: "p", [WORKER_PYTHON_ENV]: process.execPath }, () =>
    new AntigravityWorkerAdapter({ ...FLASH, id: "flash-agsdk-worker", adapter: "antigravity-worker", region: "us-central1" }, { now: NOW }).execute(PACKET));
  assert.equal(out.success, false, "no work_dir: refused before the worker spawns");
  assert.deepEqual(out.attempts[0].wallet, geminiDispatchWallet("vertex-adc", "us-central1"));
  assert.equal(out.attempts[0].wallet.name, "gcp");
});

test("the dispatched event copies the attempt's wallet", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js"), "utf8");
  const eventsIdx = src.indexOf("const events = attempts.map((att) => ({");
  const stampIdx = src.indexOf("wallet: att.wallet,");
  assert.notEqual(eventsIdx, -1);
  assert.ok(stampIdx > eventsIdx && stampIdx - eventsIdx < 4000, "the stamp sits inside the per-attempt event");
});
