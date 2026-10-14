/**
 * The policy's `hard_cost_cap_usd`, enforced before each dispatch from the
 * run's own telemetry.jsonl.
 */

import { existsSync, readFileSync } from "node:fs";

export interface RunCostCapCheck {
  allowed: boolean;
  cap_usd: number;
  /** Sum of `cost_usd` over the file's dispatched events. */
  spent_usd: number;
  events_counted: number;
  /** Lines that are not JSON. Their cost is not in `spent_usd`. */
  unreadable_lines: number;
}

/**
 * `tier: "orchestrator"` lines are left out: they are the post-run collector's
 * reconstruction of the driver session, not spend this bridge dispatched.
 */
export function evaluateRunCostCap(capUsd: number, telemetryLines: string[]): RunCostCapCheck {
  let spent = 0;
  let counted = 0;
  let unreadable = 0;
  for (const line of telemetryLines) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    if (!ev || typeof ev !== "object" || ev.tier === "orchestrator") continue;
    if (typeof ev.cost_usd === "number" && Number.isFinite(ev.cost_usd)) spent += ev.cost_usd;
    counted += 1;
  }
  return {
    allowed: spent < capUsd,
    cap_usd: capUsd,
    spent_usd: spent,
    events_counted: counted,
    unreadable_lines: unreadable,
  };
}

/**
 * Null when there is nothing to check: the policy sets no cap, or the
 * dispatch names no telemetry file to count from. A file that does not exist
 * yet is a run that has spent nothing.
 */
export function checkRunCostCap(
  capUsd: number | undefined,
  telemetryPath: string | undefined,
): RunCostCapCheck | null {
  if (capUsd === undefined || !telemetryPath) return null;
  const lines = existsSync(telemetryPath) ? readFileSync(telemetryPath, "utf-8").split("\n") : [];
  return evaluateRunCostCap(capUsd, lines);
}

export function runCostCapRefusal(check: RunCostCapCheck, telemetryPath: string): string {
  return (
    `execute_with_model: refused. The run has spent $${check.spent_usd.toFixed(4)} across ` +
    `${check.events_counted} dispatched event(s) in ${telemetryPath}, at or above the policy's ` +
    `hard_cost_cap_usd of $${check.cap_usd.toFixed(2)}. No model was called, and every further ` +
    `dispatch that logs to this file is refused.`
  );
}
