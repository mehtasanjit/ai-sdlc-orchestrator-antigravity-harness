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
 *                      arm A: Anthropic; arm B: GCP)
 *
 * Usage: node manifest.mjs <run-dir> [--policy=<name>] [--run-id=<id>] [--agy-version=<v>]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { buildManifest } from "../mcp/model-dispatch/dist/telemetry.js";
import { readPin, driverSlug, pendingPinChecks } from "./telemetry/fairnessPin.mjs";
import { driverRange, driverRangeNote } from "./telemetry/driverRange.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";

export const HARNESS_NAME = "antigravity";
export const RUNTIME_NAME = "antigravity-cli";

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

/** Which Claude wallet the bridge env selected, from the environment the run was launched with. */
export function claudeWallet(env = process.env, login = null) {
  if (env.CLAUDE_CODE_USE_VERTEX === "1") return { arm: "B", wallet: "gcp", provider_source: "vertex", project: env.ANTHROPIC_VERTEX_PROJECT_ID ?? null, region: env.CLOUD_ML_REGION ?? null };
  if (env.ANTHROPIC_API_KEY) return { arm: "A", wallet: "anthropic", provider_source: "anthropic-api", project: null, region: null };
  // The seat: Claude Code signed in to claude.ai. No invoice — the line is modeled.
  if (login?.loggedIn && login.method === "claude.ai") return { arm: "seat", wallet: "claude-seat", provider_source: "claude-seat", project: null, region: null, subscription: login.subscription ?? null };
  return { arm: null, wallet: null, provider_source: null, project: null, region: null };
}

export function geminiDoor(policy, env = process.env) {
  const select = env.MMO_SELECT ?? env.SDLC_SELECT ?? "";
  const chosen = /gemini-flash=([^,\s]+)/.exec(select)?.[1] ?? policy?.select?.["gemini-flash"]?.default ?? null;
  const wallet = chosen === "flash-agsdk-worker" ? "gcp" : env.GEMINI_API_KEY ? "gemini-api-key" : "gcp";
  return { leaf: chosen, wallet };
}

/**
 * Adapters that dispatch a Claude worker, and so put their model's dollars on
 * the Claude cost line. Mirrors the bridge's adapter registry
 * (plugin/mcp/model-dispatch/src/adapters/index.ts), which is the source of
 * truth; the two trees do not import each other. A policy naming an adapter
 * missing from here would have its Claude spend silently counted as Gemini.
 */
export const CLAUDE_WORKER_ADAPTERS = new Set(["claude-agent-sdk", "claude-cli"]);

/** The three lines. `dispatched` are bridge events (no orchestrator tier). */
/**
 * The basis an interactive run's driver line carries. The wording matches the
 * studies console's convention for an unmeasured driver ($0, "NOT MEASURED",
 * "unmeasured, never free"), so the dashboard never reads the $0 as free.
 */
export const UNMEASURED_DRIVER_BASIS =
  "NOT MEASURED: no headless launcher record (driver-manifest.json). An interactive agy session gives the plugin no usage counters (p1 checks 1, 13), so the conductor's own tokens are in no figure — unmeasured, never free";

export function costLines({ dispatched, modeled, policy, pin, env = process.env, login = null, driverUsage = null, driverMeasured = modeled.length > 0 || driverUsage != null }) {
  const claudeModels = new Set(
    (policy?.models ?? []).filter((m) => CLAUDE_WORKER_ADAPTERS.has(m.adapter)).map((m) => m.model_name),
  );
  const sum = (events) => ({
    cost_usd: r6(events.reduce((s, e) => s + (e.cost_usd ?? 0), 0)),
    calls: events.length,
    input_tokens: events.reduce((s, e) => s + (e.input_tokens ?? 0), 0),
    input_tokens_cached: events.reduce((s, e) => s + (e.input_tokens_cached ?? 0), 0),
    output_tokens: events.reduce((s, e) => s + (e.output_tokens ?? 0), 0),
  });
  const billed = dispatched.filter((e) => e.model && e.provenance !== "none");
  const claude = billed.filter((e) => claudeModels.has(e.model));
  const gemini = billed.filter((e) => !claudeModels.has(e.model));
  const wallet = claudeWallet(env, login);
  const door = geminiDoor(policy, env);
  const seat = wallet.arm === "seat";
  const driver = driverMeasured
    ? null
    : { line: "driver", kind: "unmeasured", measured: false, model: pin?.model ?? null, billing_mode: pin?.billing_mode ?? null, basis: UNMEASURED_DRIVER_BASIS, ...sum([]), thinking_tokens: 0 };
  return [
    driver ?? {
      line: "driver",
      kind: "modeled",
      model: pin?.model ?? null,
      billing_mode: pin?.billing_mode ?? null,
      basis: `MODELED from agy stream-json usage at the ${pin?.model ?? "driver"} card (${pin?.billing_mode ?? "seat"}); thinking at the output rate, cache reads at the cached rate${driverRangeNote(driverUsage)}`,
      ...sum(modeled),
      thinking_tokens: modeled.reduce((s, e) => s + (e.output_tokens_reasoning ?? 0), 0),
      ...driverRange(driverUsage),
    },
    { line: "gemini_workers", kind: "cash", wallet: door.wallet, leaf: door.leaf, models: [...new Set(gemini.map((e) => e.model))], ...sum(gemini) },
    { line: "claude_worker", kind: seat ? "modeled" : "cash", wallet: wallet.wallet, arm: wallet.arm, models: [...new Set(claude.map((e) => e.model))], ...sum(claude),
      cli_reported_cost_usd: r6(claude.reduce((s, e) => s + (e.cli_reported_cost_usd ?? 0), 0)),
      ...(seat ? { basis: `MODELED: the Claude worker ran on a claude.ai ${wallet.subscription ?? ""} seat — tokens priced at the Anthropic card, no invoice exists` } : {}) },
  ];
}

export function agyVersion(run = spawnSync) {
  const r = run("agy", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r?.status === 0 ? String(r.stdout).trim() : null;
}

export function buildHarnessManifest({ runDir, policyName, runId, env = process.env, version = null, login = null, now = () => new Date().toISOString() }) {
  const telemetry = readJsonl(join(runDir, "telemetry.jsonl"));
  const modeled = readJsonl(join(runDir, "driver-cost-modeled.jsonl"));
  const driverManifest = readJson(join(runDir, "driver-manifest.json"));
  const snapshotPath = join(runDir, "policy_snapshot.yaml");
  const policy = existsSync(snapshotPath) ? parseYaml(readFileSync(snapshotPath, "utf8")) : null;

  const pass = runId ?? driverManifest?.run_id ?? telemetry.find((e) => e.pass)?.pass ?? null;
  const policy_name = policyName ?? driverManifest?.policy ?? policy?.name ?? telemetry.find((e) => e.routing?.policy_name)?.routing.policy_name ?? null;
  if (!pass) throw new Error(`manifest: no run id — pass --run-id, or run the launcher so driver-manifest.json carries one (${runDir}).`);
  if (!policy_name) throw new Error(`manifest: no policy name — pass --policy, or leave policy_snapshot.yaml in ${runDir}.`);

  const dispatched = telemetry.filter((e) => e.tier !== "orchestrator");
  const base = buildManifest(dispatched, { pass, policy_name });
  if (driverManifest?.started_at) base.started_at = driverManifest.started_at;
  if (driverManifest?.ended_at) base.ended_at = driverManifest.ended_at;
  if (driverManifest?.started_at && driverManifest?.ended_at) {
    base.duration_sec = Math.max(1, Math.round((Date.parse(base.ended_at) - Date.parse(base.started_at)) / 1000));
  }

  let pin = null;
  try { pin = policy ? readPin(policy) : null; } catch { pin = null; }
  const lines = costLines({ dispatched, modeled, policy, pin, env, login, driverUsage: driverManifest?.driver_usage ?? null, driverMeasured: driverManifest != null || modeled.length > 0 });
  const driverLine = lines[0];
  const claudeLine = lines[2];
  const wallet = claudeWallet(env, login);
  const workerModels = [...new Set(dispatched.map((e) => e.model))];

  const harness = {
    name: HARNESS_NAME,
    kind: "sdlc",
    runtime: { name: RUNTIME_NAME, version: version ?? driverManifest?.agy_version ?? null },
    auth_mode: "vendor",
    provider_source: {
      driver: pin?.billing_mode === "gemini-api-key" ? "gemini-api-key" : "google-seat",
      claude: wallet.provider_source,
      gemini: geminiDoor(policy, env).wallet,
    },
    arm: wallet.arm,
    pin: driverManifest?.pin ?? (pin ? { model: pin.model, effort: pin.effort, slug: driverSlug(pin), billing_mode: pin.billing_mode, verified: pendingPinChecks().length === 0, pending_checks: pendingPinChecks() } : null),
    delegated: true,
    cable: {
      driver_runtime: `${RUNTIME_NAME} ${version ?? driverManifest?.agy_version ?? ""}`.trim(),
      driver_models: pin ? [pin.model] : [],
      driver_auth: pin?.billing_mode === "gemini-api-key" ? "GEMINI_API_KEY (metered)" : "Google seat (sign-in) — no per-token invoice",
      worker_models: workerModels,
      claude_worker_auth: wallet.arm === "B" ? `Vertex on GCP project ${wallet.project ?? "?"} (${wallet.region ?? "?"})` : wallet.arm === "A" ? "Anthropic API key" : wallet.arm === "seat" ? `claude.ai ${wallet.subscription ?? ""} seat (OAuth) — not the metered API`.replace("  ", " ") : null,
      summary: `${RUNTIME_NAME} driver → model-dispatch bridge (Opus 5 via claude -p, Gemini via ${geminiDoor(policy, env).leaf ?? "?"})`,
    },
    driver_cost_usd: driverLine.cost_usd,
    driver_cost_basis: driverLine.basis,
    driver_turns: modeled.length,
    ...(driverLine.cost_usd_low !== undefined ? { driver_cost_usd_low: driverLine.cost_usd_low, driver_cost_resume_check: driverLine.resume_check } : {}),
    ...(driverLine.invocations_without_usage ? { driver_invocations_without_usage: driverLine.invocations_without_usage } : {}),
    agy_invocations: driverManifest?.agy_invocations ?? null,
    completed: driverManifest?.completed ?? null,
    gates: driverManifest?.gates ?? null,
    pin_rejection: driverManifest?.pin_rejection ?? null,
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
    },
  };
  // On the seat the Claude line is modeled too, so it leaves the cash figure.
  const seat = claudeLine.kind === "modeled";
  const cost = {
    dispatched_cash_usd: seat ? r6(base.total_cost_usd - claudeLine.cost_usd) : base.total_cost_usd,
    driver_modeled_usd: driverLine.cost_usd,
    ...(driverLine.kind === "unmeasured" ? { driver_measured: false } : {}),
    ...(driverLine.cost_usd_low !== undefined ? { driver_modeled_usd_low: driverLine.cost_usd_low } : {}),
    ...(seat ? { claude_seat_modeled_usd: claudeLine.cost_usd } : {}),
    lines,
    note: "dispatched_cash_usd and the modeled figures are different kinds of dollars and are not summed.",
  };

  return { ...base, harness, usage, cost };
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
    console.log(`manifest: wrote ${out} — dispatched cash $${manifest.cost.dispatched_cash_usd}, driver modeled $${manifest.cost.driver_modeled_usd}`);
  } catch (err) {
    console.error(`manifest failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
