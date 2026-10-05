/**
 * The driver line's bounds while check 16 (usage across a resume) is pending,
 * and the invocations that reported no usage. Empty for a one-invocation run
 * with every usage reported, where the two readings agree.
 */
export function driverRange(driverUsage) {
  if (!driverUsage) return {};
  const pending = driverUsage.resume_check?.state === "pending" && driverUsage.cost_usd_low !== driverUsage.cost_usd_high;
  const missing = driverUsage.invocations_without_usage ?? [];
  return {
    ...(pending ? { cost_usd_low: driverUsage.cost_usd_low, cost_usd_high: driverUsage.cost_usd_high, resume_check: driverUsage.resume_check } : {}),
    ...(missing.length ? { invocations_without_usage: missing } : {}),
  };
}

export function driverRangeNote(driverUsage) {
  const r = driverRange(driverUsage);
  const notes = [];
  if (r.cost_usd_low !== undefined) notes.push(`upper bound: resumed invocations priced as fresh counters, check ${r.resume_check.check} pending; lower bound $${r.cost_usd_low}`);
  if (r.invocations_without_usage) notes.push(`invocation(s) ${r.invocations_without_usage.join(", ")} reported no usage and are missing`);
  return notes.length ? `; ${notes.join("; ")}` : "";
}
