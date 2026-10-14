#!/usr/bin/env node
/**
 * Writes a brownfield run's write contract by code, and ends it.
 *
 *   --freeze   at Gate 0: writes .sdlc/local/write-contract.json and the run's
 *              contract.lock.json (the SHA-256 of the exact bytes), so an edit
 *              to the contract later in the run refuses every write.
 *   --close    at close-out, after Gate 4: records the run's end in
 *              .sdlc/runs/<run-id>/run-end.json, then switches the contract off.
 *   --abandon  ends a run that will never end by itself (its chat closed, it
 *              crashed after Gate 0): the person's decision, never the run's.
 *
 * Usage:
 *   node write-contract.mjs --freeze --run-id <id> --allowlist '<JSON array>' [--off-limits '<JSON array>']
 *                           [--strict-write=off] [--project-root <dir>]
 *   node write-contract.mjs --close --run-id <id> [--outcome completed|aborted|stopped] [--project-root <dir>]
 *   node write-contract.mjs --abandon --run-id <id> [--reason "<text>"] [--project-root <dir>]
 *
 * The project root must be its git project's root: the hook reads only the
 * contract there. Exit 0 = written, 2 = refused or usage.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CONTRACT_REL_PATH, RUN_ID, contractState, endRelPath, fingerprint, gitRoot, liveLocks, lockRelPath, readContract, readLock, runEnded } from "./lib/contract-state.mjs";
import { isMain } from "./lib/is-main.mjs";

export const OUTCOMES = new Set(["completed", "aborted", "stopped"]);

function parseArgs(argv) {
  const out = { mode: null, runId: null, allowlist: null, offLimits: "[]", strict: true, reason: null, outcome: "completed", projectRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a === "--freeze") out.mode = "freeze";
    else if (a === "--close") out.mode = "close";
    else if (a === "--abandon") out.mode = "abandon";
    else if (a.startsWith("--run-id")) out.runId = val();
    else if (a.startsWith("--allowlist")) out.allowlist = val();
    else if (a.startsWith("--off-limits")) out.offLimits = val();
    else if (a === "--strict-write=off") out.strict = false;
    else if (a.startsWith("--reason")) out.reason = val();
    else if (a.startsWith("--outcome")) out.outcome = val();
    else if (a.startsWith("--project-root")) out.projectRoot = val();
  }
  return out;
}

const PERSON_DECIDES = "A wider scope is the person's decision, for a new run with its own Gate 0: stop and tell the person which path is needed and why.";

function globs(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.every((g) => typeof g === "string" && g.length > 0) ? v : null;
  } catch {
    return null;
  }
}

/** Whole or not at all: a reader never sees half a file. */
function writeWhole(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function writeContract(root, contract) {
  const text = JSON.stringify(contract, null, 2) + "\n";
  writeWhole(join(root, CONTRACT_REL_PATH), text);
  return fingerprint(Buffer.from(text, "utf8"));
}

/** Records the run's end, then switches its contract off if it names the run. */
export function endRun(root, runId, { outcome, reason = null, now = () => new Date().toISOString() }) {
  if (!runEnded(root, runId)) {
    writeWhole(join(root, endRelPath(runId)), JSON.stringify({ run_id: runId, outcome, ...(reason ? { reason } : {}), ended_at: now(), written_by: "plugin/scripts/write-contract.mjs" }, null, 2) + "\n");
  }
  const current = readContract(root)?.parsed;
  if (current?.run_id === runId && current.active === true) writeContract(root, { ...current, active: false });
  return { switchedOff: current?.run_id === runId };
}

export function main(argv = process.argv.slice(2), { log = (m) => process.stdout.write(`${m}\n`), fail = (m) => process.stderr.write(`write-contract: ${m}\n`) } = {}) {
  const a = parseArgs(argv);
  const root = resolve(a.projectRoot);
  const refuse = (m) => { fail(m); return 2; };
  if (!a.mode) return refuse("usage: --freeze --run-id <id> --allowlist '<JSON array>' [--off-limits '<JSON array>'] [--strict-write=off], --close --run-id <id>, or --abandon --run-id <id> [--reason \"<text>\"]");
  if (typeof a.runId !== "string" || !RUN_ID.test(a.runId)) return refuse("--run-id must be the run's id (letters, digits, '.', '_', '-')");
  if (gitRoot(root) !== root) {
    const top = gitRoot(root);
    return refuse(`${root} is not the root of a git project${top ? ` (the git project is ${top})` : ""}. The write-contract hook reads the contract only at a git project's root. Nothing is written. A brownfield run starts from the project's root folder.`);
  }

  if (a.mode === "freeze") {
    const allowlist = globs(a.allowlist);
    const offLimits = globs(a.offLimits);
    if (!allowlist) return refuse("--allowlist must be a JSON array of path globs");
    if (!offLimits) return refuse("--off-limits must be a JSON array of path globs");
    if (readLock(root, a.runId)) return refuse(`run ${a.runId} has already frozen its contract: a run freezes once, at its Gate 0. ${PERSON_DECIDES}`);
    if (runEnded(root, a.runId)) return refuse(`run ${a.runId} has ended, and a run that ended never freezes again. ${PERSON_DECIDES}`);
    const state = contractState(root);
    if (state.binding) return refuse(`run ${state.runId} is live and holds this project's contract. Ending it is the person's decision: write-contract.mjs --abandon --run-id ${state.runId} --reason "<why>".`);
    const sha256 = writeContract(root, { schema_version: 1, active: true, mode: "brownfield", run_id: a.runId, strict: a.strict, allowlist, off_limits: offLimits });
    writeWhole(join(root, lockRelPath(a.runId)), JSON.stringify({ run_id: a.runId, sha256, frozen_at: new Date().toISOString(), written_by: "plugin/scripts/write-contract.mjs" }, null, 2) + "\n");
    log(`write-contract: frozen for run ${a.runId} (${allowlist.length} allowlist, ${offLimits.length} off-limits pattern(s)${a.strict ? "" : ", strict off"})`);
    return 0;
  }

  if (a.mode === "close") {
    if (!OUTCOMES.has(a.outcome)) return refuse(`--outcome must be one of ${[...OUTCOMES].join(", ")}`);
    const current = readContract(root)?.parsed;
    const ownsLock = liveLocks(root).includes(a.runId);
    if (current?.run_id !== a.runId && !ownsLock) return refuse(`no contract of run ${a.runId} in ${root}`);
    endRun(root, a.runId, { outcome: a.outcome, reason: a.reason });
    log(`write-contract: run ${a.runId} ended (${a.outcome}); its contract is switched off`);
    return 0;
  }

  // abandon
  const current = readContract(root)?.parsed;
  if (current?.run_id !== a.runId && !readLock(root, a.runId)) return refuse(`no run ${a.runId} in ${root}: no freeze record and the contract does not name it`);
  const already = runEnded(root, a.runId);
  const reason = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim() : "abandoned by the person";
  endRun(root, a.runId, { outcome: "aborted", reason });
  log(`write-contract: run ${a.runId} ${already ? "had already ended" : `ended (aborted: ${reason})`}; its contract is switched off`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
