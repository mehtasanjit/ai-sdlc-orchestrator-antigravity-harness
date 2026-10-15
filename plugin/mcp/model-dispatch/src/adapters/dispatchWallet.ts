/**
 * Which wallet a dispatch billed, decided from what the adapter saw while it
 * ran. Pure, so the mapping is unit-testable without a vendor call.
 */

import type { DispatchWallet } from "../types.js";
import type { GeminiBackend } from "./geminiEndpoint.js";

type Env = Record<string, string | undefined>;
type ClaudeArm = NonNullable<DispatchWallet["arm"]>;

/** Claude Code reads its boolean switches (CLAUDE_CODE_USE_VERTEX) this way. */
function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** `apiKeySource` values that mean a metered Anthropic API key paid; "/login managed key" is a Console key. */
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

const CLAUDE_WALLET: Record<ClaudeArm, DispatchWallet["name"]> = {
  A: "anthropic",
  B: "gcp",
  seat: "claude-seat",
  unknown: null,
};

export interface ClaudeDispatchFacts {
  /** The Agent SDK init frame's `apiKeySource`; absent when no init frame was seen. */
  apiKeySource?: string;
  claudeCodeVersion?: string;
  /** Every `modelUsage[*].provider` the result reported. */
  providers?: string[];
}

export function reportedProviders(modelUsage: unknown): string[] {
  if (!modelUsage || typeof modelUsage !== "object") return [];
  const out = new Set<string>();
  for (const usage of Object.values(modelUsage as Record<string, any>)) {
    if (typeof usage?.provider === "string") out.add(usage.provider);
  }
  return [...out];
}

function claudeArm(env: Env, facts: ClaudeDispatchFacts): { arm: ClaudeArm; source: "reported" | "env" } {
  const providers = facts.providers ?? [];
  if (providers.length > 1) return { arm: "unknown", source: "reported" };
  const provider = providers[0];
  if (provider === "vertex") return { arm: "B", source: "reported" };
  if (provider !== undefined && provider !== "firstParty") return { arm: "unknown", source: "reported" };
  if (provider === undefined && truthy(env.CLAUDE_CODE_USE_VERTEX)) return { arm: "B", source: "env" };

  const keySource = facts.apiKeySource;
  if (keySource !== undefined) {
    if (API_KEY_SOURCES.has(keySource)) return { arm: "A", source: "reported" };
    if (keySource === "oauth") return { arm: "seat", source: "reported" };
    // A bearer token also reports "none", and it is not a claude.ai seat.
    if (keySource === "none" && !env.ANTHROPIC_AUTH_TOKEN) return { arm: "seat", source: "reported" };
    return { arm: "unknown", source: "reported" };
  }
  // `claude -p --output-format json` prints no init frame, so a first-party
  // call with no key exported may be the seat or an apiKeyHelper: unsettled.
  if (env.ANTHROPIC_API_KEY) return { arm: "A", source: "env" };
  return { arm: "unknown", source: "env" };
}

/** A Claude adapter's wallet: the bridge's environment at dispatch, overruled by whatever Claude Code reported. */
export function claudeDispatchWallet(env: Env, facts: ClaudeDispatchFacts = {}): DispatchWallet {
  const { arm, source } = claudeArm(env, facts);
  const providers = facts.providers ?? [];
  return {
    name: CLAUDE_WALLET[arm],
    source,
    arm,
    ...(facts.apiKeySource !== undefined ? { api_key_source: facts.apiKeySource } : {}),
    ...(providers.length ? { api_provider: providers.join(",") } : {}),
    ...(facts.claudeCodeVersion ? { claude_code_version: facts.claudeCodeVersion } : {}),
    ...(arm === "B" ? { project: env.ANTHROPIC_VERTEX_PROJECT_ID, region: env.CLOUD_ML_REGION } : {}),
  };
}

export function geminiDispatchWallet(backend: GeminiBackend, location: string): DispatchWallet {
  return { name: backend === "api-key" ? "gemini-api-key" : "gcp", source: "transport", backend, location };
}
