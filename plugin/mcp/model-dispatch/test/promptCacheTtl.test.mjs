/**
 * The Opus prompt-cache lifetime: the policy pins it, the Agent SDK adapter
 * sends it as `settings.promptCacheTtl`, and every attempt records the
 * lifetime its cache writes actually used, flagged when it differs from the
 * pin. Offline: the adapter's `query` is injected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAgentSdkAdapter, agentSdkOptions, observedCacheTtl } from "../dist/adapters/ClaudeAgentSdkAdapter.js";
import { loadPolicyFromPath } from "../dist/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = join(HERE, "..", "..", "..", "config", "policies", "antigravity-flash38-plus-opus5.yaml");

const CONFIG = {
  id: "opus",
  adapter: "claude-agent-sdk",
  model_name: "claude-sonnet-5",
  pricing: { input: 2, input_cached: 0.2, output: 10 },
  prompt_cache_ttl: "1h",
};

const PACKET = {
  id: "pkt-ttl",
  phase: "architecture_design",
  task_type: "design",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "test-pass",
};

const NOW = () => new Date("2026-09-14T00:00:00Z");

function query(messages, onCall) {
  return (args) => {
    onCall?.(args);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

function frame(write5m, write1h, id = "msg_1") {
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: write5m + write1h };
  if (write5m + write1h > 0) usage.cache_creation = { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h };
  return { type: "assistant", parent_tool_use_id: null, message: { id, model: "claude-sonnet-5", usage, stop_reason: "end_turn" } };
}

function result(writes) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"ok":true}',
    total_cost_usd: 0.01,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "sess-ttl",
    usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: writes, output_tokens: 20 },
    modelUsage: {
      "claude-sonnet-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: writes, webSearchRequests: 0, costUSD: 0.01 },
    },
  };
}

async function run(config, messages) {
  return new ClaudeAgentSdkAdapter(config, { queryFn: query(messages), now: NOW }).execute(PACKET);
}

test("the shipped policy pins the Opus cache lifetime at 1h", () => {
  const policy = loadPolicyFromPath(SHIPPED);
  const opus = policy.models.find((m) => m.adapter === "claude-agent-sdk");
  assert.equal(opus.prompt_cache_ttl, "1h");
});

test("the pin reaches the SDK as settings.promptCacheTtl, never through env", () => {
  const opts = agentSdkOptions({ model_name: "claude-opus-5", prompt_cache_ttl: "1h" });
  assert.deepEqual(opts.settings, { promptCacheTtl: "1h" });
  assert.equal(opts.env, undefined);
  assert.equal("settings" in agentSdkOptions({ model_name: "claude-opus-5" }), false, "no pin, no settings: Claude Code's default applies");
});

test("an attempt whose writes used the pinned lifetime records it and raises no flag", async () => {
  const out = await run(CONFIG, [frame(0, 900), result(900)]);
  assert.equal(out.success, true);
  assert.deepEqual(out.attempts[0].prompt_cache_ttl, { pinned: "1h", observed: "1h", mismatch: false });
});

test("writes on another lifetime than the pin are flagged", async () => {
  const out = await run(CONFIG, [frame(900, 0), result(900)]);
  assert.deepEqual(out.attempts[0].prompt_cache_ttl, { pinned: "1h", observed: "5m", mismatch: true });

  const mixed = await run(CONFIG, [frame(300, 600), result(900)]);
  assert.deepEqual(mixed.attempts[0].prompt_cache_ttl, { pinned: "1h", observed: "mixed", mismatch: true });
});

test("no pin still records the lifetime the writes used", async () => {
  const { prompt_cache_ttl: _, ...unpinned } = CONFIG;
  const out = await run(unpinned, [frame(900, 0), result(900)]);
  assert.deepEqual(out.attempts[0].prompt_cache_ttl, { pinned: null, observed: "5m", mismatch: false });
});

test("a call with no cache writes, or writes with no TTL split, is never flagged", async () => {
  const none = await run(CONFIG, [frame(0, 0), result(0)]);
  assert.deepEqual(none.attempts[0].prompt_cache_ttl, { pinned: "1h", observed: "none", mismatch: false });

  const bare = { type: "assistant", parent_tool_use_id: null, message: { id: "m", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500 }, stop_reason: "end_turn" } };
  const unknown = await run(CONFIG, [bare, result(500)]);
  assert.deepEqual(unknown.attempts[0].prompt_cache_ttl, { pinned: "1h", observed: "unknown", mismatch: false });
});

test("a call stopped before its result records the lifetime its frames used", async () => {
  const out = await run(CONFIG, [frame(700, 0)]);
  assert.equal(out.attempts[0].usage_from_frames, true);
  assert.deepEqual(out.attempts[0].prompt_cache_ttl, { pinned: "1h", observed: "5m", mismatch: true });
});

test("observedCacheTtl reads an empty frame set as no writes", () => {
  assert.equal(observedCacheTtl(new Map()), "none");
});

test("the dispatched event copies the attempt's cache-lifetime record", () => {
  const src = readFileSync(join(HERE, "..", "dist", "server.js"), "utf8");
  const eventsIdx = src.indexOf("const events = attempts.map((att) => ({");
  const stampIdx = src.indexOf("prompt_cache_ttl: att.prompt_cache_ttl,");
  assert.notEqual(eventsIdx, -1);
  assert.ok(stampIdx > eventsIdx && stampIdx - eventsIdx < 4000, "the stamp sits inside the per-attempt event");
});

function policyFile(model) {
  const dir = mkdtempSync(join(tmpdir(), "ttl-policy-"));
  const path = join(dir, "policy.yaml");
  writeFileSync(path, `version: 1\nname: ttl\nmodels:\n${model}\nrules:\n  - default: m\n`);
  return path;
}

test("the loader refuses a lifetime other than 5m or 1h", () => {
  const model = (ttl) => `  - id: m\n    adapter: claude-agent-sdk\n    model_name: claude-opus-5\n    prompt_cache_ttl: ${ttl}`;
  assert.equal(loadPolicyFromPath(policyFile(model("5m"))).models[0].prompt_cache_ttl, "5m");
  assert.throws(() => loadPolicyFromPath(policyFile(model("30m"))), /prompt_cache_ttl must be 5m or 1h/);
  assert.throws(() => loadPolicyFromPath(policyFile(model("60"))), /prompt_cache_ttl must be 5m or 1h/);
});

test("the loader refuses a pin on an adapter that would not apply it", () => {
  const path = policyFile(`  - id: m\n    adapter: mcp:model-dispatch\n    model_name: gemini-3.8-flash\n    prompt_cache_ttl: 1h`);
  assert.throws(() => loadPolicyFromPath(path), /applied only by the claude-agent-sdk adapter/);
});
