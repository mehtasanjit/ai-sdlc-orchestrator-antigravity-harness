/**
 * The pipeline's gate state, `.sdlc/runs/<run-id>/state.json`, which the
 * conductor writes before each gate (plugin/skills/pipeline/SKILL.md). It sits
 * in the run's own folder because that is the one place under `.sdlc/` a live
 * write contract lets the run write. Read by session-hydrate.mjs (the resume
 * offer) and setup-policy.mjs --guard-active-run.
 *
 * A run that started before the file moved wrote `.sdlc/local/state.json`;
 * that file is read only while no run folder holds a state file, or when it
 * names the run whose contract binds.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUN_ID, contractState, runEnded } from "./contract-state.mjs";

export const LEGACY_STATE_REL_PATH = ".sdlc/local/state.json";
export const runStateRelPath = (runId) => `.sdlc/runs/${runId}/state.json`;

const TERMINAL_STATUSES = new Set(["complete", "completed", "aborted", "failed"]);
const STATE_MAX_BYTES = 4 * 1024 * 1024;

function readState(path) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > STATE_MAX_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { value, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function writtenAt({ value, mtimeMs }) {
  for (const v of [value.at, value.updated_at, value.timestamp]) {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return mtimeMs;
}

/**
 * The state file written last, `{ run_id, path, legacy, state }` with `path`
 * relative to the project root, or null. Last is the state's own `at` (or
 * `updated_at`, `timestamp`), else the file's mtime. One file per run means an
 * older interrupted run is never offered over a newer one: the single shared
 * file this replaces was overwritten by each run.
 */
export function latestRunState(projectRoot) {
  let names = [];
  try { names = readdirSync(join(projectRoot, ".sdlc", "runs")); } catch { names = []; }
  const found = [];
  for (const id of names) {
    if (!RUN_ID.test(id)) continue;
    const path = runStateRelPath(id);
    const read = readState(join(projectRoot, path));
    if (read) found.push({ run_id: id, path, legacy: false, state: read.value, at: writtenAt(read) });
  }
  if (found.length) {
    found.sort((a, b) => b.at - a.at || b.run_id.localeCompare(a.run_id));
    const { at, ...latest } = found[0];
    return latest;
  }
  const legacy = readState(join(projectRoot, LEGACY_STATE_REL_PATH));
  if (!legacy) return null;
  const runId = typeof legacy.value.run_id === "string" ? legacy.value.run_id : null;
  return { run_id: runId, path: LEGACY_STATE_REL_PATH, legacy: true, state: legacy.value };
}

function pending(runId, path, s) {
  return {
    run_id: runId,
    state_path: path,
    phase: s.phase ?? null,
    gate: s.gate ?? null,
    checkpoint: s.checkpoint ?? s.next_packet_index ?? null,
    status: s.status ?? null,
    at: s.at ?? s.updated_at ?? s.timestamp ?? null,
  };
}

/** The bound run's own state file, else the old shared one when it names that run. */
function boundRunState(projectRoot, runId) {
  const own = readState(join(projectRoot, runStateRelPath(runId)));
  const legacy = own ? null : readState(join(projectRoot, LEGACY_STATE_REL_PATH));
  const found = own ? [runStateRelPath(runId), own.value]
    : legacy?.value.run_id === runId ? [LEGACY_STATE_REL_PATH, legacy.value]
    : [runStateRelPath(runId), {}];
  return { ...pending(runId, ...found), contract_live: true };
}

/**
 * The run left unfinished, or null.
 *
 * A run whose write contract still binds (contract-state.mjs, the hook's own
 * reader) comes first, whatever its state says: the conductor marks a run
 * complete before close-out ends its contract, and until that run is resumed
 * or discarded its contract judges every write, so a new run cannot write its
 * own folder. It carries `contract_live: true`. Otherwise it is the latest
 * run's state, unless that state is terminal or the run has an end record
 * (`write-contract.mjs --close` or `--abandon`, or the launcher's stop).
 */
export function pendingRunState(projectRoot) {
  const bound = contractState(projectRoot);
  if (bound.binding) return boundRunState(projectRoot, bound.runId);
  const latest = latestRunState(projectRoot);
  if (!latest) return null;
  const s = latest.state;
  if (!s.status || TERMINAL_STATUSES.has(s.status)) return null;
  if (latest.run_id && runEnded(projectRoot, latest.run_id)) return null;
  return pending(latest.run_id, latest.path, s);
}
