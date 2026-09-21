/**
 * Reader for `agy --print … --output-format stream-json`.
 *
 * Every line is `{"event": "init" | "step_update" | "result", ...}`. The
 * `result` envelope (observed verbatim on this machine, p1-agy-runtime.md
 * check 8) carries `usage{input_tokens, output_tokens, thinking_tokens,
 * cache_read_tokens, total_tokens}` and is cumulative per session, so a
 * resumed session's later results are differenced against the earlier one.
 *
 * No event carries a timestamp; this reader stamps its own arrival clock.
 */

import { computeCostUsd } from "../../mcp/model-dispatch/dist/pricing.js";

export function parseEventStream(jsonlText, now = () => new Date().toISOString()) {
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
    events.push({ ts: now(), ...raw });
  }
  return events;
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
 * One usage block per `result` event, in stream order. Consecutive results
 * of the same conversation are cumulative and get differenced; a result for
 * a different (or unknown) conversation starts a fresh baseline.
 */
export function extractTurnUsage(events) {
  const usages = [];
  let previous = null;
  let previousConversation = null;
  let index = 0;
  for (const ev of events) {
    if (ev.event !== "result" || !ev.result?.usage) continue;
    index += 1;
    const conversation = ev.result.conversation_id || null;
    const sameSession = conversation && conversation === previousConversation;
    const cumulative = ev.result.usage;
    const usage = sameSession ? usageDelta(cumulative, previous) : { ...usageDelta(cumulative, null) };
    usages.push({ turn_index: index, conversation_id: conversation, usage, cumulative });
    previous = cumulative;
    previousConversation = conversation;
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
  const { pass, model, pricing, policyName = null, billingMode = "seat", now = () => new Date().toISOString() } = opts;
  return extractTurnUsage(events).map(({ turn_index, usage }) => {
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
    };
  });
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
