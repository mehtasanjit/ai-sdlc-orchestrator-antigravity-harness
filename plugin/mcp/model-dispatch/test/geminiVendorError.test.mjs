/**
 * A Gemini call that fails is billed by what Google says it bills: nothing for
 * a request it answered with an error status, nothing for one that never left
 * this machine, and the prompt as input only when the connection broke with no
 * answer, since the request may have been served.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GeminiFlashAdapter, describeVendorFailure } from "../dist/adapters/GeminiFlashAdapter.js";

const LEAF = {
  id: "flash-completion",
  adapter: "mcp:model-dispatch",
  model_name: "gemini-3.8-flash",
  pricing: { input: 0.75, input_cached: 0.075, output: 3.75 },
  auth: { env: "GEMINI_API_KEY" },
};

const PACKET = {
  id: "pkt-fail",
  phase: "tests",
  task_type: "test_unit",
  module: "example",
  instruction: "Return {ok:true} as JSON. ".repeat(200),
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: ["valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "vendor-error",
};

async function failWith(err) {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const adapter = new GeminiFlashAdapter(LEAF, { now: () => new Date("2026-10-13T12:00:00Z") });
    adapter.transport = {
      backend: adapter.transport.backend,
      location: adapter.transport.location,
      createCache: async () => undefined,
      generate: async () => { throw err; },
    };
    return await adapter.execute(PACKET);
  } finally {
    process.stderr.write = write;
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
}

const apiError = (status) => Object.assign(new Error(`{"error":{"code":${status}}}`), { status });

for (const status of [400, 429, 500, 503]) {
  test(`a call Google answered with ${status} bills $0 and records the status`, async () => {
    const out = await failWith(apiError(status));
    assert.equal(out.success, false);
    assert.equal(out.terminal_reason, "vendor_error");
    assert.equal(out.cost_usd, 0);
    assert.deepEqual(out.attempts[0].tokens, { input: 0, input_cached: 0, output: 0 });
    assert.equal(out.attempts[0].error_status, status);
  });
}

test("a request that never left this machine bills $0", async () => {
  const err = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  const out = await failWith(err);
  assert.equal(out.cost_usd, 0);
  assert.equal(out.attempts[0].error_code, "ENOTFOUND");
});

test("a connection that broke with no answer keeps the prompt as the stated bound", async () => {
  const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const out = await failWith(err);
  assert.ok(out.attempts[0].tokens.input > 0, "the prompt is billed as input");
  assert.ok(out.cost_usd > 0);
});

test("describeVendorFailure reads the status and the code, never the wording", () => {
  assert.deepEqual(describeVendorFailure(apiError(403)), { error_status: 403 });
  assert.deepEqual(describeVendorFailure({ cause: { code: "ECONNREFUSED" } }), { error_code: "ECONNREFUSED" });
  assert.deepEqual(describeVendorFailure(new Error("500 Internal Server Error")), {});
});
