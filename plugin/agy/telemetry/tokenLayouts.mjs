/**
 * The ways agy's five usage counters can nest. agy does not document them;
 * `total_tokens` decides per result. Check 17 (p1-agy-runtime.md) recorded
 * agy 1.3.0 as `cache-outside-total+thinking-in-output`: cache reads sit
 * beside `input_tokens` and are left out of `total_tokens`. The other
 * readings stay so a build that changes the layout is caught, not misread.
 * Dependency-free so tools/p1/check16.mjs can read a live result before the
 * bridge is built.
 */
export const TOKEN_READINGS = {
  "cache-in-input+thinking-apart": { cacheInInput: true, cacheInTotal: true, thinkingInOutput: false },
  "cache-in-input+thinking-in-output": { cacheInInput: true, cacheInTotal: true, thinkingInOutput: true },
  "cache-apart+thinking-apart": { cacheInInput: false, cacheInTotal: true, thinkingInOutput: false },
  "cache-apart+thinking-in-output": { cacheInInput: false, cacheInTotal: true, thinkingInOutput: true },
  "cache-outside-total+thinking-apart": { cacheInInput: false, cacheInTotal: false, thinkingInOutput: false },
  "cache-outside-total+thinking-in-output": { cacheInInput: false, cacheInTotal: false, thinkingInOutput: true },
};

/** The reading check 17 observed on agy 1.3.0. */
export const RECORDED_READING = { check: 17, name: "cache-outside-total+thinking-in-output" };

/** The reading that bills the most: nothing subtracted, thinking added. */
export const DEAREST_READING = "cache-apart+thinking-apart";

/** `{ tokens: {input, input_cached, output}, total }` for `usage` under one reading. */
export function tokensUnder(usage, name) {
  const { cacheInInput, cacheInTotal, thinkingInOutput } = TOKEN_READINGS[name];
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.cache_read_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const thinking = usage?.thinking_tokens ?? 0;
  return {
    tokens: {
      input: cacheInInput ? input - cached : input,
      input_cached: cached,
      output: thinkingInOutput ? output : output + thinking,
    },
    total: input + (cacheInInput || !cacheInTotal ? 0 : cached) + output + (thinkingInOutput ? 0 : thinking),
  };
}

/** The readings whose parts sum to the result's own `total_tokens`. */
export function readingsThatFit(usage) {
  if (typeof usage?.total_tokens !== "number" || usage.total_tokens <= 0) return [];
  return Object.keys(TOKEN_READINGS).filter((name) => {
    const r = tokensUnder(usage, name);
    return r.tokens.input >= 0 && r.total === usage.total_tokens;
  });
}
