/**
 * The ways agy's five usage counters can nest. Whether `input_tokens` holds
 * the cache reads and whether `output_tokens` holds the thinking is not
 * documented for agy (p1-agy-runtime.md check 17); `total_tokens` decides.
 * Dependency-free so tools/p1/check16.mjs can read a live result before the
 * bridge is built.
 */
export const TOKEN_READINGS = {
  "cache-in-input+thinking-apart": { cacheInInput: true, thinkingInOutput: false },
  "cache-in-input+thinking-in-output": { cacheInInput: true, thinkingInOutput: true },
  "cache-apart+thinking-apart": { cacheInInput: false, thinkingInOutput: false },
  "cache-apart+thinking-in-output": { cacheInInput: false, thinkingInOutput: true },
};

/** The reading that bills the most: nothing subtracted, thinking added. */
export const DEAREST_READING = "cache-apart+thinking-apart";

/** `{ tokens: {input, input_cached, output}, total }` for `usage` under one reading. */
export function tokensUnder(usage, name) {
  const { cacheInInput, thinkingInOutput } = TOKEN_READINGS[name];
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
    total: input + (cacheInInput ? 0 : cached) + output + (thinkingInOutput ? 0 : thinking),
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
