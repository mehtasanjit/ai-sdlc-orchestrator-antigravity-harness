/**
 * Every dispatched event names its dispatch, and the manifest counts
 * dispatches apart from attempts and rolls up the spend on failed attempts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attemptEventFields, buildManifest, dispatchKeys } from "../dist/telemetry.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

function ev(over) {
  return {
    ts: "2026-09-30T11:49:49.000Z", pass: "p1", phase: "codegen", task_type: "dto", task_id: "t", module: "m",
    model: "gemini-3.8-flash", routed_by: "orchestrator", provenance: "vendor",
    routing: { policy_name: "test", policy_version: 1, rule_index: 0, rule_reason: "x" },
    input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.01, latency_ms: 10, success: true, retry_count: 0,
    ...over,
  };
}

/** Output-cap doubling: 3000, 6000, then the 8192 absolute cap, every attempt truncated. */
const DOUBLING = [
  ev({ task_id: "c1", dispatch_id: "d-1", attempt_number: 1, ceiling_used: 3000, hit_output_cap: true, stop_reason: "MAX_TOKENS", success: false, output_tokens: 3000, cost_usd: 0.012 }),
  ev({ task_id: "c1", dispatch_id: "d-1", attempt_number: 2, ceiling_used: 6000, hit_output_cap: true, stop_reason: "MAX_TOKENS", success: false, output_tokens: 6000, cost_usd: 0.023 }),
  ev({ task_id: "c1", dispatch_id: "d-1", attempt_number: 3, ceiling_used: 8192, hit_output_cap: true, stop_reason: "MAX_TOKENS", success: false, output_tokens: 8192, cost_usd: 0.031, terminal_reason: "output_cap_at_model_absolute" }),
];

test("attemptEventFields stamps the dispatch id, the stop reason and the cap flag", () => {
  const fields = attemptEventFields(
    { attempt_number: 2, ceiling_used: 6000, stop_reason: "MAX_TOKENS", hit_output_cap: true, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0, latency_ms: 1, success: false },
    { dispatch_id: "d-9", terminal_reason: "output_cap_doubling_budget_exhausted" },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), {
    dispatch_id: "d-9", stop_reason: "MAX_TOKENS", hit_output_cap: true, terminal_reason: "output_cap_doubling_budget_exhausted",
  });
});

test("dispatchKeys uses dispatch_id, and numbers legacy dispatches of one packet apart", () => {
  const legacy = [
    { task_id: "phase-1", attempt_number: 1 },
    { task_id: "phase-1", attempt_number: 1 },
    { task_id: "c1", attempt_number: 1 },
    { task_id: "c1", attempt_number: 2 },
    { task_id: "phase-1" },
  ];
  assert.deepEqual(dispatchKeys(legacy), ["phase-1#1", "phase-1#2", "c1#1", "c1#1", "phase-1#3"]);
  assert.deepEqual(dispatchKeys(DOUBLING), ["d-1", "d-1", "d-1"]);
});

test("a doubling dispatch is one dispatch of three attempts, all of its spend failed", () => {
  const m = buildManifest(DOUBLING, { pass: "p1", policy_name: "test" });
  const row = m.model_breakdown["gemini-3.8-flash"];
  assert.equal(row.calls, 3);
  assert.equal(row.dispatches, 1);
  assert.equal(row.failed_attempts, 3);
  assert.equal(row.failed_cost_usd, 0.066);
});

test("two dispatches of one packet count as two, and only the failed one's dollars are failed", () => {
  const events = [
    ev({ task_id: "phase-1", phase: "requirements_analysis", model: "claude-opus-5", dispatch_id: "a", attempt_number: 1, success: false, cost_usd: 0.56569 }),
    ev({ task_id: "phase-1", phase: "requirements_analysis", model: "claude-opus-5", dispatch_id: "b", attempt_number: 1, success: true, cost_usd: 0.345283 }),
  ];
  const m = buildManifest(events, { pass: "p1", policy_name: "test" });
  const opus = m.model_breakdown["claude-opus-5"];
  assert.equal(opus.dispatches, 2);
  assert.equal(opus.calls, 2);
  assert.equal(opus.failed_attempts, 1);
  assert.equal(opus.failed_cost_usd, 0.56569);
  assert.equal(m.phase_breakdown.requirements_analysis.by_model["claude-opus-5"].dispatches, 2);
});

test("server.ts gives each execute_with_model call one id and stamps the terminal reason on its last attempt", () => {
  const src = readFileSync(SERVER, "utf8");
  assert.match(src, /const dispatchId = randomUUID\(\);/);
  assert.match(src, /attemptEventFields\(att, \{\s*dispatch_id: dispatchId,\s*terminal_reason: att === attempts\[attempts\.length - 1\] \? result\.terminal_reason : undefined,/);
});
