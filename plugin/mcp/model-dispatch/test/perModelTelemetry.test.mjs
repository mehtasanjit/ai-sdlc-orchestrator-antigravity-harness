/**
 * A Claude worker call that also billed a side model (the Agent SDK's Haiku
 * call) carries its per-model ledger onto the telemetry event, and the
 * manifest books each model's tokens and dollars on that model's own row.
 *
 * The adapter runs on an injected fake `query`; no SDK, no vendor call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAgentSdkAdapter } from "../dist/adapters/ClaudeAgentSdkAdapter.js";
import { attemptEventFields, buildManifest, cacheWriteBuckets, modelShares } from "../dist/telemetry.js";
import { computeCostUsd } from "../dist/pricing.js";
import { lookupPrice } from "../dist/prices.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");
const DAY = "2026-09-16";
const OPUS = { id: "opus-agent-sdk", adapter: "claude-agent-sdk", model_name: "claude-opus-5" };
const PACKET = {
  id: "phase-1-requirements", phase: "requirements_analysis", task_type: "requirements", module: "app",
  instruction: "Return JSON.", inputs: [], outputSchema: {}, acceptance: [],
  budget: { maxInputTokens: 8000, maxOutputTokens: 4000 }, pass_id: "p1",
};

const fakeQuery = (messages) => () => (async function* () { for (const m of messages) yield m; })();

/** Opus with 1-hour cache writes, plus a Haiku call over the prompt that only the receipt names. */
const MESSAGES = [
  { type: "assistant", parent_tool_use_id: null, message: {
    id: "msg_1", model: "claude-opus-5", stop_reason: "end_turn",
    usage: { input_tokens: 18, cache_read_input_tokens: 2_643, cache_creation_input_tokens: 45_709,
      cache_creation: { ephemeral_1h_input_tokens: 45_709, ephemeral_5m_input_tokens: 0 }, output_tokens: 3_100 },
  } },
  { type: "result", subtype: "success", is_error: false, result: '{"ok":true}', stop_reason: "end_turn",
    duration_ms: 1000, duration_api_ms: 900,
    modelUsage: {
      "claude-opus-5": { inputTokens: 18, cacheReadInputTokens: 2_643, cacheCreationInputTokens: 45_709, outputTokens: 3_100, webSearchRequests: 0 },
      "claude-haiku-4-5": { inputTokens: 21_500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 40, webSearchRequests: 0 },
    } },
];

/** The fields server.ts copies from an attempt onto its event. */
function eventFrom(att) {
  return {
    ts: `${DAY}T10:00:00.000Z`, pass: "p1", phase: PACKET.phase, task_type: PACKET.task_type, task_id: PACKET.id,
    module: PACKET.module, model: OPUS.model_name, model_id: OPUS.id, adapter: OPUS.adapter, routed_by: "orchestrator",
    provenance: "vendor", routing: { policy_name: "test", policy_version: 1, rule_index: 0, rule_reason: "x" }, retry_count: 0,
    ...attemptEventFields(att),
    input_tokens: att.tokens.input,
    input_tokens_cached: att.tokens.input_cached,
    ...cacheWriteBuckets(att.tokens),
    output_tokens: att.tokens.output,
    cost_usd: att.cost_usd,
    latency_ms: att.latency_ms,
    success: att.success,
    attempt_number: att.attempt_number,
  };
}

async function dispatchOnce() {
  const adapter = new ClaudeAgentSdkAdapter(OPUS, { queryFn: fakeQuery(MESSAGES), now: () => new Date(`${DAY}T10:00:00Z`), env: { ANTHROPIC_API_KEY: "k" } });
  const out = await adapter.execute(PACKET);
  assert.equal(out.success, true);
  return eventFrom(out.attempts[0]);
}

const reprice = (model, row) => computeCostUsd({
  input: row.input_tokens,
  input_cached: row.input_tokens_cached,
  input_cache_write: row.input_tokens_cache_write - row.input_tokens_cache_write_1h,
  input_cache_write_1h: row.input_tokens_cache_write_1h,
  output: row.output_tokens,
}, lookupPrice(model, DAY).pricing);

test("the event carries one ledger row per billed model", async () => {
  const event = await dispatchOnce();
  assert.deepEqual(event.worker_per_model.map((r) => r.model).sort(), ["claude-haiku-4-5", "claude-opus-5"]);
  const haiku = event.worker_per_model.find((r) => r.model === "claude-haiku-4-5");
  assert.equal(haiku.tokens.input, 21_500);
});

test("the manifest books the Haiku side call on its own row, at the Haiku price", async () => {
  const event = await dispatchOnce();
  const m = buildManifest([event], { pass: "p1", policy_name: "test" });
  const opus = m.model_breakdown["claude-opus-5"];
  const haiku = m.model_breakdown["claude-haiku-4-5"];
  assert.ok(haiku, "a claude-haiku-4-5 row exists");
  assert.equal(opus.input_tokens, 18, "Opus keeps only its own fresh input");
  assert.equal(opus.input_tokens_cache_write_1h, 45_709);
  assert.equal(haiku.input_tokens, 21_500);
  assert.equal(opus.calls, 1);
  assert.equal(haiku.calls, 0, "the attempt was routed to Opus");
  assert.equal(haiku.side_calls, 1);
  assert.ok(Math.abs(reprice("claude-haiku-4-5", haiku) - haiku.cost_usd) <= 1e-6, "Haiku at the Haiku rate");
  assert.ok(Math.abs(reprice("claude-opus-5", opus) - opus.cost_usd) <= 1e-6, "Opus at the Opus rate");
  assert.ok(Math.abs(opus.cost_usd + haiku.cost_usd - m.total_cost_usd) <= 1e-6, "the rows sum to the logged cost");

  const byModel = m.phase_breakdown.requirements_analysis.by_model;
  assert.deepEqual(Object.keys(byModel).sort(), ["claude-haiku-4-5", "claude-opus-5"]);
  assert.deepEqual(m.phase_breakdown.requirements_analysis.models.sort(), ["claude-haiku-4-5", "claude-opus-5"]);
});

test("an event without a ledger, or with one row, stays whole on its routed model", () => {
  const plain = { model: "gemini-3.8-flash", input_tokens: 10, input_tokens_cached: 0, output_tokens: 5, cost_usd: 0.001 };
  assert.deepEqual(modelShares(plain).map((s) => [s.model, s.routed, s.cost_usd]), [["gemini-3.8-flash", true, 0.001]]);
  const one = { ...plain, model: "claude-opus-5[1m]", worker_per_model: [{ model: "claude-opus-5", reported_as: ["claude-opus-5[1m]"], tokens: { input: 10, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 5 }, cost_usd: 0.001 }] };
  assert.deepEqual(modelShares(one).map((s) => s.model), ["claude-opus-5[1m]"]);
});

test("server.ts copies the attempt's ledger fields onto every dispatched event", () => {
  const src = readFileSync(SERVER, "utf8");
  const mapIdx = src.indexOf("attempts.map((att) => ({");
  const spreadIdx = src.indexOf("...attemptEventFields(att)");
  assert.notEqual(spreadIdx, -1);
  assert.ok(spreadIdx > mapIdx && spreadIdx - mapIdx < 200, "inside the per-attempt event construction");
});
