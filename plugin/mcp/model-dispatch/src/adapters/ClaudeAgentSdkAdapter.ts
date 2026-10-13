/**
 * ClaudeAgentSdkAdapter — routes an Anthropic call through the Claude Agent
 * SDK (`@anthropic-ai/claude-agent-sdk`), the Claude Code harness as a
 * library, instead of spawning `claude -p` and parsing its stdout.
 *
 * Why this exists beside ClaudeCliAdapter: the two reach the same wallets by
 * the same three doors (ANTHROPIC_API_KEY, Vertex, the claude.ai seat — the
 * SDK inherits the bridge's environment exactly as the spawned binary did),
 * but the SDK hands back as typed objects what the CLI adapter had to
 * reconstruct from disk. The `usage` on each assistant message carries the
 * cache-write TTL split and the request modifiers (speed, service_tier,
 * inference_geo) that claudeCliLedger currently hunts for by session id under
 * `~/.claude/projects`. Same ledger, same prices, one less filesystem race.
 *
 * What is deliberately NOT changed from the CLI adapter, so a cost study can
 * compare the two transports packet for packet:
 *  - One query() per packet, no session reuse. A resumed session's result
 *    carries the session's whole spend restored from its transcript, so
 *    per-packet booking of `total_cost_usd` would double-count; reuse is a
 *    separate change that has to book deltas instead.
 *  - No tools and one turn. The CLI adapter's `claude -p` is a one-shot
 *    completion; giving Opus the harness's built-in Read/Write/Edit/Bash
 *    would let the judgment tier edit the workspace directly, which the
 *    write contract does not allow. Turning tools on is a deliberate,
 *    separate decision.
 *  - The prompt is the same concatenation of stable block and user prompt.
 *    Lifting the stable block into `systemPrompt` would cache better and is
 *    worth doing, but it moves tokens between buckets and so would make this
 *    transport's numbers incomparable with the CLI's.
 *
 * Cost: priced from the worker's own token ledger against the dated price
 * list (claudeCliLedger.ts), exactly as the CLI adapter is. The SDK's
 * `total_cost_usd` is a client-side estimate from a price table bundled with
 * the SDK, so it is kept beside the cost as `cli_reported_cost_usd` and a
 * warning is logged when the two differ by more than 0.5%.
 */

import type { AttemptRecord, DispatchWallet, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { estimateTokens } from "../pricing.js";
import { log } from "../log.js";
import { unenforcedBudget, type ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";
import { DispatchPricer, systemClock, unpricedRefusal, type Clock } from "./dispatchPricer.js";
import { claudeDispatchWallet, reportedProviders, type ClaudeDispatchFacts } from "./dispatchWallet.js";
import {
  ModelWriteAccumulator,
  priceClaudeCliResult,
  type ClaudeCliResultLike,
  type TranscriptModelWrites,
  type WorkerLedger,
} from "./claudeCliLedger.js";

/**
 * Under DEFAULT_TOOL_TIMEOUT_MS (driverClient.ts), so the adapter stops a slow
 * call and books its usage before the client abandons the dispatch.
 */
export const DEFAULT_TIMEOUT_SEC = 1740;

/**
 * The slice of the SDK's surface this adapter uses. Declared structurally
 * rather than imported as a type so the adapter can be unit-tested with a
 * hand-built async iterable and never needs the real SDK in the test path.
 */
export interface AgentSdkMessage {
  type: string;
  subtype?: string;
  /** Assistant frames: the Messages API message, with `id`, `model`, `usage`, `stop_reason`. */
  message?: any;
  /** Set on subagent frames; null on the main loop. */
  parent_tool_use_id?: string | null;
  [key: string]: unknown;
}

export type AgentSdkQuery = (args: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<AgentSdkMessage>;

interface ClaudeAgentSdkOptions {
  /** Injected in tests; defaults to the real SDK's `query`, imported lazily. */
  queryFn?: AgentSdkQuery;
  timeoutSec?: number;
  /** Clock for the dispatch date the price is looked up on; tests pin it. */
  now?: Clock;
  /** Working directory handed to the SDK. Defaults to the bridge's own. */
  cwd?: string;
  /** Read for the wallet stamp only, never handed to the SDK; tests pin it. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * The `query()` options for a model entry. Pure so the pins are assertable
 * without running a query — the same reason run.mjs keeps buildAgyArgs pure.
 *
 * `tools: []` is what actually disables the built-in toolset. NOT
 * `allowedTools: []` — that is an auto-approve list, so an empty one leaves
 * Read/Write/Edit/Bash present and merely un-approved, which would both put
 * the workspace within Opus's reach and hang the run on a permission prompt
 * nobody can answer. With no tools at all, no prompt can occur, so no
 * `permissionMode` override (and no `allowDangerouslySkipPermissions`) is
 * needed.
 *
 * `settingSources: []` keeps the worker hermetic: without it the SDK loads
 * the user's and project's CLAUDE.md and settings, which would make a
 * dispatch's token count depend on whose machine it ran on. That is a
 * departure from `claude -p`, which does load them, and it is the one
 * intentional difference — it removes a confound from the measurement rather
 * than adding one.
 *
 * `title` is set because without it the SDK generates a session title from
 * the first user message on a side call to Haiku: the whole prompt in, a few
 * tokens out, once per dispatch, on a model the policy never named.
 *
 * `env` is deliberately never set: the SDK REPLACES the subprocess
 * environment when it is, rather than merging, and inheriting is exactly how
 * this adapter reaches all three Claude wallets (key, Vertex, seat) without
 * knowing which one is configured.
 *
 * No output cap and no `maxBudgetUsd`: judgment output is left uncapped, and
 * the attempt says so through unenforcedBudget(). Adding either here means
 * the attempt must report it instead. The run-wide limit is the bridge's
 * `hard_cost_cap_usd` check (runCostCap.ts).
 */
export function agentSdkOptions(
  config: Pick<ModelConfig, "model_name" | "reasoning">,
  extra: { cwd?: string; abortController?: AbortController } = {},
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    model: config.model_name,
    // One-shot completion, matching `claude -p` as this tier uses it.
    maxTurns: 1,
    tools: [],
    settingSources: [],
    title: "mmo dispatch",
  };
  const effort = config.reasoning?.effort;
  // Haiku 4.5 rejects an effort level; the policy omits `reasoning` there.
  if (effort) options.effort = effort;
  if (extra.cwd) options.cwd = extra.cwd;
  if (extra.abortController) options.abortController = extra.abortController;
  return options;
}

/** Lazily imported so a policy that never names this adapter does not load the SDK. */
async function realQuery(): Promise<AgentSdkQuery> {
  const mod: any = await import("@anthropic-ai/claude-agent-sdk");
  return mod.query as AgentSdkQuery;
}

export class ClaudeAgentSdkAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private cachedSystem = "";
  private readonly queryFn?: AgentSdkQuery;
  private readonly timeoutMs: number;
  private readonly cwd?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly pricer: DispatchPricer;

  constructor(config: ModelConfig, options: ClaudeAgentSdkOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.queryFn = options.queryFn;
    this.timeoutMs = (options.timeoutSec ?? config.worker_timeout_sec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.pricer = new DispatchPricer(config, options.now ?? systemClock);
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const started = Date.now();
    // Priced on the day the dispatch starts. A worker whose own model has no
    // price is never run: its dollars could not be reported.
    const dispatchDate = this.pricer.now();
    const primary = this.pricer.price(dispatchDate);
    if (primary.unpriced) {
      return this.failure(
        packet,
        { input: 0, input_cached: 0, output: 0 },
        started,
        unpricedRefusal(this.modelConfig, dispatchDate, primary.reason),
        claudeDispatchWallet(this.env),
      );
    }

    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);
    const prompt = stableBlock ? `${stableBlock}\n\n${userPrompt}` : userPrompt;

    const run = await this.runQuery(prompt);
    if (!run.ok && run.writes.size > 0) return this.partial(packet, run, started, dispatchDate);
    if (!run.ok) {
      return this.failure(
        packet,
        { input: estimateTokens(prompt), input_cached: 0, output: 0 },
        started,
        run.error,
        claudeDispatchWallet(this.env, run.init),
      );
    }

    const { result, writes } = run;
    // `subtype === "success"` is the SDK's success signal, as it is the
    // CLI's; every other subtype (error_during_execution, error_max_turns,
    // error_max_budget_usd, ...) is a failure, and a result with no subtype
    // at all lands on the error side — absence of the signal is not success.
    const isError = result.is_error === true || result.subtype !== "success";

    // An errored call still billed its tokens, so it is priced the same way.
    const ledger = this.ledgerFor(result, writes, dispatchDate);
    const attemptTokens = ledger.tokens;
    const cost = ledger.cost_usd;
    const latency = result.duration_api_ms ?? result.duration_ms ?? Date.now() - started;
    const stopReason = result.stop_reason ?? undefined;
    const hitOutputCap = stopReason === "max_tokens";

    const attempt: AttemptRecord = {
      attempt_number: 1,
      ...unenforcedBudget(packet),
      stop_reason: stopReason,
      hit_output_cap: hitOutputCap,
      tokens: attemptTokens,
      cost_usd: cost,
      latency_ms: latency,
      success: !isError,
      error: isError ? result.result ?? result.subtype ?? "claude-agent-sdk error" : undefined,
      ...(ledger.price_basis ? { price_basis: ledger.price_basis } : {}),
      unpriced_models: ledger.unpriced_models,
      ...(ledger.cli_reported_cost_usd !== undefined
        ? { cli_reported_cost_usd: ledger.cli_reported_cost_usd }
        : {}),
      // The share of cost_usd the worker's own transcript explains — the same
      // share a post-run collector scan of that transcript will count, and so
      // the share it must subtract (review finding M4). The SDK still writes
      // the session transcript, so the collector's arithmetic is unchanged.
      ...(ledger.transcript_logged_cost_usd !== undefined
        ? { transcript_logged_cost_usd: ledger.transcript_logged_cost_usd }
        : {}),
      ttl_split: ledger.ttl_split,
      per_model: ledger.per_model,
      wallet: claudeDispatchWallet(this.env, { ...run.init, providers: reportedProviders(result.modelUsage) }),
    };

    if (isError) {
      return {
        result: null,
        tokens: attemptTokens,
        cost_usd: cost,
        latency_ms: latency,
        cache_hit: attemptTokens.input_cached > 0,
        success: false,
        error: attempt.error,
        attempts: [attempt],
        terminal_reason: "vendor_error",
      };
    }

    const text = (result.result ?? "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const stripped = text.replace(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/, "$1").trim();
      try {
        parsed = JSON.parse(stripped);
      } catch {
        parsed = { raw: text };
      }
    }

    return {
      result: parsed,
      tokens: attemptTokens,
      cost_usd: cost,
      latency_ms: latency,
      cache_hit: attemptTokens.input_cached > 0,
      success: true,
      attempts: [attempt],
      terminal_reason: "success",
    };
  }

  /**
   * Price the result from its ledger and log what a reader must know: a
   * policy block that differs from the list, a billed model with no price,
   * and an SDK figure more than 0.5% away from the list's.
   */
  private ledgerFor(
    result: ClaudeCliResultLike,
    writes: Map<string, TranscriptModelWrites>,
    dispatchDate: Date,
  ): WorkerLedger {
    const ledger = priceClaudeCliResult(result, {
      config: this.modelConfig,
      date: dispatchDate,
      transcript: writes,
    });

    this.pricer.logWarnings(ledger.warnings);
    for (const u of ledger.unpriced_models) {
      log("warn", "pricing.unpriced", { model_id: this.id, model: u.model, reason: u.reason });
    }
    if (ledger.cli_mismatch) {
      const m = ledger.cli_mismatch;
      log("warn", "pricing.cli_cost_mismatch", {
        model_id: this.id,
        cli_usd: m.cli_usd,
        list_usd: m.list_usd,
        delta_pct: m.delta_pct,
        ttl_split: ledger.ttl_split,
        models: m.models.length ? m.models.join(",") : undefined,
        message:
          "The Agent SDK's own dollar figure differs from the price list by more than 0.5%. " +
          "cost_usd uses the list; the SDK figure is kept as cli_reported_cost_usd. The SDK " +
          "prices from a table bundled at build time, so it drifts when the list moves or when " +
          "it does not recognise the model (its modelUsage[*].costBasis says which table it used).",
      });
    }
    return ledger;
  }

  /**
   * A call stopped before its result message (a timeout, an abort, a crash)
   * after the stream had reported usage. Each assistant frame's usage is what
   * the API billed for that message, so those tokens are priced through the
   * same ledger a result would use; a message cut off mid-stream counts the
   * output it had reached.
   */
  private partial(
    packet: TaskPacket,
    run: { error: string; init: ClaudeDispatchFacts; writes: Map<string, TranscriptModelWrites> },
    started: number,
    dispatchDate: Date,
  ): ExecutionResult {
    const modelUsage: Record<string, any> = {};
    for (const [model, w] of run.writes) {
      modelUsage[model] = {
        inputTokens: w.logged.input,
        cacheReadInputTokens: w.logged.input_cached,
        cacheCreationInputTokens: w.write_5m + w.write_1h,
        outputTokens: w.logged.output,
        webSearchRequests: w.logged.web_search_requests,
      };
    }
    const ledger = this.ledgerFor({ modelUsage }, run.writes, dispatchDate);
    const latency = Date.now() - started;
    const attempt: AttemptRecord = {
      attempt_number: 1,
      ...unenforcedBudget(packet),
      hit_output_cap: false,
      tokens: ledger.tokens,
      cost_usd: ledger.cost_usd,
      latency_ms: latency,
      success: false,
      error: run.error,
      usage_from_frames: true,
      ...(ledger.price_basis ? { price_basis: ledger.price_basis } : {}),
      unpriced_models: ledger.unpriced_models,
      ttl_split: ledger.ttl_split,
      per_model: ledger.per_model,
      wallet: claudeDispatchWallet(this.env, run.init),
    };
    return {
      result: null,
      tokens: ledger.tokens,
      cost_usd: ledger.cost_usd,
      latency_ms: latency,
      cache_hit: ledger.tokens.input_cached > 0,
      success: false,
      error: run.error,
      attempts: [attempt],
      terminal_reason: "vendor_error",
    };
  }

  /** A call that billed nothing measurable: refused before running, or no result was produced. */
  private failure(
    packet: TaskPacket,
    tokens: { input: number; input_cached: number; output: number },
    started: number,
    error: string,
    wallet: DispatchWallet,
  ): ExecutionResult {
    const attempt: AttemptRecord = {
      attempt_number: 1,
      ...unenforcedBudget(packet),
      hit_output_cap: false,
      tokens,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      success: false,
      error,
      wallet,
    };
    return {
      result: null,
      tokens,
      cost_usd: 0,
      latency_ms: attempt.latency_ms,
      cache_hit: false,
      success: false,
      error,
      attempts: [attempt],
      terminal_reason: "vendor_error",
    };
  }

  /**
   * Drive one query() to its result message, accumulating the per-model
   * cache-write and modifier facts from the assistant frames as they arrive,
   * and the credential source from the init frame.
   *
   * Every assistant frame is counted, subagent frames included, because the
   * result's `modelUsage` — which the ledger prices — also includes them.
   * Counting only the main loop here would leave a subagent's cache writes
   * with no TTL split and silently price them all at the 5-minute rate.
   */
  private async runQuery(
    prompt: string,
  ): Promise<
    | { ok: true; result: ClaudeCliResultLike & { subtype?: string; is_error?: boolean; duration_ms?: number; duration_api_ms?: number; stop_reason?: string | null }; writes: Map<string, TranscriptModelWrites>; init: ClaudeDispatchFacts }
    | { ok: false; error: string; init: ClaudeDispatchFacts; writes: Map<string, TranscriptModelWrites> }
  > {
    let query: AgentSdkQuery;
    try {
      query = this.queryFn ?? (await realQuery());
    } catch (err: any) {
      return {
        ok: false,
        error:
          `ClaudeAgentSdkAdapter could not load @anthropic-ai/claude-agent-sdk for model ` +
          `'${this.modelConfig.id}': ${err?.message ?? err}. Run \`npm ci\` in ` +
          `plugin/mcp/model-dispatch.`,
        init: {},
        writes: new Map(),
      };
    }

    const acc = new ModelWriteAccumulator();
    // Fallback only for a result frame with no text. Concatenating every turn
    // would prepend tool-loop narration to the final JSON and break parsing.
    let lastText = "";
    let lastTextId: string | null = null;
    let init: ClaudeDispatchFacts = {};
    const abortController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.timeoutMs);
    timer.unref?.();

    try {
      const stream = query({
        prompt,
        options: agentSdkOptions(this.modelConfig, { cwd: this.cwd, abortController }),
      });
      for await (const message of stream) {
        if (message.type === "system" && message.subtype === "init") {
          init = {
            apiKeySource: typeof message.apiKeySource === "string" ? message.apiKeySource : undefined,
            claudeCodeVersion: typeof message.claude_code_version === "string" ? message.claude_code_version : undefined,
          };
          continue;
        }
        if (message.type === "assistant") {
          const msg = message.message;
          const frameText = Array.isArray(msg?.content)
            ? msg.content
                .filter((part: any) => part?.type === "text" && typeof part.text === "string")
                .map((part: any) => part.text)
                .join("")
            : "";
          if (frameText) {
            const id = typeof msg.id === "string" ? msg.id : null;
            lastText = id !== null && id === lastTextId ? lastText + frameText : frameText;
            lastTextId = id;
          }
          const usage = msg?.usage;
          if (!usage || msg.model === "<synthetic>") continue;
          acc.add(
            String(msg.model ?? "(unlabeled)"),
            usage,
            msg.stop_reason,
            typeof msg.id === "string" ? msg.id : null,
          );
          continue;
        }
        if (message.type === "result") {
          const result =
            typeof message.result === "string" && message.result.trim() ? message : { ...message, result: lastText };
          return { ok: true, result: result as any, writes: acc.finish(), init };
        }
      }
      // The stream ended without a result message: a crash or an abort. The
      // frames already seen are the usage to book; execute() prices them.
      return {
        ok: false,
        error: timedOut
          ? `claude-agent-sdk timeout after ${this.timeoutMs / 1000}s`
          : "claude-agent-sdk stream ended with no result message",
        init,
        writes: acc.finish(),
      };
    } catch (err: any) {
      if (timedOut) return { ok: false, error: `claude-agent-sdk timeout after ${this.timeoutMs / 1000}s`, init, writes: acc.finish() };
      return { ok: false, error: `claude-agent-sdk error: ${err?.message ?? err}`, init, writes: acc.finish() };
    } finally {
      clearTimeout(timer);
    }
  }
}
