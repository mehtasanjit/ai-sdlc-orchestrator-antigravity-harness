/**
 * The pipeline's gate state, `.sdlc/runs/<run-id>/state.json`, which the
 * conductor writes before each gate (plugin/skills/pipeline/SKILL.md). It sits
 * in the run's own folder because that is the one place under `.sdlc/` a live
 * write contract lets the run write. Read by session-hydrate.mjs (the resume
 * offer) and setup-policy.mjs --guard-active-run.
 *
 * A run that started before the file moved wrote `.sdlc/local/state.json`;
 * that file is read only while no run folder holds a state file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUN_ID, runEnded } from "./contract-state.mjs";

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

/**
 * The latest run's state when that run has not finished, or null. A run with
 * an end record (`write-contract.mjs --close` or `--abandon`, or the launcher's
 * stop) is over whatever its state file last said.
 */
export function pendingRunState(projectRoot) {
  const latest = latestRunState(projectRoot);
  if (!latest) return null;
  const s = latest.state;
  if (!s.status || TERMINAL_STATUSES.has(s.status)) return null;
  if (latest.run_id && runEnded(projectRoot, latest.run_id)) return null;
  return {
    run_id: latest.run_id,
    state_path: latest.path,
    phase: s.phase ?? null,
    gate: s.gate ?? null,
    checkpoint: s.checkpoint ?? s.next_packet_index ?? null,
    status: s.status,
    at: s.at ?? s.updated_at ?? s.timestamp ?? null,
  };
}
