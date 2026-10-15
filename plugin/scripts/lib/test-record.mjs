/**
 * A run's test record, read the same way by everything that decides whether
 * the run completed: plugin/scripts/write-contract.mjs --close, the manifest
 * (plugin/agy/manifest.mjs), the headless launcher and dispatch.mjs.
 *
 *   <run folder>/test-run.json        what plugin/scripts/test-run.mjs saw the test command do
 *   <run folder>/test-output.txt      the command's output
 *   <run folder>/contract.lock.json   `test_commands`: what Gate 0 confirmed, frozen with the contract; [] for none
 *   .sdlc/local/guard-decisions.jsonl the hook's allowed writes, each with its time
 *
 * A passing record counts only when it ran a frozen test command from the
 * project's root, and no project write was allowed after it started. A
 * monorepo freezes one command per package, each run from the root.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { guardDecisions, readLock } from "./contract-state.mjs";

export const TEST_RECORD_FILE = "test-run.json";
export const TEST_OUTPUT_FILE = "test-output.txt";
export const TEST_RECORD_WRITER = "plugin/scripts/test-run.mjs";
export const testRecordRelPath = (runId) => `.sdlc/runs/${runId}/${TEST_RECORD_FILE}`;

const MAX_BYTES = 1024 * 1024;

function readText(path) {
  try {
    const st = statSync(path);
    return st.isFile() && st.size <= MAX_BYTES ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** The run folder's test record, or null when there is none or it is not one test-run.mjs wrote. */
export function readTestRecord(runDir) {
  const text = readText(join(runDir, TEST_RECORD_FILE));
  if (text === null) return null;
  try {
    const record = JSON.parse(text);
    return record && typeof record === "object" && record.written_by === TEST_RECORD_WRITER ? record : null;
  } catch {
    return null;
  }
}

/** The project a run folder at `<root>/.sdlc/runs/<run-id>` belongs to, or null for a folder elsewhere. */
export function projectRootOf(runDir, runId) {
  const dir = resolve(runDir);
  if (!runId || basename(dir) !== runId) return null;
  const runs = dirname(dir);
  return basename(runs) === "runs" && basename(dirname(runs)) === ".sdlc" ? dirname(dirname(runs)) : null;
}

/**
 * The test commands the run's freeze record holds: [] when Gate 0 confirmed
 * the project has none, null when there is no freeze record or it was written
 * before --freeze took --test-command.
 */
export function frozenTestCommands(root, runId) {
  const commands = root && runId ? readLock(root, runId)?.test_commands : undefined;
  return Array.isArray(commands) && commands.every((c) => typeof c === "string") ? commands : null;
}

const sameCommand = (a, b) => String(a ?? "").trim().replace(/\s+/g, " ") === String(b ?? "").trim().replace(/\s+/g, " ");

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Why a test run of `command` in `cwd` cannot stand for the run's tests, or null. */
export function testRunMismatch({ command, cwd }, { frozen = null, root = null } = {}) {
  if (frozen?.length && !frozen.some((c) => sameCommand(c, command))) {
    return `${JSON.stringify(command ?? "?")} is not the test command Gate 0 froze (${frozen.map((c) => JSON.stringify(c)).join(", ")})`;
  }
  if (root && cwd && real(cwd) !== real(root)) return `it ran in ${cwd}, not the project root ${root}`;
  return null;
}

/** The first write the hook allowed for the run, outside its own folder, after `since`; null when none. */
export function projectWriteAfter(root, runId, since) {
  const after = Date.parse(since);
  if (!root || !runId || !Number.isFinite(after)) return null;
  const own = `/.sdlc/runs/${runId}/`;
  for (const d of guardDecisions(root, runId)) {
    if (d.decision !== "allow" || !(Date.parse(d.ts) > after)) continue;
    const path = [...(d.paths ?? []), ...(d.path ? [d.path] : [])].find((p) => typeof p === "string" && !p.replaceAll("\\", "/").includes(own));
    if (path) return { ts: d.ts, path };
  }
  return null;
}

/**
 * Whether the run's tests allow it to complete. `required` is false only when
 * Gate 0 froze `none`; then `passed` is null. `projectRoot` defaults to the
 * project the run folder sits in.
 */
export function testVerdict(runDir, runId = null, { projectRoot = null } = {}) {
  const root = projectRoot ? resolve(projectRoot) : projectRootOf(runDir, runId);
  const frozen = frozenTestCommands(root, runId);
  if (frozen?.length === 0) {
    return { required: false, passed: null, status: "none", frozen_commands: [], reason: "Gate 0 froze no test command (none)" };
  }
  const base = { required: true, record: TEST_RECORD_FILE, frozen_commands: frozen };
  const record = readTestRecord(runDir);
  if (!record || (runId && record.run_id !== runId)) {
    return { ...base, passed: false, status: "not_run", exit_code: null, command: null, reason: `no ${TEST_RECORD_FILE} for this run: the test command never ran through ${TEST_RECORD_WRITER}` };
  }
  const ran = record.status === "passed" && record.exit_code === 0;
  const mismatch = testRunMismatch(record, { frozen, root });
  const stale = ran && !mismatch ? projectWriteAfter(root, runId, record.started_at) : null;
  const reason = mismatch ? `the last test run does not count: ${mismatch}`
    : stale ? `the project changed after the last test run started (${record.started_at}): the hook allowed a write to ${stale.path} at ${stale.ts}; run the tests again`
    : ran ? null
    : `the last test run (${JSON.stringify(record.command ?? "?")}) ${record.status === "not_run" ? "could not run" : "failed"}, exit code ${record.exit_code ?? "none"}${record.error ? `: ${record.error}` : ""}`;
  return {
    ...base,
    passed: reason === null,
    status: record.status ?? null,
    exit_code: record.exit_code ?? null,
    command: record.command ?? null,
    cwd: record.cwd ?? null,
    attempt: record.attempt ?? 1,
    ended_at: record.ended_at ?? null,
    ...(reason ? { reason } : {}),
  };
}
