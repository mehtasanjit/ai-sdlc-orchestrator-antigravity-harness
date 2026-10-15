#!/usr/bin/env node
/**
 * Writes a brownfield run's write contract by code, and ends it.
 *
 *   --freeze   at Gate 0: writes .sdlc/local/write-contract.json and the run's
 *              contract.lock.json (the SHA-256 of the exact bytes, and the test
 *              commands Gate 0 confirmed), so an edit to the contract later in
 *              the run refuses every write. Each --conditional file is in scope
 *              only once a Gate 0 approved-conditional record opens it.
 *   --close    at close-out, after Gate 4: records the run's end in
 *              .sdlc/runs/<run-id>/run-end.json, then switches the contract off.
 *              `completed` needs a passing run of a frozen test command (lib/test-record.mjs)
 *              and every gate-approved artifact as approved (lib/gate-record.mjs);
 *              `stopped` carries the stop record: why, and what the person must do.
 *   --abandon  ends a run that will never end by itself (its chat closed, it
 *              crashed after Gate 0): the person's decision, never the run's.
 *
 * Usage:
 *   node write-contract.mjs --freeze --run-id <id> --allowlist '<JSON array>' [--off-limits '<JSON array>']
 *                           --test-command '<command>' [--test-command '<command>' ...] | --test-command none
 *                           [--conditional '<glob>' --condition '<when it is in scope>' ...]
 *                           [--strict-write=off] [--project-root <dir>]
 *   node write-contract.mjs --close --run-id <id> [--outcome completed|aborted] [--project-root <dir>]
 *   node write-contract.mjs --close --run-id <id> --outcome stopped --reason "<what failed>" --needs "<what the person must do>"
 *   node write-contract.mjs --abandon --run-id <id> [--reason "<text>"] [--project-root <dir>]
 *
 * The project root must be its git project's root: the hook reads only the
 * contract there. Exit 0 = written, 2 = refused or usage.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CONTRACT_REL_PATH, RUN_ID, contractState, endRelPath, fingerprint, gitRoot, liveLocks, lockRelPath, readContract, readLock, runEnd, runEnded } from "./lib/contract-state.mjs";
import { approvalVerdict } from "./lib/gate-record.mjs";
import { isMain } from "./lib/is-main.mjs";
import { testVerdict } from "./lib/test-record.mjs";

export const OUTCOMES = new Set(["completed", "aborted", "stopped"]);

function parseArgs(argv) {
  const out = { mode: null, runId: null, allowlist: null, offLimits: "[]", testCommands: [], conditional: [], strayCondition: false, strict: true, reason: null, needs: null, outcome: "completed", projectRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a === "--freeze") out.mode = "freeze";
    else if (a === "--close") out.mode = "close";
    else if (a === "--abandon") out.mode = "abandon";
    else if (a.startsWith("--run-id")) out.runId = val();
    else if (a.startsWith("--allowlist")) out.allowlist = val();
    else if (a.startsWith("--off-limits")) out.offLimits = val();
    else if (a.startsWith("--test-command")) out.testCommands.push(val());
    else if (a.startsWith("--conditional")) out.conditional.push({ path: val(), condition: null });
    else if (a.startsWith("--condition")) {
      const open = out.conditional.at(-1);
      if (open && open.condition === null) open.condition = val();
      else { val(); out.strayCondition = true; }
    }
    else if (a === "--strict-write=off") out.strict = false;
    else if (a.startsWith("--reason")) out.reason = val();
    else if (a.startsWith("--needs")) out.needs = val();
    else if (a.startsWith("--outcome")) out.outcome = val();
    else if (a.startsWith("--project-root")) out.projectRoot = val();
  }
  return out;
}

const PERSON_DECIDES = "A wider scope is the person's decision, for a new run with its own Gate 0: stop and tell the person which path is needed and why.";

const filled = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

const TEST_COMMAND_USAGE = "--test-command '<the command Gate 0 confirmed>' (once per package's command in a monorepo), or --test-command none when the person confirmed the project has no tests";

/** The frozen test commands: [] for none, null when the flags do not say. */
function testCommands(values) {
  const commands = values.map(filled);
  if (!commands.length || commands.includes(null)) return null;
  if (commands.some((c) => /^none$/i.test(c))) return commands.length === 1 ? [] : null;
  return [...new Set(commands)];
}

const CONDITIONAL_USAGE = "--conditional '<glob>' --condition '<when it is in scope, as Gate 0 showed it>', one pair per file Gate 0 showed as in scope only on a condition";

/** The conditional entries, each with its condition; null when a pair is incomplete. */
function conditionalEntries(pairs, stray) {
  if (stray) return null;
  const entries = pairs.map((e) => ({ path: filled(e.path), condition: filled(e.condition) }));
  return entries.every((e) => e.path && e.condition) ? entries : null;
}

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

export const LAUNCHER_STOP_REASON = "the headless driver loop ended";

/**
 * Binds a run's frozen contract again for a --resume, when the headless
 * launcher (not the person) ended it. The restored contract must match the
 * freeze fingerprint byte for byte; the stop's end record is kept beside it.
 */
export function resumeRun(root, runId, { now = () => new Date().toISOString() } = {}) {
  const end = runEnd(root, runId);
  if (!end) return { resumed: false, ended: false };
  if (end.outcome !== "stopped" || end.reason !== LAUNCHER_STOP_REASON) {
    return { resumed: false, reason: `run ${runId} was ended as "${end.outcome}"${end.reason ? ` (${end.reason})` : ""}, not by the launcher; only the person reopens it` };
  }
  const lock = readLock(root, runId);
  const current = readContract(root)?.parsed;
  if (!lock || current?.run_id !== runId) return { resumed: false, reason: `run ${runId} has no frozen contract to bind again` };
  const text = JSON.stringify({ ...current, active: true }, null, 2) + "\n";
  if (fingerprint(Buffer.from(text, "utf8")) !== lock.sha256) return { resumed: false, reason: `run ${runId}'s contract no longer matches its freeze record` };
  writeWhole(join(root, CONTRACT_REL_PATH), text);
  renameSync(join(root, endRelPath(runId)), join(root, endRelPath(runId).replace(/\.json$/, `.stopped-${now().replace(/[:.]/g, "-")}.json`)));
  return { resumed: true };
}

/** Records the run's end, then switches its contract off if it names the run. */
export function endRun(root, runId, { outcome, reason = null, needs = null, now = () => new Date().toISOString() }) {
  if (!runEnded(root, runId)) {
    writeWhole(join(root, endRelPath(runId)), JSON.stringify({ run_id: runId, outcome, ...(reason ? { reason } : {}), ...(needs ? { needs } : {}), ended_at: now(), written_by: "plugin/scripts/write-contract.mjs" }, null, 2) + "\n");
  }
  const current = readContract(root)?.parsed;
  if (current?.run_id === runId && current.active === true) writeContract(root, { ...current, active: false });
  return { switchedOff: current?.run_id === runId };
}

export function main(argv = process.argv.slice(2), { log = (m) => process.stdout.write(`${m}\n`), fail = (m) => process.stderr.write(`write-contract: ${m}\n`) } = {}) {
  const a = parseArgs(argv);
  const root = resolve(a.projectRoot);
  const refuse = (m) => { fail(m); return 2; };
  if (!a.mode) return refuse("usage: --freeze --run-id <id> --allowlist '<JSON array>' [--off-limits '<JSON array>'] --test-command '<command>'|none [--conditional '<glob>' --condition '<text>' ...] [--strict-write=off], --close --run-id <id>, or --abandon --run-id <id> [--reason \"<text>\"]");
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
    const tests = testCommands(a.testCommands);
    if (!tests) return refuse(`${TEST_COMMAND_USAGE}. Nothing is written.`);
    const conditional = conditionalEntries(a.conditional, a.strayCondition);
    if (!conditional) return refuse(`${CONDITIONAL_USAGE}. Nothing is written.`);
    if (readLock(root, a.runId)) return refuse(`run ${a.runId} has already frozen its contract: a run freezes once, at its Gate 0. ${PERSON_DECIDES}`);
    if (runEnded(root, a.runId)) return refuse(`run ${a.runId} has ended, and a run that ended never freezes again. ${PERSON_DECIDES}`);
    const state = contractState(root);
    if (state.binding) return refuse(`run ${state.runId} is live and holds this project's contract. Ending it is the person's decision: write-contract.mjs --abandon --run-id ${state.runId} --reason "<why>".`);
    const sha256 = writeContract(root, { schema_version: 1, active: true, mode: "brownfield", run_id: a.runId, strict: a.strict, allowlist, off_limits: offLimits, ...(conditional.length ? { conditional } : {}) });
    writeWhole(join(root, lockRelPath(a.runId)), JSON.stringify({ run_id: a.runId, sha256, test_commands: tests, frozen_at: new Date().toISOString(), written_by: "plugin/scripts/write-contract.mjs" }, null, 2) + "\n");
    log(`write-contract: frozen for run ${a.runId} (${allowlist.length} allowlist, ${conditional.length ? `${conditional.length} conditional, ` : ""}${offLimits.length} off-limits pattern(s), test command ${tests.length ? tests.map((c) => JSON.stringify(c)).join(", ") : "none"}${a.strict ? "" : ", strict off"})`);
    return 0;
  }

  if (a.mode === "close") {
    if (!OUTCOMES.has(a.outcome)) return refuse(`--outcome must be one of ${[...OUTCOMES].join(", ")}`);
    const current = readContract(root)?.parsed;
    const ownsLock = liveLocks(root).includes(a.runId);
    if (current?.run_id !== a.runId && !ownsLock) return refuse(`no contract of run ${a.runId} in ${root}`);
    const stopWith = `write-contract.mjs --close --run-id ${a.runId} --outcome=stopped --reason="<what failed>" --needs="<what the person must do>"`;
    if (a.outcome === "stopped" && !(filled(a.reason) && filled(a.needs))) {
      return refuse(`a stopped run records why it stopped and what it needs from the person: ${stopWith}`);
    }
    if (a.outcome === "completed") {
      const tests = testVerdict(join(root, ".sdlc", "runs", a.runId), a.runId, { projectRoot: root });
      if (tests.required && !tests.passed) {
        return refuse(`run ${a.runId} cannot end as completed: ${tests.reason}. A run completes only on a passing run of the test command Gate 0 froze, or when Gate 0 froze none. Nothing is written. End it as stopped: ${stopWith}`);
      }
      const approvals = approvalVerdict(join(root, ".sdlc", "runs", a.runId), a.runId, { projectRoot: root });
      if (!approvals.held) {
        return refuse(`run ${a.runId} cannot end as completed: ${approvals.reason}. An approved artifact changes only on the person's revise, recorded with plugin/scripts/record-gate.mjs, and its gate approving it again. Nothing is written. Show the person what changed and record their answer, or end the run as stopped: ${stopWith}`);
      }
    }
    endRun(root, a.runId, { outcome: a.outcome, reason: filled(a.reason), needs: filled(a.needs) });
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
