/**
 * ModelAdapter — every model implements this so the orchestrator can call
 * any of them uniformly.
 */

import type { AttemptRecord, ExecutionResult, ModelConfig, RunContext, TaskPacket } from "../types.js";

/**
 * Attempt fields for an adapter that hands the vendor no output cap and no
 * spend limit. Reporting the packet's budget as `ceiling_used` would claim a
 * limit that never held.
 */
export function unenforcedBudget(
  packet: Pick<TaskPacket, "budget">,
): Pick<AttemptRecord, "ceiling_used" | "budget_enforced" | "budget_declared"> {
  return { ceiling_used: null, budget_enforced: false, budget_declared: packet.budget.maxOutputTokens };
}

export interface ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;

  /**
   * Execute one TaskPacket. `cacheContext` keys an optional context cache
   * (Gemini). `runContext` says WHERE the run is happening — ignored by
   * completion adapters; required by adapters that delegate to an agent.
   */
  execute(
    packet: TaskPacket,
    cacheContext?: string,
    runContext?: RunContext,
  ): Promise<ExecutionResult>;
}

export type AdapterFactory = (config: ModelConfig) => ModelAdapter;
