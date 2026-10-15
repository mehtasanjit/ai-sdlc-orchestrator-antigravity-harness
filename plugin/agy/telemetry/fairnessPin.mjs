/**
 * Fairness-pin assertion for the agy driver.
 *
 * The pin lives in exactly one place: the policy's top-level `driver:` block
 * (docs/verification/p1-agy-runtime.md, findings 2 and 6). It is read from
 * there and never duplicated as constants here.
 *
 * agy bakes the effort into the model slug (`gemini-3.8-flash-high`, check
 * 14), so the launcher derives one slug from `model_name` + `reasoning.effort`
 * and passes no separate `--effort`.
 */

export const EFFORTS = new Set(["low", "medium", "high"]);
export const BILLING_MODES = new Set(["seat", "gemini-api-key"]);

/**
 * Live checks the headless pin depends on (p1-agy-runtime.md, "Pins chosen").
 * Recorded 2026-09-17 on agy 1.2.5. A headless run dispatches through
 * plugin/agy/dispatch.mjs (pattern b), so checks 1 and 5 (the MCP route,
 * ${VAR} in mcp_config.json) do not gate it, even though agy 1.3.5's print
 * mode loads the plugin's MCP server and hooks (check 1, re-checked 2026-10-14). Flip an entry only with the result in the doc.
 */
export const LIVE_PIN_CHECKS = {
  2: "pass", // dispatch.mjs reaches the bridge from a print-mode session, with and without --sandbox
  4: "pass", // print mode expands no skill; the conductor prompt is the headless entry. Interactive name: /mmo:<skill>
  6: "pass", // without --dangerously-skip-permissions run_command is auto-denied, stderr names the allow-rule
  10: "pass", // .agents/plugins/mmo/ is discovered in an interactive session (skills as mmo:*, hooks loaded); .agents/plugins.json was not
};

export function pendingPinChecks(checks = LIVE_PIN_CHECKS) {
  return Object.entries(checks)
    .filter(([, state]) => state !== "pass")
    .map(([n]) => Number(n));
}

/**
 * Passed checks prove the pin can be asserted, not that it held: `verified`
 * also needs a model agy itself recorded conducting the run, every one of
 * them the pin. `observed` is every model name agy reported (the headless
 * stream, the local conversation record); `offPin` the ones that are not the
 * pin (event-reader.mjs offPinModels).
 */
export function pinVerification({ pending = pendingPinChecks(), observed = [], offPin = [] } = {}) {
  if (offPin.length) return { verified: false, unverified_reason: "model_mismatch" };
  if (pending.length) return { verified: false, unverified_reason: "pending_checks" };
  if (!observed.length) return { verified: false, unverified_reason: "no_model_observed" };
  return { verified: true };
}

export function readPin(policy) {
  const d = policy?.driver;
  if (!d) {
    throw new Error(`fairness pin: policy '${policy?.name}' has no top-level driver: block to read the pin from.`);
  }
  if (d.runtime !== "agy") {
    throw new Error(`fairness pin: policy '${policy.name}' driver.runtime is '${d.runtime}', not 'agy'.`);
  }
  const model = d.model_name;
  const effort = d.reasoning?.effort;
  if (!model || !effort) {
    throw new Error(`fairness pin: policy '${policy.name}' driver block is missing model_name or reasoning.effort.`);
  }
  if (!EFFORTS.has(effort)) {
    throw new Error(`fairness pin: driver.reasoning.effort '${effort}' is not one of ${[...EFFORTS].join(", ")} (agy --effort).`);
  }
  const billing = d.billing_mode ?? "seat";
  if (!BILLING_MODES.has(billing)) {
    throw new Error(`fairness pin: driver.billing_mode '${billing}' is not one of ${[...BILLING_MODES].join(", ")}.`);
  }
  for (const k of ["input", "input_cached", "output"]) {
    if (typeof d.pricing?.[k] !== "number") {
      throw new Error(`fairness pin: driver.pricing.${k} is missing — the modeled driver line cannot be priced.`);
    }
  }
  return { model, effort, billing_mode: billing, pricing: d.pricing };
}

/** `gemini-3.8-flash` + `high` → `gemini-3.8-flash-high` (check 14). */
export function driverSlug(pin) {
  return `${pin.model}-${pin.effort}`;
}

export function assertPinnedInvocation(intended, policy) {
  const pin = readPin(policy);
  const slug = driverSlug(pin);
  if (intended.model !== slug) {
    throw new Error(
      `fairness pin violated: about to invoke --model '${intended.model}', but the pinned slug is ` +
        `'${slug}' (plugin/config/policies/${policy.name}.yaml driver block). Aborting rather than ` +
        `running an unpinned, uncomparable pass.`,
    );
  }
  return pin;
}

/**
 * The `result` event is the only place agy reports an error for the whole
 * turn; a rejected model slug lands in `result.error`. This can prove a
 * failure, never a success: success is pinVerification's, from the models
 * agy reported.
 */
export function findPinRejection(events) {
  for (const ev of events) {
    if (ev.event !== "result") continue;
    const message = ev.result?.error ?? (ev.result?.status === "ERROR" ? ev.result?.response : undefined);
    if (typeof message !== "string" || !message) continue;
    if (/model|effort|not (found|available|supported)|unknown|invalid/i.test(message) && /model|effort/i.test(message)) {
      return message;
    }
  }
  return null;
}
