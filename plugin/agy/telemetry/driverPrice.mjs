/**
 * The driver's price on a day, from the bridge's dated price list — the same
 * lookup every dispatched model goes through. The `driver:` block's card is
 * a declaration checked against the list, not the price: it was written for
 * one period (Gemini 3.8 Flash's introductory card ends 2026-12-31), and a
 * run after that period must be billed the list's next card.
 * `pricing_override: true` on the block bills the block instead, labelled custom.
 */
import { effectivePrice } from "../../mcp/model-dispatch/dist/effectivePrice.js";

/** `{ pricing, basis, period, warnings }`, or `{ unpriced: true, reason }`. */
export function driverPrice(driverBlock, date) {
  const r = effectivePrice(
    { id: "driver", model_name: driverBlock.model_name, pricing: driverBlock.pricing, pricing_override: driverBlock.pricing_override === true },
    date,
  );
  if (r.unpriced) return { unpriced: true, reason: r.reason, warnings: r.warnings };
  const period = r.period ? { from: r.period.from, to: r.period.to, source_url: r.period.source_url, verified: r.period.verified } : null;
  return { unpriced: false, pricing: r.pricing, basis: r.basis, period, warnings: r.warnings };
}

export function unpricedDriverRefusal(model, day, reason) {
  return `run: the driver model '${model}' has no price on ${day}: ${reason}. The modeled driver line could not be priced, so the run is refused before agy starts.`;
}
