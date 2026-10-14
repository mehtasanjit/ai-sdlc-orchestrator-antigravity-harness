/**
 * What the driver line must carry beside its figure: the bounds while check
 * 16 (usage across a resume) is pending and the two readings differ, a flag
 * when the launch resumed a conversation without the earlier record, and the
 * invocations that reported no usage. Empty when the figure stands alone.
 */
export function driverRange(driverUsage) {
  if (!driverUsage) return {};
  const pending = driverUsage.resume_check?.state === "pending";
  const differs = pending && driverUsage.cost_usd_low !== driverUsage.cost_usd_high;
  const missing = driverUsage.invocations_without_usage ?? [];
  return {
    ...(differs ? { cost_usd_low: driverUsage.cost_usd_low, cost_usd_high: driverUsage.cost_usd_high } : {}),
    ...(differs && driverUsage.tokens_low ? { tokens_low: driverUsage.tokens_low } : {}),
    ...(pending && driverUsage.resumed_without_earlier_record ? { resumed_without_earlier_record: true } : {}),
    ...(differs || (pending && driverUsage.resumed_without_earlier_record) ? { resume_check: driverUsage.resume_check } : {}),
    ...(missing.length ? { invocations_without_usage: missing } : {}),
  };
}

/** The same facts as sentences, for the manifest basis and the CLI line. */
export function driverRangeNotes(driverUsage) {
  const r = driverRange(driverUsage);
  const notes = [];
  const missing = r.invocations_without_usage;
  if (r.cost_usd_low !== undefined) {
    notes.push(
      `range $${r.cost_usd_low}–$${r.cost_usd_high}: check ${r.resume_check.check} (usage across a resume) is pending, the figure is the per-invocation reading` +
        (missing ? "" : ", the upper bound"),
    );
  }
  if (r.resumed_without_earlier_record) {
    notes.push(`this launch resumed a conversation without the earlier launch's record; whether its counters include that launch is check ${r.resume_check.check}, pending`);
  }
  if (missing) notes.push(`invocation(s) ${missing.join(", ")} reported no usage, so the true figure may be higher`);
  return notes;
}

export function driverRangeNote(driverUsage) {
  const notes = driverRangeNotes(driverUsage);
  return notes.length ? `; ${notes.join("; ")}` : "";
}
