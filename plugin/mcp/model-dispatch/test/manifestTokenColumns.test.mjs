/**
 * Every token rollup buildManifest writes carries the buckets its dollars
 * were billed on (cache reads, cache writes with the 1-hour share, thinking),
 * so each row re-prices from its own columns to its own cost_usd.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManifest } from "../dist/telemetry.js";
import { computeCostUsd } from "../dist/pricing.js";
import { lookupPrice } from "../dist/prices.js";

const DAY = "2026-09-16";

function listPrice(model) {
  const hit = lookupPrice(model, DAY);
  assert.equal(hit.unpriced, false, `${model} is on the list for ${DAY}`);
  return hit.pricing;
}

/** Each event's cost_usd is rounded to 1e-6, so a row of n events may differ from its re-price by up to n × 1e-6. */
const close = (a, b, n) => Math.abs(a - b) <= n * 1e-6 + 1e-12;

/** Re-prices a row from its own columns: the 1-hour share at the 1-hour rate, the rest at the 5-minute rate. */
function reprice(model, row) {
  return computeCostUsd({
    input: row.input_tokens,
    input_cached: row.input_tokens_cached,
    input_cache_write: row.input_tokens_cache_write - row.input_tokens_cache_write_1h,
    input_cache_write_1h: row.input_tokens_cache_write_1h,
    output: row.output_tokens,
  }, listPrice(model));
}

/** A dispatched event whose cost_usd is its tokens at the list price. */
function ev({ model, phase = "codegen", input, cached = 0, write5m, write1h, output, reasoning, task_id = "t" }) {
  const tokens = { input, input_cached: cached, input_cache_write: write5m, input_cache_write_1h: write1h, output };
  return {
    ts: `${DAY}T10:00:00.000Z`, pass: "p1", phase, task_type: "x", task_id, module: "m", model,
    routed_by: "orchestrator", provenance: "vendor",
    routing: { policy_name: "test", policy_version: 1, rule_index: 0, rule_reason: "x" },
    input_tokens: input,
    input_tokens_cached: cached,
    ...(write5m !== undefined || write1h !== undefined
      ? { input_tokens_cache_write: (write5m ?? 0) + (write1h ?? 0), ...(write1h !== undefined ? { input_tokens_cache_write_1h: write1h } : {}) }
      : {}),
    output_tokens: output,
    ...(reasoning !== undefined ? { output_tokens_reasoning: reasoning } : {}),
    cost_usd: computeCostUsd(tokens, listPrice(model)),
    latency_ms: 10, success: true, retry_count: 0,
  };
}

const EVENTS = [
  ev({ model: "claude-opus-5", phase: "requirements_analysis", input: 18, cached: 2_643, write1h: 45_709, output: 3_100, task_id: "r1" }),
  ev({ model: "claude-opus-5", phase: "architecture_design", input: 6, cached: 33_475, write5m: 1_200, write1h: 12_000, output: 5_400, task_id: "a1" }),
  ev({ model: "gemini-3.8-flash", phase: "codegen", input: 9_000, cached: 4_000, output: 2_000, reasoning: 1_500, task_id: "c1" }),
  ev({ model: "gemini-3.8-flash", phase: "codegen", input: 7_000, output: 8_192, reasoning: 7_900, task_id: "c2" }),
];

test("each model row re-prices from its own token columns to its cost_usd", () => {
  const m = buildManifest(EVENTS, { pass: "p1", policy_name: "test" });
  for (const [model, row] of Object.entries(m.model_breakdown)) {
    assert.ok(close(reprice(model, row), row.cost_usd, row.calls), `${model}: ${reprice(model, row)} vs ${row.cost_usd}`);
  }
  const opus = m.model_breakdown["claude-opus-5"];
  assert.equal(opus.input_tokens_cache_write, 45_709 + 13_200);
  assert.equal(opus.input_tokens_cache_write_1h, 57_709);
  assert.equal(opus.input_tokens_cached, 2_643 + 33_475);
  assert.equal(m.model_breakdown["gemini-3.8-flash"].output_tokens_reasoning, 9_400);
});

test("each phase's per-model rows re-price the same way, and the phase rows carry the columns", () => {
  const m = buildManifest(EVENTS, { pass: "p1", policy_name: "test" });
  for (const [phase, row] of Object.entries(m.phase_breakdown)) {
    for (const [model, byModel] of Object.entries(row.by_model)) {
      assert.ok(close(reprice(model, byModel), byModel.cost_usd, byModel.calls), `${phase}/${model}`);
    }
    for (const key of ["input_tokens_cache_write", "input_tokens_cache_write_1h", "output_tokens_reasoning"]) {
      assert.equal(typeof row[key], "number", `${phase}.${key}`);
    }
  }
  assert.equal(m.phase_breakdown.requirements_analysis.input_tokens_cache_write_1h, 45_709);
});

test("the dispatched totals carry the 1-hour share and the thinking tokens", () => {
  const m = buildManifest(EVENTS, { pass: "p1", policy_name: "test" });
  assert.equal(m.total_input_tokens_cache_write, 58_909);
  assert.equal(m.total_input_tokens_cache_write_1h, 57_709);
  assert.equal(m.total_output_tokens_reasoning, 9_400);
});
