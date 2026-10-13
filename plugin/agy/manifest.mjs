#!/usr/bin/env node
/**
 * Code-written manifest.json for a run directory.
 *
 * Reads what the run left behind — telemetry.jsonl (the bridge's ledger),
 * driver-cost-modeled.jsonl and driver-manifest.json (the launcher's), and
 * policy_snapshot.yaml — and writes manifest.json in the bridge's
 * buildManifest shape plus a `harness` block. The model's own manifest, if it
 * wrote one, is advisory and is left where it is.
 *
 * Three cost lines, labeled, never summed into one figure:
 *   driver   modeled  — agy stream-json usage × the driver card
 *   gemini   cash     — bridge events for Gemini models
 *   claude   cash     — bridge events for the Claude worker (claude-agent-sdk / claude-cli;
 *                      arm A: Anthropic; arm B: GCP; modeled on the claude.ai seat)
 *
 * Each worker line's wallet comes from the `wallet` the bridge stamped on its
 * events at dispatch. Only events without one fall back to the environment of
 * the shell running this script, and the line says so.
 *
 * Usage: node manifest.mjs <run-dir> [--policy=<name>] [--run-id=<id>] [--agy-version=<v>]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { buildManifest } from "../mcp/model-dispatch/dist/telemetry.js";
import { resolveGeminiBackend } from "../mcp/model-dispatch/dist/adapters/geminiEndpoint.js";
import { readPin, driverSlug, pendingPinChecks } from "./telemetry/fairnessPin.mjs";
import { driverRange, driverRangeNote, driverRangeNotes } from "./telemetry/driverRange.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { conductorWork } from "./telemetry/conductorWork.mjs";
import { inferRunId, readGates, readRunMarkers, runOutcome, sessionWindow } from "./telemetry/runWindow.mjs";

export const HARNESS_NAME = "antigravity";
export const RUNTIME_NAME = "antigravity-cli";
// 2: session_window, dispatch_window, harness.status, harness.gate_mode, harness.gates as gates.jsonl lines.
export const MANIFEST_SCHEMA = 2;

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;

export const ENV_AT_MANIFEST_TIME = "env at manifest time";

const PROVIDER_SOURCE_BY_ARM = { A: "anthropic-api", B: "vertex", seat: "claude-seat" };

const truthy = (value) => value !== undefined && ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());

/**
 * The Claude wallet the manifest writer's environment points at: the
 * fallback for events the bridge did not stamp. That environment need not be
 * the one the run dispatched from.
 */
export function claudeWallet(env = process.env, login = null) {
  const vertex = truthy(env.CLAUDE_CODE_USE_VERTEX);
  if (vertex && env.ANTHROPIC_API_KEY) {
    return { arm: null, wallet: null, provider_source: null, project: null, region: null,
      note: "CLAUDE_CODE_USE_VERTEX and ANTHROPIC_API_KEY are both set in the environment writing the manifest, so it cannot say which Claude wallet paid" };
  }
  if (vertex) return { arm: "B", wallet: "gcp", provider_source: "vertex", project: env.ANTHROPIC_VERTEX_PROJECT_ID ?? null, region: env.CLOUD_ML_REGION ?? null };
  if (env.ANTHROPIC_API_KEY) return { arm: "A", wallet: "anthropic", provider_source: "anthropic-api", project: null, region: null };
  // The seat: Claude Code signed in to claude.ai. No invoice — the line is modeled.
  if (login?.loggedIn && login.method === "claude.ai") return { arm: "seat", wallet: "claude-seat", provider_source: "claude-seat", project: null, region: null, subscription: login.subscription ?? null };
  return { arm: null, wallet: null, provider_source: null, project: null, region: null };
}

/** The Gemini door the manifest writer's environment points at, by the bridge's own precedence. */
export function geminiDoor(policy, env = process.env) {
  const select = env.MMO_SELECT ?? env.SDLC_SELECT ?? "";
  const chosen = /gemini-flash=([^,\s]+)/.exec(select)?.[1] ?? policy?.select?.["gemini-flash"]?.default ?? null;
  let backend = "vertex-adc";
  try { backend = resolveGeminiBackend({ env, keyEnvName: "GEMINI_API_KEY", adcFileExists: false }).backend; } catch { /* no credentials: the bridge would not have started */ }
  const wallet = chosen === "flash-agsdk-worker" || backend === "vertex-adc" ? "gcp" : "gemini-api-key";
  return { leaf: chosen, wallet };
}

/**
 * The wallet one event paid from: the bridge's stamp, else the fallback. A
 * stamp that names no wallet falls back too: a `claude -p` call with no key
 * exported cannot tell the seat from an apiKeyHelper.
 */
export function walletOf(event, fallback) {
  const stamp = event.wallet;
  if (stamp?.name) return { wallet: stamp.name, arm: stamp.arm ?? null, project: stamp.project ?? null, region: stamp.region ?? null, source: "events" };
  return { wallet: fallback.wallet ?? null, arm: fallback.arm ?? null, project: fallback.project ?? null, region: fallback.region ?? null, subscription: fallback.subscription ?? null, source: ENV_AT_MANIFEST_TIME };
}

/**
 * A worker line's wallet fields, from each event's own wallet. `wallets[]`
 * splits the line when its events used more than one; `mixed_wallets` flags a
 * worker (policy leaf) whose own events disagree.
 */
export function lineWallet(events, fallback, { withArm = false } = {}) {
  if (!events.length) return { wallet: null, ...(withArm ? { arm: null } : {}), wallet_source: "no dispatches" };
  const groups = new Map();
  const byWorker = new Map();
  const sources = new Set();
  for (const e of events) {
    const w = walletOf(e, fallback);
    if (!groups.has(w.wallet)) {
      groups.set(w.wallet, {
        wallet: w.wallet,
        ...(withArm ? { arm: w.arm } : {}),
        ...(withArm && w.arm === "B" ? { project: w.project, region: w.region } : {}),
        ...(withArm && w.arm === "seat" && w.subscription ? { subscription: w.subscription } : {}),
        calls: 0, cost_usd: 0, sources: new Set(),
      });
    }
    const g = groups.get(w.wallet);
    g.calls += 1;
    g.cost_usd += e.cost_usd ?? 0;
    g.sources.add(w.source);
    sources.add(w.source);
    const worker = e.model_id ?? e.model;
    if (!byWorker.has(worker)) byWorker.set(worker, new Set());
    byWorker.get(worker).add(w.wallet);
  }
  const sourceOf = (set) => ["events", ENV_AT_MANIFEST_TIME].filter((s) => set.has(s)).join(" + ");
  const wallets = [...groups.values()].map(({ sources: from, cost_usd, ...g }) => ({ ...g, cost_usd: r6(cost_usd), wallet_source: sourceOf(from) }));
  const mixed = [...byWorker].filter(([, set]) => set.size > 1).map(([worker, set]) => ({ worker, wallets: [...set] }));
  const { calls, cost_usd, wallet_source, ...single } = wallets[0];
  return {
    ...(wallets.length === 1 ? single : { wallet: "mixed", ...(withArm ? { arm: "mixed" } : {}) }),
    wallet_source: sourceOf(sources),
    ...(wallets.length > 1 ? { wallets } : {}),
    ...(mixed.length ? { mixed_wallets: mixed } : {}),
    ...(fallback.note && sources.has(ENV_AT_MANIFEST_TIME) ? { wallet_note: fallback.note } : {}),
  };
}

const seatText = (subscription) => `claude.ai ${subscription ? `${subscription} ` : ""}seat`;

/** `cable.claude_worker_auth`: how the Claude worker authenticated, in words. */
export function claudeWorkerAuth(line) {
  const one = (w) => w.arm === "B" ? `Vertex on GCP project ${w.project ?? "?"} (${w.region ?? "?"})`
    : w.arm === "A" ? "Anthropic API key"
    : w.arm === "seat" ? `${seatText(w.subscription)} (OAuth) — not the metered API`
    : null;
  if (line.arm !== "mixed") return one(line);
  return `mixed: ${line.wallets.map((w) => one(w) ?? "wallet unknown").join(" + ")}`;
}

/** `cable.summary`: the adapter each worker model went through, as its events recorded it. */
export function cableSummary(dispatched) {
  const via = new Map();
  for (const e of dispatched) {
    if (!e.model || e.provenance === "none") continue;
    if (!via.has(e.model)) via.set(e.model, new Set());
    via.get(e.model).add(e.adapter ?? "adapter not recorded");
  }
  const legs = [...via].map(([model, adapters]) => `${model} via ${[...adapters].join(" + ")}`);
  return `${RUNTIME_NAME} driver → model-dispatch bridge (${legs.length ? legs.join(", ") : "no dispatches"})`;
}

/**
 * Adapters that dispatch a Claude worker, and so put their model's dollars on
 * the Claude cost line. Mirrors the bridge's adapter registry
 * (plugin/mcp/model-dispatch/src/adapters/index.ts), which is the source of
 * truth; the two trees do not import each other. An adapter missing from
 * both sets lands on the `unclassified` line, never on a worker's.
 */
export const CLAUDE_WORKER_ADAPTERS = new Set(["claude-agent-sdk", "claude-cli"]);
export const GEMINI_WORKER_ADAPTERS = new Set(["mcp:model-dispatch", "antigravity-worker"]);

/**
 * The cost line one bridge event belongs to, from what the event itself
 * recorded: its adapter, else its leaf or model in the policy, else the
 * vendor prefix of its model name. Interactive runs leave no policy
 * snapshot and events older than the adapter stamp carry none, so the name
 * is the last word for them.
 */
export function workerLineOf(event, policy = null) {
  const models = policy?.models ?? [];
  const adapter = event.adapter
    ?? (event.model_id != null ? models.find((m) => m.id === event.model_id)?.adapter : undefined)
    ?? (event.model != null ? models.find((m) => m.model_name === event.model)?.adapter : undefined);
  if (adapter) {
    if (CLAUDE_WORKER_ADAPTERS.has(adapter)) return "claude_worker";
    if (GEMINI_WORKER_ADAPTERS.has(adapter)) return "gemini_workers";
    return "unclassified";
  }
  if (/^claude-/.test(event.model)) return "claude_worker";
  if (/^gemini-/.test(event.model)) return "gemini_workers";
  return "unclassified";
}

/** The three lines. `dispatched` are bridge events (no orchestrator tier). */
/**
 * The basis an interactive run's driver line carries. The wording matches the
 * studies console's convention for an unmeasured driver ($0, "NOT MEASURED",
 * "unmeasured, never free"), so the dashboard never reads the $0 as free.
 */
export const UNMEASURED_DRIVER_BASIS =
  "NOT MEASURED: no headless launcher record (driver-manifest.json) and no driver-collector record (plugin/agy/collect-driver-usage.mjs reads an interactive run's calls from agy's local conversation record), so the conductor's tokens are in no figure — unmeasured, never free";

export function costLines({ dispatched, modeled, policy, pin, env = process.env, login = null, wallet = claudeWallet(env, login), driverUsage = null, driverMeasured = modeled.length > 0 || driverUsage != null }) {
  const sum = (events) => ({
    cost_usd: r6(events.reduce((s, e) => s + (e.cost_usd ?? 0), 0)),
    calls: events.length,
    input_tokens: events.reduce((s, e) => s + (e.input_tokens ?? 0), 0),
    input_tokens_cached: events.reduce((s, e) => s + (e.input_tokens_cached ?? 0), 0),
    output_tokens: events.reduce((s, e) => s + (e.output_tokens ?? 0), 0),
  });
  const billed = dispatched.filter((e) => e.model && e.provenance !== "none");
  const on = (line) => billed.filter((e) => workerLineOf(e, policy) === line);
  const claude = on("claude_worker");
  const gemini = on("gemini_workers");
  const unclassified = on("unclassified");
  const door = geminiDoor(policy, env);
  const claudeWallets = lineWallet(claude, wallet, { withArm: true });
  const seatShare = (claudeWallets.wallets ?? []).filter((w) => w.arm === "seat");
  const claudeKind = claudeWallets.arm === "seat" ? "modeled" : seatShare.length ? "mixed" : "cash";
  const seatUsd = r6(seatShare.reduce((s, w) => s + w.cost_usd, 0));
  const driver = driverMeasured
    ? null
    : { line: "driver", kind: "unmeasured", measured: false, model: pin?.model ?? null, billing_mode: pin?.billing_mode ?? null, basis: UNMEASURED_DRIVER_BASIS, ...sum([]), thinking_tokens: 0 };
  return [
    driver ?? {
      line: "driver",
      kind: "modeled",
      model: pin?.model ?? null,
      billing_mode: pin?.billing_mode ?? null,
      basis: modeled.some((e) => e.usage_source === "agy-local-record")
        ? `MODELED from agy's local conversation record (${modeled.length} model call(s), read by plugin/agy/collect-driver-usage.mjs) at ${driverPriceText(modeled, pin)} (${pin?.billing_mode ?? "seat"}); thinking at the output rate, cache reads at the cached rate`
        : `MODELED from agy stream-json usage at ${driverPriceText(modeled, pin)} (${pin?.billing_mode ?? "seat"}); thinking at the output rate, cache reads at the cached rate${driverRangeNote(driverUsage)}`,
      ...sum(modeled),
      thinking_tokens: modeled.reduce((s, e) => s + (e.output_tokens_reasoning ?? 0), 0),
      ...driverRange(driverUsage),
    },
    { line: "gemini_workers", kind: "cash", ...lineWallet(gemini, { wallet: door.wallet }), leaf: door.leaf, models: [...new Set(gemini.map((e) => e.model))], ...sum(gemini) },
    { line: "claude_worker", kind: claudeKind, ...claudeWallets, models: [...new Set(claude.map((e) => e.model))], ...sum(claude),
      cli_reported_cost_usd: r6(claude.reduce((s, e) => s + (e.cli_reported_cost_usd ?? 0), 0)),
      ...(claudeKind === "modeled" ? { basis: `MODELED: the Claude worker ran on a ${seatText(claudeWallets.subscription)} — tokens priced at the Anthropic card, no invoice exists` } : {}),
      ...(claudeKind === "mixed" ? { seat_modeled_usd: seatUsd, basis: `MIXED: $${seatUsd} of this line ran on a claude.ai seat (modeled, no invoice) and the rest is counted as cash; wallets[] splits it` } : {}) },
    ...(unclassified.length
      ? [{ line: "unclassified", kind: "cash", models: [...new Set(unclassified.map((e) => e.model))], adapters: [...new Set(unclassified.map((e) => e.adapter ?? null))], ...sum(unclassified),
          basis: "UNCLASSIFIED: no known worker adapter or model prefix on these events, so they are on neither worker's line; counted as cash" }]
      : []),
  ];
}

/** Which price the modeled driver turns were billed at, from what each event recorded. */
export function driverPriceText(modeled, pin) {
  const periods = [...new Set(modeled.filter((e) => e.price_period).map((e) => `${e.price_period.from}..${e.price_period.to ?? "open"}`))];
  if (!periods.length) return `the ${pin?.model ?? "driver"} card in the policy's driver block`;
  const custom = modeled.some((e) => e.price_basis === "custom");
  return `the dated price list for ${pin?.model ?? "the driver"} (period ${periods.join(", ")}${custom ? "; custom-priced" : ""})`;
}

/** One line per cost line, workers first, each with its kind and never a total. */
export function describeCostLines(lines) {
  const workersFirst = [...lines.filter((l) => l.line !== "driver"), ...lines.filter((l) => l.line === "driver")];
  return workersFirst.map((l) => {
    const name = l.line.replace("_", " ");
    if (l.kind === "unmeasured") return `${name} NOT MEASURED`;
    const range = l.cost_usd_low !== undefined ? ` (range $${l.cost_usd_low}–$${l.cost_usd})` : "";
    return `${name} ${l.kind} $${l.cost_usd}${range}`;
  }).join(" · ");
}

export function agyVersion(run = spawnSync) {
  const r = run("agy", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r?.status === 0 ? String(r.stdout).trim() : null;
}

export function buildHarnessManifest({ runDir, policyName, runId, env = process.env, version = null, login = null, wallet = claudeWallet(env, login), now = () => new Date().toISOString() }) {
  const allTelemetry = readJsonl(join(runDir, "telemetry.jsonl"));
  const allModeled = readJsonl(join(runDir, "driver-cost-modeled.jsonl"));
  const launcherRecord = readJson(join(runDir, "driver-manifest.json"));
  const snapshotPath = join(runDir, "policy_snapshot.yaml");
  const policy = existsSync(snapshotPath) ? parseYaml(readFileSync(snapshotPath, "utf8")) : null;

  const pass = runId ?? launcherRecord?.run_id ?? inferRunId(runDir, allTelemetry);
  // An output directory reused across runs holds every run's lines: only this
  // run's count. A row with no run id (a zero-cost --log-phase row written
  // without --run-id) is kept, since it carries no dollars. The launcher's
  // record belongs to one run; another run's is not this run's driver.
  const telemetry = allTelemetry.filter((e) => e.pass == null || e.pass === pass);
  const modeled = allModeled.filter((e) => e.pass == null || e.pass === pass);
  const driverManifest = launcherRecord && (!launcherRecord.run_id || launcherRecord.run_id === pass) ? launcherRecord : null;
  const collectorRecord = readJson(join(runDir, "driver-collector.json"));
  const collector = !driverManifest && collectorRecord && (!collectorRecord.run_id || collectorRecord.run_id === pass) ? collectorRecord : null;
  const otherRuns = [...new Set([...allTelemetry, ...allModeled].map((e) => e.pass).filter((p) => p != null && p !== pass))].map((run) => {
    const lines = allTelemetry.filter((e) => e.pass === run && e.tier !== "orchestrator");
    return { run, dispatched_events: lines.length, dispatched_cost_usd: r6(lines.reduce((s, e) => s + (e.cost_usd ?? 0), 0)) };
  });
  const policy_name = policyName ?? driverManifest?.policy ?? policy?.name ?? telemetry.find((e) => e.routing?.policy_name)?.routing.policy_name ?? null;
  if (!pass) throw new Error(`manifest: no run id — pass --run-id, or run the launcher so driver-manifest.json carries one (${runDir}).`);
  if (!policy_name) throw new Error(`manifest: no policy name — pass --policy, or leave policy_snapshot.yaml in ${runDir}.`);

  const dispatched = telemetry.filter((e) => e.tier !== "orchestrator");
  const base = buildManifest(dispatched, { pass, policy_name });
  const markers = readRunMarkers(runDir, pass);
  base.dispatch_window = dispatched.length
    ? { start: base.started_at, end: base.ended_at, duration_sec: base.duration_sec, basis: "completion stamps (ts) of the first and last dispatched event" }
    : null;
  base.session_window = sessionWindow({ launcher: driverManifest, markers, dispatch: base.dispatch_window });
  if (base.session_window.duration_sec != null) {
    base.started_at = base.session_window.start;
    base.ended_at = base.session_window.end;
    base.duration_sec = Math.max(1, base.session_window.duration_sec);
  }
  const gates = readGates(runDir);
  const outcome = runOutcome({ runDir, gates, launcher: driverManifest, markers, since: markers.start ?? driverManifest?.started_at ?? null });

  let pin = null;
  try { pin = policy ? readPin(policy) : null; } catch { pin = null; }
  const lines = costLines({ dispatched, modeled, policy, pin, env, wallet, driverUsage: driverManifest?.driver_usage ?? null, driverMeasured: driverManifest != null || modeled.length > 0 });
  const driverLine = lines[0];
  const geminiLine = lines[1];
  const claudeLine = lines[2];
  const workerModels = [...new Set(dispatched.map((e) => e.model))];

  const harness = {
    name: HARNESS_NAME,
    schema: MANIFEST_SCHEMA,
    kind: "sdlc",
    runtime: { name: RUNTIME_NAME, version: version ?? driverManifest?.agy_version ?? null },
    auth_mode: "vendor",
    provider_source: {
      driver: pin?.billing_mode === "gemini-api-key" ? "gemini-api-key" : "google-seat",
      claude: claudeLine.arm === "mixed" ? "mixed" : PROVIDER_SOURCE_BY_ARM[claudeLine.arm] ?? null,
      gemini: geminiLine.wallet,
    },
    arm: claudeLine.arm,
    pin: driverManifest?.pin ?? (pin ? { model: pin.model, effort: pin.effort, slug: driverSlug(pin), billing_mode: pin.billing_mode, verified: pendingPinChecks().length === 0, pending_checks: pendingPinChecks() } : null),
    delegated: true,
    cable: {
      driver_runtime: `${RUNTIME_NAME} ${version ?? driverManifest?.agy_version ?? ""}`.trim(),
      driver_models: pin ? [pin.model] : [],
      driver_auth: pin?.billing_mode === "gemini-api-key" ? "GEMINI_API_KEY (metered)" : "Google seat (sign-in) — no per-token invoice",
      worker_models: workerModels,
      claude_worker_auth: claudeWorkerAuth(claudeLine),
      summary: cableSummary(dispatched),
    },
    driver_cost_usd: driverLine.cost_usd,
    driver_cost_basis: driverLine.basis,
    driver_turns: modeled.length,
    ...(driverLine.cost_usd_low !== undefined ? { driver_cost_usd_low: driverLine.cost_usd_low } : {}),
    ...(driverLine.resume_check ? { driver_cost_resume_check: driverLine.resume_check } : {}),
    ...(driverLine.resumed_without_earlier_record ? { driver_resumed_without_earlier_record: true } : {}),
    ...(driverLine.invocations_without_usage ? { driver_invocations_without_usage: driverLine.invocations_without_usage } : {}),
    ...(collector ? { driver_collector: { source: collector.source, window: collector.window, conversations: collector.conversations, calls: collector.calls, fields_verified_on: collector.fields_verified_on, ...(collector.fields_unverified_for_version ? { fields_unverified_for_version: collector.fields_unverified_for_version } : {}), ...(collector.note ? { note: collector.note } : {}) } } : {}),
    ...(collector?.reported_models ? { driver_reported_models: collector.reported_models } : {}),
    ...(collector?.model_mismatch ? { driver_model_mismatch: collector.model_mismatch } : {}),
    ...(driverManifest && "driver_reported_models" in driverManifest ? { driver_reported_models: driverManifest.driver_reported_models } : {}),
    ...(driverManifest?.driver_model_mismatch ? { driver_model_mismatch: driverManifest.driver_model_mismatch } : {}),
    ...(driverManifest?.driver_usage?.token_readings ? { driver_token_readings: driverManifest.driver_usage.token_readings } : {}),
    ...(driverManifest?.driver_usage?.results_with_unproven_reading ? { driver_results_with_unproven_reading: driverManifest.driver_usage.results_with_unproven_reading } : {}),
    ...(driverManifest?.driver_usage?.price_warnings ? { driver_price_warnings: driverManifest.driver_usage.price_warnings } : {}),
    ...(driverManifest?.bridge_build?.stale ? { bridge_build_stale: driverManifest.bridge_build.files } : {}),
    agy_invocations: driverManifest?.agy_invocations ?? null,
    completed: outcome.completed,
    status: outcome.status,
    write_guard: driverManifest
      ? (driverManifest.write_guard ?? { state: "off", reason: "headless run recorded before write_guard existed; agy print mode loads no hooks" })
      : { state: "hook", reason: "interactive session: plugin/agy/hooks/write-contract-check.mjs runs before every file write (plugin/hooks.json)" },
    gate_mode: driverManifest ? driverManifest.gates ?? null : "prompt",
    gates,
    pin_rejection: driverManifest?.pin_rejection ?? null,
    ...conductorWork({ runDir, telemetry: dispatched, mode: driverManifest?.mode, completed: outcome.completed }),
    ...(otherRuns.length ? { other_runs_in_directory: otherRuns } : {}),
    written_by: "plugin/agy/manifest.mjs",
    written_at: now(),
  };

  const usage = {
    dispatched: {
      input_tokens: base.total_input_tokens,
      input_tokens_cached: base.total_input_tokens_cached,
      input_tokens_cache_write: base.total_input_tokens_cache_write ?? 0,
      output_tokens: base.total_output_tokens,
    },
    driver: {
      input_tokens: driverLine.input_tokens,
      input_tokens_cached: driverLine.input_tokens_cached,
      output_tokens: driverLine.output_tokens,
      thinking_tokens: driverLine.thinking_tokens,
      provenance: driverLine.kind,
      ...(driverLine.tokens_low ? { bound: "upper", low: driverLine.tokens_low } : {}),
    },
  };
  // Claude calls on the seat are modeled too, so they leave the cash figure.
  const seat = claudeLine.kind !== "cash";
  const seatUsd = claudeLine.kind === "mixed" ? claudeLine.seat_modeled_usd : claudeLine.cost_usd;
  const cost = {
    dispatched_cash_usd: seat ? r6(base.total_cost_usd - seatUsd) : base.total_cost_usd,
    driver_modeled_usd: driverLine.cost_usd,
    ...(driverLine.kind === "unmeasured" ? { driver_measured: false } : {}),
    ...(driverLine.cost_usd_low !== undefined ? { driver_modeled_usd_low: driverLine.cost_usd_low } : {}),
    ...(seat ? { claude_seat_modeled_usd: seatUsd } : {}),
    lines,
    note: "dispatched_cash_usd and the modeled figures are different kinds of dollars and are not summed.",
  };

  return { ...base, harness, usage, cost };
}

/** The one-line CLI summary the interactive conductor relays. */
export function describeManifest(manifest, driverUsage) {
  const notes = manifest.cost.driver_measured === false ? [] : driverRangeNotes(driverUsage);
  return describeCostLines(manifest.cost.lines) + (notes.length ? ` (driver: ${notes.join("; ")})` : "");
}

function driverManifestUsage(runDir) {
  return readJson(join(runDir, "driver-manifest.json"))?.driver_usage ?? null;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv) {
    if (raw.startsWith("--")) {
      const eq = raw.indexOf("=");
      if (eq === -1) args[raw.slice(2)] = true;
      else args[raw.slice(2, eq)] = raw.slice(eq + 1);
    } else args._.push(raw);
  }
  return args;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args._[0] ? resolve(args._[0]) : null;
  if (!runDir || !existsSync(runDir)) {
    console.error("Usage: node plugin/agy/manifest.mjs <run-dir> [--policy=<name>] [--run-id=<id>] [--agy-version=<v>]");
    process.exit(2);
  }
  try {
    const { probeClaudeLogin } = await import("./verify-setup.mjs");
    const manifest = buildHarnessManifest({ runDir, policyName: args.policy, runId: args["run-id"], version: args["agy-version"] ?? agyVersion(), login: probeClaudeLogin() });
    const out = join(runDir, "manifest.json");
    writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`manifest: wrote ${out} — ${describeManifest(manifest, driverManifestUsage(runDir))}`);
  } catch (err) {
    console.error(`manifest failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
