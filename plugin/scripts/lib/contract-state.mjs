/**
 * Whether a brownfield write contract binds, read the same way by the hook
 * (plugin/agy/hooks/write-contract-check.mjs), the code that writes it
 * (plugin/scripts/write-contract.mjs) and the headless launcher.
 *
 * Three files, all code-written:
 *   .sdlc/local/write-contract.json        the contract (allowlist, off_limits, run_id, active)
 *   .sdlc/runs/<run-id>/contract.lock.json the SHA-256 of the contract's bytes at --freeze
 *   .sdlc/runs/<run-id>/run-end.json       the run's end (--close, --abandon, run.mjs)
 *
 * The hook records each decision it takes in .sdlc/local/guard-decisions.jsonl.
 *
 * A contract binds while its run has no end record. A run whose lock is live
 * and whose contract no longer matches it (edited, switched off, deleted,
 * replaced by another run's) is tampered: every write is refused until the
 * person ends that run with --abandon.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";
export const CONTRACT_MAX_BYTES = 128 * 1024;
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const GUARD_DECISIONS_REL_PATH = ".sdlc/local/guard-decisions.jsonl";

export const lockRelPath = (runId) => `.sdlc/runs/${runId}/contract.lock.json`;
export const endRelPath = (runId) => `.sdlc/runs/${runId}/run-end.json`;

/** The nearest folder at or above `start` holding `.git` (a folder or a worktree's file), or null. */
export function gitRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function fingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRegular(path, maxBytes = CONTRACT_MAX_BYTES) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function readJsonFile(path) {
  const bytes = readRegular(path);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString("utf8")); } catch { return null; }
}

/** `{ bytes, parsed }` for the project's contract; `parsed` is null when it does not parse. Null when absent. */
export function readContract(root) {
  const bytes = readRegular(join(root, CONTRACT_REL_PATH));
  if (!bytes) return null;
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { parsed = null; }
  return { bytes, parsed };
}

export function runEnd(root, runId) {
  return RUN_ID.test(String(runId ?? "")) ? readJsonFile(join(root, endRelPath(runId))) : null;
}

export function runEnded(root, runId) {
  return runEnd(root, runId) !== null;
}

export function readLock(root, runId) {
  return RUN_ID.test(String(runId ?? "")) ? readJsonFile(join(root, lockRelPath(runId))) : null;
}

/** Run ids with a freeze lock and no end record. */
export function liveLocks(root) {
  const runs = join(root, ".sdlc", "runs");
  let names = [];
  try { names = readdirSync(runs); } catch { return []; }
  return names.filter((id) => RUN_ID.test(id) && readLock(root, id)?.sha256 && !runEnded(root, id));
}

/**
 * `{ binding: false }`, or `{ binding: true, runId, contract, tampered }`.
 * `tampered` is a sentence when the contract no longer matches a live lock.
 */
export function contractState(root) {
  const c = readContract(root);
  const locks = liveLocks(root);
  if (locks.length > 1) {
    return { binding: true, runId: locks[0], contract: c?.parsed ?? null, tampered: `runs ${locks.join(" and ")} both hold a live freeze record; only one run can hold a project` };
  }
  if (locks.length === 1) {
    const runId = locks[0];
    const lock = readLock(root, runId);
    let tampered = null;
    if (!c) tampered = `the write contract of live run ${runId} is missing`;
    else if (fingerprint(c.bytes) !== lock.sha256) tampered = `the write contract of live run ${runId} changed after Gate 0 froze it`;
    return { binding: true, runId, contract: c?.parsed ?? null, tampered };
  }
  const contract = c?.parsed;
  if (contract && contract.active === true && RUN_ID.test(String(contract.run_id ?? "")) && !runEnded(root, contract.run_id)) {
    return { binding: true, runId: contract.run_id, contract, tampered: null };
  }
  return { binding: false };
}

/** The hook's decisions that name `runId`, in the order it took them. */
export function guardDecisions(root, runId) {
  let text = "";
  try { text = readFileSync(join(root, GUARD_DECISIONS_REL_PATH), "utf8"); } catch { return []; }
  return text.split("\n").flatMap((l) => { try { const d = JSON.parse(l); return d?.run_id === runId ? [d] : []; } catch { return []; } });
}
