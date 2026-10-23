/**
 * AgyCliAdapter — routes a Gemini completion call through the local `agy -p`
 * subprocess (`--output-format stream-json`), so a Google Antigravity (`agy`)
 * subscription seat backs the mechanical tier instead of GEMINI_API_KEY or
 * Vertex ADC.
 *
 * Per docs/verification/p1-agy-runtime.md:
 *   - Check 8: `stream-json` emits `{"event":"result","result":{status,response,usage,...}}`.
 *   - Check 14: Effort/tier is baked into the model slug (`gemini-3.8-flash-low`).
 *   - Check 17: Token layout is `cache-outside-total+thinking-in-output`:
 *     `input_tokens` = fresh input, `cache_read_tokens` = cached input (disjoint),
 *     `output_tokens` = total output (includes `thinking_tokens`).
 *   - Check 1 (1.3.5): Running `agy -p` in `os.tmpdir()` avoids loading workspace
 *     plugins/MCP servers/hooks inside a leaf completion call.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";

import type { AttemptRecord, DispatchWallet, ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import { unenforcedBudget, type ModelAdapter } from "./ModelAdapter.js";
import { splitStableFromDynamic } from "./BuiltinAnthropicAdapter.js";
import { DispatchPricer, geminiRates, systemClock, unpricedRefusal, type Clock } from "./dispatchPricer.js";

type SpawnFn = typeof spawn;
type VersionProbe = () => void;

const DEFAULT_TIMEOUT_SEC = 300;

export interface AgyCliOptions {
  spawnFn?: SpawnFn;
  probeBinary?: VersionProbe;
  timeoutSec?: number;
  cwd?: string;
  now?: Clock;
}

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyResultPayload {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
}

/**
 * Derive the `agy --model <slug>` argument from `ModelConfig`.
 * Check 14: `agy` bakes effort (`low` | `medium` | `high`) into the slug for
 * Gemini 3.6/3.7/3.8 Flash and 3.1 Pro (e.g. `gemini-3.8-flash-low`).
 */
export function agyModelSlug(config: Pick<ModelConfig, "model_name" | "reasoning">): string {
  const base = config.model_name;
  if (/-(low|medium|high)$/.test(base)) return base;
  const rawLevel = config.reasoning?.effort ?? config.reasoning?.tier;
  const level =
    rawLevel === "minimal" || rawLevel === "low"
      ? "low"
      : rawLevel === "medium"
        ? "medium"
        : rawLevel === "high" || rawLevel === "max"
          ? "high"
          : undefined;
  return level ? `${base}-${level}` : base;
}

export function agyCliArgs(config: Pick<ModelConfig, "model_name" | "reasoning">, prompt = ""): string[] {
  return [
    "--print",
    prompt,
    "--output-format",
    "stream-json",
    "--model",
    agyModelSlug(config),
    "--dangerously-skip-permissions",
  ];
}

export function agySeatWallet(): DispatchWallet {
  return { name: "agy-seat", source: "transport" };
}

/** Strip optional markdown ```json ... ``` fences before JSON.parse. */
export function parseJsonOrRaw(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* fall through */
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        /* fall through */
      }
    }
    return { raw: trimmed };
  }
}

export class AgyCliAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private cachedSystem = "";
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private readonly pricer: DispatchPricer;

  constructor(config: ModelConfig, options: AgyCliOptions = {}) {
    this.id = config.id;
    this.modelConfig = config;
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = (options.timeoutSec ?? config.worker_timeout_sec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    this.cwd = options.cwd ?? tmpdir();
    this.pricer = new DispatchPricer(config, options.now ?? systemClock);

    const probe =
      options.probeBinary ??
      (() => {
        execFileSync("agy", ["--version"], { stdio: "pipe" });
      });
    try {
      probe();
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new Error(
          `AgyCliAdapter needs the \`agy\` binary on PATH for model '${config.id}'. ` +
            `Install Antigravity CLI or add ~/.local/bin to PATH.`,
        );
      }
      throw new Error(
        `AgyCliAdapter could not probe \`agy --version\` for model '${config.id}': ${err?.message ?? err}`,
      );
    }
  }

  async primeCache(_cacheKey: string, header: string): Promise<void> {
    this.cachedSystem = header;
  }

  setSystemCache(text: string): void {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const started = Date.now();
    const dispatchDate = this.pricer.now();
    const price = this.pricer.price(dispatchDate);
    if (price.unpriced) {
      return this.failure(
        packet,
        { input: 0, input_cached: 0, output: 0 },
        started,
        unpricedRefusal(this.modelConfig, dispatchDate, price.reason),
      );
    }
    const rates = geminiRates(price.pricing);

    const { stableBlock, userPrompt } = splitStableFromDynamic(packet, this.cachedSystem);
    const guardInstruction =
      "IMPORTANT: Do NOT call any tools, do NOT read or write files, and do NOT run shell commands. " +
      "Answer directly in a single turn with ONLY the requested valid JSON object.";
    const prompt = [guardInstruction, stableBlock, userPrompt].filter(Boolean).join("\n\n");

    const run = await this.runAgyCli(prompt);
    if (!run.ok) {
      return this.failure(packet, { input: estimateTokens(prompt), input_cached: 0, output: 0 }, started, run.error);
    }

    const res = run.result;
    const status = String(res.status ?? "").toUpperCase();
    const isError = status !== "SUCCESS" && status !== "OK";

    // Check 17 layout: cache-outside-total + thinking-in-output
    const usage = res.usage ?? {};
    const attemptTokens = {
      input: usage.input_tokens ?? estimateTokens(prompt),
      input_cached: usage.cache_read_tokens ?? 0,
      output: usage.output_tokens ?? estimateTokens(res.response ?? ""),
      ...(usage.thinking_tokens !== undefined ? { output_reasoning: usage.thinking_tokens } : {}),
    };
    const cost = computeCostUsd(attemptTokens, rates);
    const latency = res.duration_seconds ? Math.round(res.duration_seconds * 1000) : Date.now() - started;

    const attempt: AttemptRecord = {
      attempt_number: 1,
      ...unenforcedBudget(packet),
      stop_reason: status || undefined,
      hit_output_cap: false,
      tokens: attemptTokens,
      cost_usd: cost,
      latency_ms: latency,
      success: !isError,
      error: isError ? res.error || `agy-cli status=${res.status ?? "unknown"}` : undefined,
      price_basis: price.basis,
      wallet: agySeatWallet(),
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

    const parsed = parseJsonOrRaw(res.response ?? "");
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

  private failure(
    packet: TaskPacket,
    tokens: { input: number; input_cached: number; output: number },
    started: number,
    error: string,
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
      wallet: agySeatWallet(),
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

  private runAgyCli(
    prompt: string,
  ): Promise<{ ok: true; result: AgyResultPayload } | { ok: false; error: string }> {
    return new Promise((resolveRun) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn("agy", agyCliArgs(this.modelConfig, prompt), {
          cwd: this.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        resolveRun({ ok: false, error: `agy-cli spawn failed: ${err?.message ?? err}` });
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (outcome: Awaited<ReturnType<typeof this.runAgyCli>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun(outcome);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
        finish({ ok: false, error: `agy-cli timeout after ${this.timeoutMs / 1000}s` });
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev && ev.event === "result" && ev.result) {
              try {
                child.kill("SIGTERM");
              } catch {
                /* ignore */
              }
              finish({ ok: true, result: ev.result as AgyResultPayload });
              return;
            }
          } catch {
            /* ignore partial or non-JSON lines */
          }
        }
      });
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (err) => {
        finish({ ok: false, error: `agy-cli process error: ${err.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        let lastResult: AgyResultPayload | null = null;
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev && ev.event === "result" && ev.result) {
              lastResult = ev.result as AgyResultPayload;
            }
          } catch {
            /* ignore non-JSON lines */
          }
        }
        if (lastResult) {
          finish({ ok: true, result: lastResult });
          return;
        }
        finish({
          ok: false,
          error: `agy-cli exited ${code} without a result event. stderr: ${stderr.trim() || "none"}. stdout head: ${stdout.slice(0, 200)}`,
        });
      });
    });
  }
}
