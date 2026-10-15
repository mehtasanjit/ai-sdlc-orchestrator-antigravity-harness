/**
 * The driver's price on a day, from the bridge's dated price list — the same
 * lookup every dispatched model goes through. The `driver:` block's card is
 * a declaration checked against the list, not the price: it was written for
 * one period (Gemini 3.8 Flash's introductory card ends 2026-12-31), and a
 * run after that period must be billed the list's next card.
 * `pricing_override: true` on the block bills the block instead, labelled custom.
 */
import { effectivePrice } from "../../mcp/model-dispatch/dist/effectivePrice.js";

/**
 * `{ pricing, basis, period, warnings }`, or `{ unpriced: true, reason }`.
 * `name` prices another model on the same day, from the list only: the
 * block's card and its override are the pinned model's.
 */
export function driverPrice(driverBlock, date, name = driverBlock.model_name) {
  const r = effectivePrice(
    { id: "driver", model_name: driverBlock.model_name, pricing: driverBlock.pricing, pricing_override: driverBlock.pricing_override === true },
    date,
    {},
    name,
  );
  if (r.unpriced) return { unpriced: true, reason: r.reason, warnings: r.warnings };
  const period = r.period ? { from: r.period.from, to: r.period.to, source_url: r.period.source_url, verified: r.period.verified } : null;
  return { unpriced: false, pricing: r.pricing, basis: r.basis, period, warnings: r.warnings };
}

/**
 * The modeled lines no card priced, as `[{ model, calls, reason }]` per model,
 * `reason` joining each distinct one. Such a line carries `unpriced`, the reason.
 */
export function unpricedCalls(lines) {
  const groups = new Map();
  for (const e of lines) {
    if (!e.unpriced) continue;
    const g = groups.get(e.model) ?? { model: e.model ?? null, calls: 0, reasons: new Set() };
    g.calls += 1;
    g.reasons.add(typeof e.unpriced === "string" ? e.unpriced : "no price");
    groups.set(e.model, g);
  }
  return [...groups.values()].map(({ reasons, ...g }) => ({ ...g, reason: [...reasons].join("; ") }));
}

export function unpricedDriverRefusal(model, day, reason) {
  return `run: the driver model '${model}' has no price on ${day}: ${reason}. The modeled driver line could not be priced, so the run is refused before agy starts.`;
}
