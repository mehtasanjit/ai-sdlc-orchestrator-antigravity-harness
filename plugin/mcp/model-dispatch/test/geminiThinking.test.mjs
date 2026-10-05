/**
 * The completion door sends the thinking level the model entry asks for, and
 * every attempt records that level and the thinking tokens it spent.
 *
 * Without a level Gemini thinks at its default, and the thinking counts
 * against maxOutputTokens: an attempt can spend almost its whole ceiling
 * thinking and stop at MAX_TOKENS with little visible text. The shipped
 * flash-completion entry asks for LOW, the level the Claude Code harness's
 * completion typists use.
 *
 * Offline: the transport is replaced after construction, or the SDK client
 * inside a real transport is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GeminiFlashAdapter, geminiThinkingLevel } from "../dist/adapters/GeminiFlashAdapter.js";
import { ApiKeyTransport } from "../dist/adapters/geminiTransports.js";
import { computeCostUsd } from "../dist/pricing.js";
import { loadPolicyFromPath } from "../dist/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED_POLICY = join(HERE, "..", "..", "..", "config", "policies", "antigravity-flash38-plus-opus5.yaml");
const SERVER_BUNDLE = join(HERE, "..", "dist", "server.js");

const LEAF = {
  id: "flash-completion",
  adapter: "mcp:model-dispatch",
  model_name: "gemini-3.8-flash",
  pricing: { input: 0.75, input_cached: 0.075, output: 3.75 },
  max_output_tokens_absolute: 8192,
};
const PACKET = {
  id: "p1",
  phase: "codegen",
  task_type: "dto",
  module: "m",
  instruction: "Return {ok:true}.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: [],
  budget: { maxInputTokens: 1000, maxOutputTokens: 2048 },
  pass_id: "t",
};
const TODAY = () => new Date("2026-09-24T12:00:00Z");
const CARD = { input: 0.75, input_cached: 0.075, output: 3.75 };

const STOP = { text: '{"ok":true}', usage: { promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 310 }, finishReason: "STOP" };
// The shape of a truncated real attempt: nearly the whole ceiling spent thinking.
const CAPPED = { text: '{"ok":', usage: { promptTokenCount: 900, candidatesTokenCount: 230, thoughtsTokenCount: 1818 }, finishReason: "MAX_TOKENS" };

/** Run one packet through an adapter whose transport answers from `replies` in order. */
async function run(leaf, replies) {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const adapter = new GeminiFlashAdapter(leaf, { now: TODAY });
    const calls = [];
    const queue = [...replies];
    adapter.transport = {
      backend: "api-key",
      location: "",
      createCache: async () => undefined,
      generate: async (args) => {
        calls.push(args);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const out = await adapter.execute(PACKET);
    return { out, calls };
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
}

test("reasoning.tier low puts thinkingConfig LOW on the request", async () => {
  const { calls } = await run({ ...LEAF, reasoning: { tier: "low" } }, [STOP]);
  assert.deepEqual(calls[0].generationConfig.thinkingConfig, { thinkingLevel: "LOW" });
});

test("every tier maps to its member of the SDK's ThinkingLevel enum", () => {
  assert.equal(geminiThinkingLevel({ tier: "minimal" }), "MINIMAL");
  assert.equal(geminiThinkingLevel({ tier: "low" }), "LOW");
  assert.equal(geminiThinkingLevel({ tier: "medium" }), "MEDIUM");
  assert.equal(geminiThinkingLevel({ tier: "high" }), "HIGH");
});

test("an entry with no tier sends no thinking setting, so the model's default applies", async () => {
  assert.equal(geminiThinkingLevel(undefined), undefined);
  // An Opus-style effort is not a Gemini thinking level.
  assert.equal(geminiThinkingLevel({ effort: "high" }), undefined);
  assert.equal(geminiThinkingLevel({ tier: "constructor" }), undefined);
  for (const leaf of [LEAF, { ...LEAF, reasoning: { effort: "high" } }]) {
    const { calls } = await run(leaf, [STOP]);
    assert.equal("thinkingConfig" in calls[0].generationConfig, false, JSON.stringify(leaf.reasoning));
  }
});

test("the level reaches the SDK's generateContent config unchanged", async () => {
  const transport = new ApiKeyTransport("test-key");
  const sent = [];
  transport.ai = {
    models: {
      generateContent: async (req) => {
        sent.push(req);
        return { text: "{}", usageMetadata: {}, candidates: [{ finishReason: "STOP" }] };
      },
    },
  };
  await transport.generate({
    modelName: "gemini-3.8-flash",
    prompt: "p",
    generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingLevel: "LOW" } },
  });
  assert.deepEqual(sent[0].config.thinkingConfig, { thinkingLevel: "LOW" });
});

test("an attempt records the level sent and its thoughtsTokenCount as output_reasoning", async () => {
  const { out } = await run({ ...LEAF, reasoning: { tier: "low" } }, [STOP]);
  const [att] = out.attempts;
  assert.equal(att.thinking_level, "LOW");
  assert.equal(att.tokens.output_reasoning, 310);
  // Thinking stays inside output, billed once at the output rate.
  assert.equal(att.tokens.output, 40 + 310);
  assert.equal(att.cost_usd, computeCostUsd({ input: 900, input_cached: 0, output: 350 }, CARD));
});

test("the level changes the request, not the price: the same usage bills the same with or without it", async () => {
  const withLevel = await run({ ...LEAF, reasoning: { tier: "low" } }, [CAPPED, STOP]);
  const without = await run(LEAF, [CAPPED, STOP]);
  assert.equal(withLevel.out.cost_usd, without.out.cost_usd);
  assert.deepEqual(withLevel.out.attempts.map((a) => a.cost_usd), without.out.attempts.map((a) => a.cost_usd));
  assert.deepEqual(withLevel.out.tokens, without.out.tokens);
});

test("every attempt of a doubled packet carries the level and its own thinking tokens", async () => {
  const { out, calls } = await run({ ...LEAF, reasoning: { tier: "low" } }, [CAPPED, STOP]);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.deepEqual(c.generationConfig.thinkingConfig, { thinkingLevel: "LOW" });
  assert.deepEqual(out.attempts.map((a) => a.thinking_level), ["LOW", "LOW"]);
  assert.deepEqual(out.attempts.map((a) => a.tokens.output_reasoning), [1818, 310]);
  assert.deepEqual(out.attempts.map((a) => a.ceiling_used), [2048, 4096]);
});

test("no level sent is recorded as null, distinct from an event that predates the field", async () => {
  const { out } = await run(LEAF, [STOP]);
  assert.equal(out.attempts[0].thinking_level, null);
  assert.equal(JSON.parse(JSON.stringify(out.attempts[0])).thinking_level, null);
});

test("a vendor error still records the level the failed request carried", async () => {
  const { out } = await run({ ...LEAF, reasoning: { tier: "low" } }, [new Error("503 unavailable")]);
  assert.equal(out.terminal_reason, "vendor_error");
  assert.equal(out.attempts[0].thinking_level, "LOW");
});

test("a reply with candidates and no thoughtsTokenCount records zero thinking; no usage block records none", async () => {
  const noThoughts = await run(LEAF, [{ ...STOP, usage: { promptTokenCount: 900, candidatesTokenCount: 40 } }]);
  assert.equal(noThoughts.out.attempts[0].tokens.output_reasoning, 0);
  const noUsage = await run(LEAF, [{ ...STOP, usage: {} }]);
  assert.equal("output_reasoning" in noUsage.out.attempts[0].tokens, false);
});

test("execute_with_model copies the level onto each telemetry event", () => {
  // server.ts starts an MCP server on import, so the mapping is read from the bundle.
  const src = readFileSync(SERVER_BUNDLE, "utf8");
  assert.match(src, /thinking_level: att\.thinking_level/);
  assert.match(src, /output_tokens_reasoning: att\.tokens\.output_reasoning/);
});

test("the shipped policy loads and its flash-completion entry asks for the low level", async () => {
  const policy = loadPolicyFromPath(SHIPPED_POLICY);
  const leaf = policy.models.find((m) => m.id === "flash-completion");
  assert.deepEqual(leaf.reasoning, { tier: "low" });
  assert.equal(leaf.max_output_tokens_absolute, 8192);
  const { calls, out } = await run(leaf, [STOP]);
  assert.deepEqual(calls[0].generationConfig.thinkingConfig, { thinkingLevel: "LOW" });
  assert.equal(out.attempts[0].thinking_level, "LOW");
});

/** A policy file holding one model entry with the given reasoning block. */
function policyWith(reasoningYaml) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-thinking-policy-"));
  const path = join(dir, "routing-policy.yaml");
  writeFileSync(
    path,
    [
      "version: 1",
      "name: thinking-check",
      "models:",
      "  - id: flash-completion",
      "    adapter: mcp:model-dispatch",
      "    model_name: gemini-3.8-flash",
      ...(reasoningYaml === undefined ? [] : [`    reasoning: ${reasoningYaml}`]),
      "rules:",
      "  - default: flash-completion",
      "",
    ].join("\n"),
  );
  return path;
}

test("the loader accepts every Gemini tier, an effort, or no reasoning block", () => {
  for (const tier of ["minimal", "low", "medium", "high"]) {
    assert.equal(loadPolicyFromPath(policyWith(`{ tier: ${tier} }`)).models[0].reasoning.tier, tier);
  }
  assert.equal(loadPolicyFromPath(policyWith("{ effort: high }")).models[0].reasoning.effort, "high");
  assert.equal(loadPolicyFromPath(policyWith(undefined)).models[0].reasoning, undefined);
});

test("the loader refuses a tier no Gemini door can send", () => {
  // "off" is the console's picker value for "no thinking setting", not a level.
  for (const tier of ["off", "LOW", "max"]) {
    assert.throws(() => loadPolicyFromPath(policyWith(`{ tier: ${tier} }`)), /reasoning\.tier must be one of minimal, low, medium, high/);
  }
  assert.throws(() => loadPolicyFromPath(policyWith("low")), /reasoning must be a map/);
  assert.throws(() => loadPolicyFromPath(policyWith("[low]")), /reasoning must be a map/);
});
