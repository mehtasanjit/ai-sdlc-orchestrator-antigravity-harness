#!/usr/bin/env node
/**
 * The driver line of an interactive run, from agy's local conversation
 * record (telemetry/conversationUsage.mjs). A headless run prices its driver
 * from the stream-json usage run.mjs captured and is refused here.
 *
 * Writes into the run directory:
 *   driver-cost-modeled.jsonl  one modeled line per model call in the run's window
 *   driver-collector.json      the evidence: conversations, window, field map, agy version
 *
 * Usage:
 *   node plugin/agy/collect-driver-usage.mjs <run-dir> [--run-id=<id>] [--project-root=<path>]
 *        [--since=<iso>] [--until=<iso>] [--conversation=<id>[,<id>...]]
 *
 * --since is the time the run started (the skills record it at their first
 * step); without it, the run's `run.start` marker in orchestrator.log, else
 * the run directory's creation time, which is later than the first steps of a
 * brownfield run. --until defaults to the run's `run.end` marker, else now.
 * --project-root defaults to the current directory.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { LOCAL_RECORD_FIELDS, agyHome, collectConversationUsage } from "./telemetry/conversationUsage.mjs";
import { driverPrice, unpricedDriverRefusal } from "./telemetry/driverPrice.mjs";
import { driverSlug, readPin } from "./telemetry/fairnessPin.mjs";
import { offPinModels } from "./telemetry/event-reader.mjs";
import { computeCostUsd } from "../mcp/model-dispatch/dist/pricing.js";
import { resolvePolicy, parseArgs } from "./run.mjs";
import { agyVersion } from "./manifest.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { inferRunId, readRunMarkers } from "./telemetry/runWindow.mjs";

export const RECORD_SOURCE = "agy-local-record";

/** One `provenance: "modeled"` line per model call, in the shape of the headless driver lines. */
export function modeledFromRecord(calls, { pass, pin, driver, policyName }) {
  return calls.map((c, i) => {
    const price = driverPrice(driver, c.at);
    if (price.unpriced) throw new Error(unpricedDriverRefusal(driver.model_name, c.at.slice(0, 10), price.reason));
    const tokens = { input: c.fresh, input_cached: c.cached, output: c.output };
    return {
      ts: c.at,
      pass,
      phase: "driver_loop",
      task_type: "conductor",
      task_id: `driver-call-${i + 1}`,
      module: "driver",
      model: c.model ?? pin.model,
      tier: "orchestrator",
      provenance: "modeled",
      billing_mode: pin.billing_mode,
      routed_by: "manual",
      routing: {
        policy_name: policyName,
        policy_version: 1,
        rule_index: -1,
        rule_reason: "driver loop cost — read from agy's local conversation record and priced at the dated list",
      },
      input_tokens: tokens.input,
      input_tokens_cached: tokens.input_cached,
      output_tokens: tokens.output,
      output_tokens_reasoning: c.thinking,
      cost_usd: computeCostUsd(tokens, price.pricing),
      price_basis: price.basis,
      ...(price.period ? { price_period: price.period } : {}),
      latency_ms: null,
      success: true,
      retry_count: 0,
      usage_source: RECORD_SOURCE,
      conversation_id: c.conversation_id,
      ...(c.at_inferred ? { at_inferred: true } : {}),
    };
  });
}

export async function collectDriverUsage({ runDir, runId, projectRoot, since, until, windowSources = null, conversationIds = null, home = agyHome(), version = null }) {
  if (existsSync(join(runDir, "driver-manifest.json"))) {
    throw new Error(`collect-driver-usage: ${runDir} holds a headless launcher record (driver-manifest.json); its driver line comes from agy's stream, not from this collector.`);
  }
  const resolved = resolvePolicy({ projectRoot });
  const pin = readPin(resolved.policy);
  const { conversations, calls } = await collectConversationUsage({ home, projectRoot, conversationIds, since, until });
  const modeled = modeledFromRecord(calls, { pass: runId, pin, driver: resolved.policy.driver, policyName: resolved.name });
  const models = [...new Set(calls.map((c) => c.model).filter(Boolean))];
  const evidence = {
    source: RECORD_SOURCE,
    run_id: runId,
    policy: resolved.name,
    window: { since, until, ...(windowSources ?? {}) },
    agy_version: version,
    fields_verified_on: LOCAL_RECORD_FIELDS.verified_on,
    ...(version && version !== LOCAL_RECORD_FIELDS.verified_on ? { fields_unverified_for_version: version } : {}),
    conversations,
    calls: calls.length,
    reported_models: models,
    ...(offPinModels(models, pin, driverSlug(pin)).length ? { model_mismatch: offPinModels(models, pin, driverSlug(pin)) } : {}),
    ...(conversations.filter((c) => c.found).length > 1 ? { note: "more than one conversation of this project was active in the window; all are counted as this run's driver" } : {}),
    written_by: "plugin/agy/collect-driver-usage.mjs",
    written_at: new Date().toISOString(),
  };
  return { modeled, evidence };
}

function runStart(runDir) {
  const st = statSync(runDir);
  const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
  return new Date(born).toISOString();
}

/** The window to read agy's record over, and where each end came from. */
export function collectionWindow({ runDir, runId, since = null, until = null, now = () => new Date().toISOString() }) {
  const markers = readRunMarkers(runDir, runId);
  return {
    since: since ?? markers.start ?? runStart(runDir),
    until: until ?? markers.end ?? now(),
    sources: {
      since_from: since ? "--since" : markers.start ? "run.start" : "run folder created",
      until_from: until ? "--until" : markers.end ? "run.end" : "collection time",
    },
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "");
  if (!runDir || !existsSync(runDir)) {
    console.error("Usage: node plugin/agy/collect-driver-usage.mjs <run-dir> [--run-id=<id>] [--project-root=<path>] [--since=<iso>] [--until=<iso>] [--conversation=<id>]");
    process.exit(2);
  }
  try {
    const projectRoot = resolve(args["project-root"] ?? process.cwd());
    const telemetry = existsSync(join(runDir, "telemetry.jsonl"))
      ? readFileSync(join(runDir, "telemetry.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const runId = args["run-id"] ?? inferRunId(runDir, telemetry) ?? runDir.split("/").pop();
    const { since, until, sources } = collectionWindow({ runDir, runId, since: typeof args.since === "string" ? args.since : null, until: typeof args.until === "string" ? args.until : null });
    const conversationIds = typeof args.conversation === "string" ? args.conversation.split(",").filter(Boolean) : null;
    const { modeled, evidence } = await collectDriverUsage({ runDir, runId, projectRoot, since, until, windowSources: sources, conversationIds, version: agyVersion() });
    writeFileSync(join(runDir, "driver-collector.json"), JSON.stringify(evidence, null, 2) + "\n");
    if (!modeled.length) {
      // An earlier collection's lines are not this window's: a re-collect that finds nothing leaves none behind.
      const stale = join(runDir, "driver-cost-modeled.jsonl");
      if (existsSync(stale) && readFileSync(stale, "utf8").split("\n").filter(Boolean).every((l) => { try { return JSON.parse(l).usage_source === RECORD_SOURCE; } catch { return false; } })) rmSync(stale);
      console.log(`collect-driver-usage: no agy model calls for ${projectRoot} between ${since} and ${until}; the driver line stays NOT MEASURED.`);
      process.exit(0);
    }
    writeFileSync(join(runDir, "driver-cost-modeled.jsonl"), modeled.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const usd = Math.round(modeled.reduce((s, e) => s + e.cost_usd, 0) * 1e6) / 1e6;
    console.log(`collect-driver-usage: ${modeled.length} driver call(s) from ${evidence.conversations.filter((c) => c.found).length} conversation(s) — driver modeled $${usd}`);
    if (evidence.model_mismatch) console.error(`collect-driver-usage: agy recorded model(s) ${evidence.model_mismatch.join(", ")}, not the pinned driver.`);
    if (evidence.fields_unverified_for_version) console.error(`collect-driver-usage: the record's field map was read on agy ${LOCAL_RECORD_FIELDS.verified_on}; this is agy ${evidence.fields_unverified_for_version}. Every row still passed the layout check.`);
  } catch (err) {
    console.error(`collect-driver-usage failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
