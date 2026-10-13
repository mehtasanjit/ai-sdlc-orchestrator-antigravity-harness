/**
 * Runs against dist/adapters/ClaudeAgentSdkAdapter.js — the adapter takes its
 * `query` function by injection, so these tests never load the real Agent SDK
 * and never make a vendor call.
 *
 * The point of most of these is that the SDK transport books the SAME dollars
 * as the `claude -p` transport for the same usage: both price the result's
 * `modelUsage` against the dated list via claudeCliLedger. A divergence here
 * would make the two transports' cost studies incomparable, which is the one
 * thing this adapter exists to avoid.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ClaudeAgentSdkAdapter, agentSdkOptions } from "../dist/adapters/ClaudeAgentSdkAdapter.js";
import { computeCostUsd } from "../dist/pricing.js";

// Equals Sonnet 5 on the price list (2 / 0.2 / 10), so nothing here logs a
// policy-mismatch warning.
const BASE_CONFIG = {
  id: "sonnet-agent-sdk",
  adapter: "claude-agent-sdk",
  model_name: "claude-sonnet-5",
  pricing: { input: 2, input_cached: 0.2, output: 10 },
};

const PACKET = {
  id: "pkt-1",
  phase: "codegen",
  task_type: "controller_handler",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  acceptance: ["Responds with valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "test-pass",
};

/** A pinned date so the price list lookup is deterministic. */
const NOW = () => new Date("2026-09-14T00:00:00Z");

/** Build a fake `query` that yields the given messages in order. */
function fakeQuery(messages, onCall) {
  return (args) => {
    onCall?.(args);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

/** One assistant frame shaped like the SDK's: the Messages API message under `message`. */
function assistantFrame(usage, { id = "msg_1", model = "claude-sonnet-5", stop_reason = null } = {}) {
  return { type: "assistant", parent_tool_use_id: null, message: { id, model, usage, stop_reason } };
}

function resultFrame(overrides = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"ok":true}',
    total_cost_usd: 0.0123,
    duration_ms: 3000,
    duration_api_ms: 2500,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "11111111-2222-3333-4444-555555555555",
    usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0007,
      },
    },
    ...overrides,
  };
}

test("a successful query books modelUsage at the dated list price, not the SDK's own figure", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([assistantFrame({ input_tokens: 100, output_tokens: 50 }, { stop_reason: "end_turn" }), resultFrame()]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.deepEqual(out.result, { ok: true });
  assert.equal(out.terminal_reason, "success");
  assert.equal(out.tokens.input, 100);
  assert.equal(out.tokens.output, 50);

  const expected = computeCostUsd(
    { input: 100, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 50 },
    { input: 2, input_cached: 0.2, output: 10 },
  );
  assert.equal(out.cost_usd, expected, "cost comes from the price list");
  assert.notEqual(out.cost_usd, 0.0123, "not the SDK's total_cost_usd");
  assert.equal(out.attempts[0].cli_reported_cost_usd, 0.0123, "the SDK figure is kept as a check");
});

test("the cache-write TTL split comes from the assistant frames, so no transcript is read", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([
      assistantFrame(
        {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 600 },
        },
        { stop_reason: "end_turn" },
      ),
      resultFrame({
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 20 },
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 1000,
            webSearchRequests: 0,
            costUSD: 0.001,
          },
        },
      }),
    ]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.equal(
    out.attempts[0].ttl_split,
    "transcript",
    "the frames explained every written token, so the split is exact rather than approximate",
  );
  const perModel = out.attempts[0].per_model.find((m) => m.model === "claude-sonnet-5");
  assert.equal(perModel.tokens.input_cache_write_1h, 400);
  assert.equal(perModel.tokens.input_cache_write, 600);
});

test("frames sharing a message id are one message: cache writes counted once", async () => {
  // Two frames of the same streamed message. The second repeats the cache
  // fields and carries the terminal stop_reason.
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 800,
    cache_creation: { ephemeral_1h_input_tokens: 800, ephemeral_5m_input_tokens: 0 },
  };
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([
      assistantFrame(usage, { id: "msg_dup" }),
      assistantFrame({ ...usage, output_tokens: 99 }, { id: "msg_dup", stop_reason: "end_turn" }),
      resultFrame({
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 800, output_tokens: 99 },
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 10,
            outputTokens: 99,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 800,
            webSearchRequests: 0,
            costUSD: 0.001,
          },
        },
      }),
    ]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  const perModel = out.attempts[0].per_model.find((m) => m.model === "claude-sonnet-5");
  assert.equal(perModel.tokens.input_cache_write_1h, 800, "counted once, not twice");
  assert.equal(out.attempts[0].ttl_split, "transcript");
});

test("an error result is still priced, and reports as a vendor_error", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([
      assistantFrame({ input_tokens: 100, output_tokens: 50 }, { stop_reason: "end_turn" }),
      resultFrame({ subtype: "error_max_turns", is_error: true, result: "hit max turns" }),
    ]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.ok(out.cost_usd > 0, "an errored call still billed its tokens");
  assert.match(out.error, /max turns/);
});

test("a stream that ends with no result message fails and books the usage its frames reported", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([assistantFrame({ input_tokens: 100, output_tokens: 50 })]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.match(out.error, /no result message/);
  assert.equal(out.attempts[0].usage_from_frames, true);
  assert.deepEqual([out.tokens.input, out.tokens.output], [100, 50]);
  assert.equal(out.cost_usd, computeCostUsd({ input: 100, input_cached: 0, output: 50 }, BASE_CONFIG.pricing));
});

test("a stream with no frames at all books nothing", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, { queryFn: fakeQuery([]), now: NOW });
  const out = await adapter.execute(PACKET);
  assert.equal(out.success, false);
  assert.equal(out.cost_usd, 0);
});

test("a timeout keeps the usage the stream reported before it, instead of booking $0", async () => {
  const hang = () => (async function* () {
    yield assistantFrame({ input_tokens: 2000, cache_read_input_tokens: 500, output_tokens: 300 });
    await new Promise(() => {});
  })();
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, { queryFn: (args) => {
    const it = hang();
    // The adapter aborts through its AbortController; end the stream when it fires.
    return (async function* () {
      const aborted = new Promise((r) => args.options.abortController.signal.addEventListener("abort", r));
      // The adapter's deadline timer is unref'd; hold the event loop until it fires.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const first = await it.next();
        yield first.value;
        await aborted;
      } finally {
        clearInterval(keepAlive);
      }
    })();
  }, timeoutSec: 0.05, now: NOW });
  const out = await adapter.execute(PACKET);
  assert.equal(out.success, false);
  assert.match(out.error, /timeout after 0.05s/);
  assert.equal(out.attempts[0].usage_from_frames, true);
  assert.equal(out.tokens.input, 2000);
  assert.equal(out.tokens.input_cached, 500);
  assert.equal(out.tokens.output, 300);
  assert.ok(out.cost_usd > 0);
});

test("the adapter's default timeout fires before the bridge client gives up", async () => {
  const { DEFAULT_TIMEOUT_SEC } = await import("../dist/adapters/ClaudeAgentSdkAdapter.js");
  const { DEFAULT_TOOL_TIMEOUT_MS } = await import("../dist/driverClient.js");
  assert.ok(DEFAULT_TIMEOUT_SEC > 300, "300 s cut real Opus design and review calls short");
  assert.ok(DEFAULT_TIMEOUT_SEC * 1000 < DEFAULT_TOOL_TIMEOUT_MS, "the adapter must stop and book usage before the client abandons the call");
});

test("a model with no price is refused before the query runs", async () => {
  let called = false;
  const adapter = new ClaudeAgentSdkAdapter(
    { ...BASE_CONFIG, model_name: "claude-not-a-real-model", pricing: undefined },
    { queryFn: fakeQuery([resultFrame()], () => (called = true)), now: NOW },
  );
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.equal(called, false, "no tokens are bought when the dollars could not be reported");
  assert.equal(out.cost_usd, 0);
});

test("subagent frames are counted too, because modelUsage bills them", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([
      assistantFrame({ input_tokens: 10, output_tokens: 5 }, { id: "main", stop_reason: "end_turn" }),
      {
        type: "assistant",
        parent_tool_use_id: "toolu_1",
        message: {
          id: "sub",
          model: "claude-haiku-4-5",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 20,
            output_tokens: 7,
            cache_creation_input_tokens: 500,
            cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
          },
        },
      },
      resultFrame({
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0001,
          },
          "claude-haiku-4-5": {
            inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 0,
            cacheCreationInputTokens: 500, webSearchRequests: 0, costUSD: 0.0002,
          },
        },
      }),
    ]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  const haiku = out.attempts[0].per_model.find((m) => m.model === "claude-haiku-4-5");
  assert.ok(haiku, "the subagent's model is booked");
  assert.equal(
    haiku.tokens.input_cache_write_1h,
    500,
    "its TTL split came from its own frame; counting only the main loop would have priced these at 5m",
  );
});

test("options disable the built-in tools and keep the worker hermetic", () => {
  const opts = agentSdkOptions({ model_name: "claude-opus-5", reasoning: { effort: "high" } });

  assert.deepEqual(opts.tools, [], "tools:[] is the real restriction; allowedTools:[] would not be");
  assert.equal(opts.allowedTools, undefined, "allowedTools is an auto-approve list, not a restriction");
  assert.deepEqual(opts.settingSources, [], "no user/project CLAUDE.md, so token counts do not vary by machine");
  assert.equal(opts.maxTurns, 1, "one-shot, matching how this tier used `claude -p`");
  assert.equal(opts.model, "claude-opus-5");
  assert.equal(opts.effort, "high");
  assert.equal(opts.env, undefined, "env unset so the subprocess inherits all three Claude wallets");
  assert.equal(opts.resume, undefined, "no session reuse: a resumed result would carry the session's whole spend");
});

test("no output cap reaches the SDK, so the attempt claims no ceiling and keeps the declared budget", async () => {
  const opts = agentSdkOptions({ model_name: "claude-opus-5", reasoning: { effort: "high" } });
  for (const key of ["maxBudgetUsd", "maxTokens", "maxOutputTokens", "maxThinkingTokens"]) {
    assert.equal(opts[key], undefined, `${key} would be a cap the attempt does not report`);
  }

  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([assistantFrame({ input_tokens: 100, output_tokens: 5000 }, { stop_reason: "end_turn" }), resultFrame()]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);
  assert.equal(out.success, true);
  const [attempt] = out.attempts;
  assert.equal(attempt.ceiling_used, null, "the packet budget was never applied, so it is not a ceiling");
  assert.equal(attempt.budget_enforced, false);
  assert.equal(attempt.budget_declared, PACKET.budget.maxOutputTokens);

  const refused = await new ClaudeAgentSdkAdapter(
    { ...BASE_CONFIG, model_name: "claude-not-on-the-list", pricing: undefined },
    { queryFn: fakeQuery([]), now: NOW },
  ).execute(PACKET);
  assert.equal(refused.success, false);
  assert.equal(refused.attempts[0].ceiling_used, null);
  assert.equal(refused.attempts[0].budget_enforced, false);
  assert.equal(refused.attempts[0].budget_declared, PACKET.budget.maxOutputTokens);
});

test("options carry a fixed session title, so the SDK makes no Haiku call to generate one", () => {
  const opts = agentSdkOptions({ model_name: "claude-opus-5", reasoning: { effort: "high" } });
  assert.equal(typeof opts.title, "string");
  assert.ok(opts.title.length > 0, "an empty title would fall back to auto-generation");
});

test("effort is omitted when the policy sets no reasoning tier", () => {
  // Haiku 4.5 rejects an effort level, so the policy leaves `reasoning` off.
  const opts = agentSdkOptions({ model_name: "claude-haiku-4-5" });
  assert.equal("effort" in opts, false);
});

test("the adapter is reachable through the registry under its policy id", async () => {
  const { createAdapter, KNOWN_ADAPTER_IDS } = await import("../dist/adapters/index.js");
  assert.ok(KNOWN_ADAPTER_IDS.has("claude-agent-sdk"), "policy validation accepts the id");
  const built = createAdapter({ ...BASE_CONFIG });
  assert.equal(built.id, BASE_CONFIG.id);
  assert.equal(built.modelConfig.adapter, "claude-agent-sdk");
});

function textFrame(text, id) {
  return { type: "assistant", parent_tool_use_id: null, message: { id, model: "claude-sonnet-5", content: [{ type: "text", text }] } };
}

test("narration from earlier turns never leaks into the result the SDK returned", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([
      textFrame("I'll read the schema first.", "msg_1"),
      textFrame('{"ok":true}', "msg_2"),
      resultFrame({ num_turns: 2 }),
    ]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.deepEqual(out.result, { ok: true });
});

test("an empty result falls back to the last message's text, joined across its frames", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([
      textFrame("I'll read the schema first.", "msg_1"),
      textFrame('{"ok":', "msg_2"),
      textFrame("true}", "msg_2"),
      resultFrame({ result: "", num_turns: 2 }),
    ]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.deepEqual(out.result, { ok: true });
});

test("JSON wrapped in a code fence is parsed", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([resultFrame({ result: '```json\n{"ok":true}\n```' })]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.deepEqual(out.result, { ok: true });
});

test("text that is not JSON is kept verbatim under raw", async () => {
  const adapter = new ClaudeAgentSdkAdapter(BASE_CONFIG, {
    queryFn: fakeQuery([resultFrame({ result: "Done. The handler returns ok." })]),
    now: NOW,
  });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, true);
  assert.deepEqual(out.result, { raw: "Done. The handler returns ok." });
});

/**
 * A query that yields nothing until the adapter aborts it. The adapter's
 * deadline timer is unref'd, so the interval keeps the event loop alive until
 * the abort lands; without it node can exit with the test still pending.
 */
function hangingQuery() {
  return ({ options }) =>
    (async function* () {
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await new Promise((resolve) => options.abortController.signal.addEventListener("abort", resolve));
      } finally {
        clearInterval(keepAlive);
      }
    })();
}

test("the policy's worker_timeout_sec sets the deadline when no option overrides it", async () => {
  const adapter = new ClaudeAgentSdkAdapter({ ...BASE_CONFIG, worker_timeout_sec: 0.05 }, { queryFn: hangingQuery(), now: NOW });
  const out = await adapter.execute(PACKET);

  assert.equal(out.success, false);
  assert.match(out.error, /timeout after 0\.05s/);
});

test("an explicit timeoutSec option wins over the policy's worker_timeout_sec", async () => {
  const adapter = new ClaudeAgentSdkAdapter(
    { ...BASE_CONFIG, worker_timeout_sec: 600 },
    { queryFn: hangingQuery(), timeoutSec: 0.05, now: NOW },
  );
  const out = await adapter.execute(PACKET);

  assert.match(out.error, /timeout after 0\.05s/);
});
