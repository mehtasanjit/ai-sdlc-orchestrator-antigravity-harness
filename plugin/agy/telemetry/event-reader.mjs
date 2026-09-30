/**
 * Reader for `agy --print … --output-format stream-json`.
 *
 * Every line is `{"event": "init" | "step_update" | "result", ...}`. The
 * `result` envelope (observed verbatim on this machine, p1-agy-runtime.md
 * check 8) carries `usage{input_tokens, output_tokens, thinking_tokens,
 * cache_read_tokens, total_tokens}` and is cumulative within one process.
 * Whether it stays cumulative when `run.mjs` resumes the conversation in a
 * new process is check 16, see RESUME_USAGE.
 *
 * No event carries a timestamp; this reader stamps its own arrival clock.
 */

import { computeCostUsd } from "../../mcp/model-dispatch/dist/pricing.js";

/**
 * How `usage` behaves across `--print --conversation <id>`, which starts a new
 * agy process on the same conversation: "cumulative" (the new process reports
 * the conversation's running total) or "per-invocation" (counters restart).
 * Check 16; flip `state` only in the commit that records the live result.
 * While pending, a multi-invocation run is priced under both readings: the
 * true figure lies between them, and the per-invocation reading is the upper
 * bound the driver line carries.
 */
export const RESUME_USAGE = { check: 16, state: "pending" };
export const RESUME_READINGS = new Set(["cumulative", "per-invocation"]);

export function parseEventStream(jsonlText, now = () => new Date().toISOString(), invocation = null) {
  const events = [];
  for (const line of String(jsonlText ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    events.push(invocation === null ? { ts: now(), ...raw } : { ts: now(), ...raw, invocation });
  }
  return events;
}

/** One stdout per agy process, in launch order; events carry `invocation` 1..n. */
export function parseInvocations(stdouts, now = () => new Date().toISOString()) {
  return stdouts.flatMap((text, i) => parseEventStream(text, now, i + 1));
}

/** The conversation id to resume with `--conversation`, from `init` or `result`. */
export function conversationIdFrom(events) {
  for (const ev of events) {
    const id = ev.conversation_id ?? ev.session_id ?? ev.result?.conversation_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

const USAGE_KEYS = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];

function usageDelta(current, previous) {
  const out = {};
  for (const k of USAGE_KEYS) out[k] = Math.max(0, (current?.[k] ?? 0) - (previous?.[k] ?? 0));
  return out;
}

/**
 * A result whose counters are all zero reports no usage. That is the shape
 * check 8 recorded for a failed call (`status: "ERROR"`, empty conversation
 * id), and it must not become the baseline a later result is differenced
 * against.
 */
export function reportsUsage(result) {
  return Boolean(result?.usage) && USAGE_KEYS.some((k) => (result.usage[k] ?? 0) > 0);
}

function maxUsage(a, b) {
  const out = {};
  for (const k of USAGE_KEYS) out[k] = Math.max(a?.[k] ?? 0, b?.[k] ?? 0);
  return out;
}

/**
 * One usage block per result that reports usage, in stream order. Each
 * conversation keeps its own baseline, the running maximum of its cumulative
 * counters; a result is differenced against its conversation's baseline, and
 * a result with no conversation id stands alone. Under the "per-invocation"
 * reading every new process starts with no baselines. Events without an
 * `invocation` tag count as one process.
 */
export function extractTurnUsage(events, { resume = "cumulative" } = {}) {
  if (!RESUME_READINGS.has(resume)) throw new Error(`extractTurnUsage: resume reading '${resume}' is not one of ${[...RESUME_READINGS].join(", ")}.`);
  const usages = [];
  const baselines = new Map();
  let lastInvocation;
  let index = 0;
  for (const ev of events) {
    if (ev.event !== "result" || !reportsUsage(ev.result)) continue;
    index += 1;
    const conversation = ev.result.conversation_id || null;
    const invocation = ev.invocation ?? null;
    if (resume === "per-invocation" && invocation !== lastInvocation) baselines.clear();
    lastInvocation = invocation;
    const cumulative = ev.result.usage;
    const previous = conversation ? baselines.get(conversation) ?? null : null;
    usages.push({ turn_index: index, invocation, conversation_id: conversation, usage: usageDelta(cumulative, previous), cumulative });
    if (conversation) baselines.set(conversation, maxUsage(previous, cumulative));
  }
  return usages;
}

/**
 * One `provenance: "modeled"` event per result, priced from the driver
 * block's card. Thinking tokens bill at the output rate; `cache_read_tokens`
 * at `input_cached`; `input_tokens` is taken as inclusive of cache reads and
 * split so nothing is priced twice.
 *
 * `tier: "orchestrator"` so buildManifest partitions these out of dispatched
 * sums if the file is ever concatenated with telemetry.jsonl.
 */
export function modeledDriverCostEvents(events, opts) {
  const { pass, model, pricing, policyName = null, billingMode = "seat", resume = "cumulative", now = () => new Date().toISOString() } = opts;
  return extractTurnUsage(events, { resume }).map(({ turn_index, invocation, usage }) => {
    const cached = usage.cache_read_tokens ?? 0;
    const thinking = usage.thinking_tokens ?? 0;
    const tokens = {
      input: Math.max(0, (usage.input_tokens ?? 0) - cached),
      input_cached: cached,
      output: (usage.output_tokens ?? 0) + thinking,
    };
    return {
      ts: now(),
      pass,
      phase: "driver_loop",
      task_type: "conductor",
      task_id: `driver-turn-${turn_index}`,
      module: "driver",
      model,
      tier: "orchestrator",
      provenance: "modeled",
      billing_mode: billingMode,
      routed_by: "manual",
      routing: {
        policy_name: policyName,
        policy_version: 1,
        rule_index: -1,
        rule_reason:
          "driver loop cost — never dispatched through execute_with_model; modeled from agy stream-json result usage at the driver block's card",
      },
      input_tokens: tokens.input,
      input_tokens_cached: tokens.input_cached,
      output_tokens: tokens.output,
      output_tokens_reasoning: thinking,
      cost_usd: computeCostUsd(tokens, pricing),
      latency_ms: null,
      success: true,
      retry_count: 0,
      invocation,
      usage_reading: resume,
    };
  });
}

const sumCost = (events) => Math.round(events.reduce((s, e) => s + e.cost_usd, 0) * 1e6) / 1e6;
const sumTokens = (events) => ({
  input_tokens: events.reduce((s, e) => s + e.input_tokens, 0),
  input_tokens_cached: events.reduce((s, e) => s + e.input_tokens_cached, 0),
  output_tokens: events.reduce((s, e) => s + e.output_tokens, 0),
});

/**
 * The driver line for a run of one or more agy processes. `modeled` is what
 * driver-cost-modeled.jsonl records, under check 16's reading (the upper
 * bound while it is pending); the `_low`/`_high` fields price the same
 * results under both readings. `invocations` is the per-process evidence.
 *
 * A process with no result that reports usage (no `result` line, or only
 * check 8's all-zero error envelope) is named in `invocations_without_usage`:
 * its tokens are in no per-invocation figure. `resumedFirst` marks a launch
 * whose first process resumed a conversation without the earlier launch's
 * record, where check 16 decides whether its counters include that launch.
 */
export function driverUsage(events, opts, { invocations = [], resumeUsage = RESUME_USAGE, resumedFirst = false } = {}) {
  const low = modeledDriverCostEvents(events, { ...opts, resume: "cumulative" });
  const high = modeledDriverCostEvents(events, { ...opts, resume: "per-invocation" });
  const reading = resumeUsage.state === "pending" ? "per-invocation" : resumeUsage.state;
  if (!RESUME_READINGS.has(reading)) throw new Error(`driverUsage: check ${resumeUsage.check} state '${resumeUsage.state}' is not pending, cumulative or per-invocation.`);
  const modeled = reading === "cumulative" ? low : high;

  const perInvocation = invocations.map((inv, i) => {
    const all = events.filter((e) => e.invocation === i + 1 && e.event === "result");
    const usable = all.filter((e) => reportsUsage(e.result));
    const lastRaw = all.at(-1)?.result ?? null;
    const last = usable.at(-1)?.result ?? null;
    return {
      invocation: i + 1,
      exit_status: inv.status ?? null,
      wall_ms: inv.wall_ms ?? null,
      result_events: usable.length,
      results_without_usage: all.length - usable.length,
      last_status: lastRaw?.status ?? null,
      conversation_id: last?.conversation_id || null,
      num_turns: last?.num_turns ?? null,
      duration_seconds: last?.duration_seconds ?? null,
      cumulative_usage: last?.usage ?? null,
    };
  });
  const missing = perInvocation.filter((p) => p.result_events === 0).map((p) => p.invocation);

  return {
    modeled,
    summary: {
      resume_check: { check: resumeUsage.check, state: resumeUsage.state },
      reading,
      cost_usd: sumCost(modeled),
      cost_usd_low: sumCost(low),
      cost_usd_high: sumCost(high),
      tokens_low: sumTokens(low),
      tokens_high: sumTokens(high),
      invocations: perInvocation,
      invocations_without_usage: missing,
      ...(resumedFirst ? { resumed_without_earlier_record: true } : {}),
    },
  };
}

/** Tool calls the conductor made, for the human-readable trajectory. */
export function extractToolCalls(events) {
  const calls = [];
  for (const ev of events) {
    if (ev.event !== "step_update") continue;
    const step = ev.step ?? ev.step_update ?? ev;
    const name = step?.tool_call?.name ?? step?.toolCall?.name ?? step?.tool_name ?? step?.type;
    if (typeof name !== "string") continue;
    calls.push({ ts: ev.ts, name, step_idx: step?.step_idx ?? step?.stepIdx ?? null });
  }
  return calls;
}
