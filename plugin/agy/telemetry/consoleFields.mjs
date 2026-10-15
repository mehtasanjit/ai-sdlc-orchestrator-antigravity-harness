/**
 * The manifest fields the studies console (ai-studies-console) reads from a
 * harness run: `harness.worker_cost_usd`, `harness.driver_work` and the
 * cable's display strings, which it renders verbatim. Every figure comes from
 * this run's cost lines and events. Cash and modeled dollars stay in separate
 * fields; nothing here adds one to the other.
 */

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const count = (n) => Number(n ?? 0).toLocaleString("en-US");

export const WORKER_SDK = "model-dispatch";
export const WORKER_SDK_LABEL = "model-dispatch bridge";

/** Worker dollars by kind: a mixed Claude line splits at its seat share; unclassified lines are cash. */
export function workerCostSplit(lines) {
  let cash = 0;
  let modeled = 0;
  for (const l of lines.filter((x) => x.line !== "driver")) {
    if (l.kind === "modeled") modeled += l.cost_usd;
    else if (l.kind === "mixed") {
      modeled += l.seat_modeled_usd ?? 0;
      cash += l.cost_usd - (l.seat_modeled_usd ?? 0);
    } else cash += l.cost_usd;
  }
  return { cash_usd: r6(cash), modeled_usd: r6(modeled) };
}

function workerLegs(dispatched) {
  const via = new Map();
  for (const e of dispatched) {
    if (!e.model || e.provenance === "none") continue;
    if (!via.has(e.model)) via.set(e.model, new Set());
    via.get(e.model).add(e.adapter ?? "adapter not recorded");
  }
  return [...via].map(([model, adapters]) => `${model} via ${[...adapters].join(" + ")}`);
}

const GEMINI_WALLET_TEXT = { gcp: "Vertex AI on Google Cloud (ADC)", "gemini-api-key": "Gemini API key", mixed: "more than one wallet (see cost.lines)" };

function workerTransport(lines, claudeAuth) {
  const parts = [];
  for (const l of lines) {
    if (l.line === "driver" || !l.calls) continue;
    if (l.line === "claude_worker") parts.push(`Claude: ${claudeAuth ?? "wallet not recorded"}`);
    else if (l.line === "gemini_workers") parts.push(`Gemini: ${GEMINI_WALLET_TEXT[l.wallet] ?? "wallet not recorded"}`);
    else parts.push(`${l.line.replace("_", " ")}: counted as cash`);
  }
  return parts.length ? parts.join(" · ") : "no worker dispatches";
}

function workerCostBasis(lines, split) {
  const cashLines = lines.filter((l) => l.line !== "driver" && l.calls && l.kind !== "modeled")
    .map((l) => `${l.line.replace("_", " ")} $${l.kind === "mixed" ? r6(l.cost_usd - (l.seat_modeled_usd ?? 0)) : l.cost_usd}`);
  const cash = cashLines.length
    ? `CASH: ${cashLines.join(" + ")}, priced by the bridge from each dispatch's own token counts; dollars a vendor invoices.`
    : "CASH: no worker dispatch billed a vendor.";
  const modeled = split.modeled_usd
    ? ` The Claude worker's claude.ai seat calls, $${split.modeled_usd}, are MODELED (Anthropic card, no invoice) and are in worker_cost_usd_modeled, not here.`
    : "";
  return `${cash}${modeled} The driver's figure is a different kind of dollar and is not added to either.`;
}

const WHAT_THE_DRIVER_SPENT_ON =
  "orchestration: reading the brief and each worker result, composing TaskPackets for the model-dispatch bridge, " +
  "running the approval gates, and writing the run record (gates.jsonl, SUMMARY.md). Work it did itself is listed in " +
  "harness.unrecorded_phases and harness.conductor_edits.";

/**
 * `cable` keys to merge into `harness.cable`, and top-level `harness` keys.
 * `harness` is the block manifest.mjs built: its cable, conductor_edits and
 * unrecorded_phases are read, never changed.
 */
export function studiesConsoleFields({ lines, dispatched, pin, harness }) {
  const driver = lines.find((l) => l.line === "driver");
  const measured = driver.kind !== "unmeasured";
  const split = workerCostSplit(lines);
  const legs = workerLegs(dispatched);
  const billed = dispatched.filter((e) => e.model && e.provenance !== "none").length;
  const cable = harness.cable;
  const prompt = (driver.input_tokens ?? 0) + (driver.input_tokens_cached ?? 0);
  const tokensRead = `It read ${count(prompt)} prompt tokens (${count(driver.input_tokens_cached)} of them cache reads) and wrote ` +
    `${count(driver.output_tokens)} (${count(driver.thinking_tokens)} of them thinking) over ${count(driver.calls)} model call(s)`;
  const edits = harness.conductor_edits;
  const editsText = edits
    ? `harness.conductor_edits counts ${edits.edited} planned file(s) whose final content differs from the last worker result and ${edits.unplanned?.length ?? 0} file(s) no packet planned`
    : "harness.conductor_edits could not compare the files with the worker results";
  const phases = harness.unrecorded_phases ?? [];

  return {
    cable: {
      driver_display: `${cable.driver_runtime} · ${pin ? `${pin.model}${pin.effort ? ` (${pin.effort})` : ""}` : "driver model not pinned"} · ${cable.driver_auth}`,
      worker_sdk: WORKER_SDK,
      worker_sdk_label: WORKER_SDK_LABEL,
      worker_display: `via ${WORKER_SDK_LABEL} (MCP) → ${legs.length ? legs.join(", ") : "no dispatches"}`,
      worker_transport: workerTransport(lines, cable.claude_worker_auth),
      handoff_note: `The conductor hands each phase's model call to the ${WORKER_SDK_LABEL} as a TaskPacket: ` +
        `${billed} dispatched event(s) across ${legs.length} worker model(s). It keeps agy's file-edit tools and writes ` +
        `each worker's returned content to disk itself, so its typing is checked, not barred: ${editsText}, and ` +
        `harness.unrecorded_phases names ${phases.length} judgment phase(s) with no telemetry row.`,
      driver_cost_note: measured
        ? `The driver's dollar figure is MODELED, not invoiced. Driver auth: ${cable.driver_auth}. agy reports token ` +
          `counts and never a cost, so the harness priced them; driver_cost_basis names the card. ${tokensRead}. ` +
          (driver.incomplete
            ? `It is a floor, not the whole figure: ${driver.unpriced_calls.map((u) => `${u.calls} call(s) on ${u.model}`).join(", ")} have no price on the list, so their dollars are in no figure. `
            : "") +
          "The worker dollars are a different kind and are not added to it."
        : "The driver side of this run has NO dollar figure: no agy usage was captured (no headless launcher record and no " +
          "collect-driver-usage.mjs record), so the $0 beside it means unmeasured, not free. The worker dollars stand on their own.",
      billing_note: `Driver: ${cable.driver_auth}, ${measured ? "modeled" : "not measured"}. Workers: ${workerTransport(lines, cable.claude_worker_auth)}. ` +
        `worker_cost_usd is cash a vendor invoices; worker_cost_usd_modeled is Claude seat calls priced at the Anthropic card. ` +
        "Driver, cash and modeled dollars are separate figures and are not summed.",
    },
    harness: {
      worker_cost_usd: split.cash_usd,
      worker_cost_usd_modeled: split.modeled_usd,
      worker_cost_basis: workerCostBasis(lines, split),
      ...(measured && driver.calls > 0
        ? {
            driver_work: {
              turns: driver.calls,
              input_tokens: prompt,
              input_tokens_cached: driver.input_tokens_cached ?? 0,
              output_tokens: driver.output_tokens ?? 0,
              thinking_tokens: driver.thinking_tokens ?? 0,
              what_it_spent_on: WHAT_THE_DRIVER_SPENT_ON,
            },
          }
        : {}),
    },
  };
}
