/**
 * The write guard of a headless run. agy's print mode loads no hooks
 * (p1-agy-runtime.md check 1), so nothing refuses a write while the run is
 * live; the record says so, and a check after the run lists every file the
 * run changed that its contract does not allow.
 */
import { spawnSync } from "node:child_process";

import { matchGlob } from "./hooks/write-contract-check.mjs";
import { HARDCODED_OFF_LIMITS } from "../scripts/lib/off-limits.mjs";
import { contractState, readContract, runEnded } from "../scripts/lib/contract-state.mjs";
import { endRun } from "../scripts/write-contract.mjs";

export const HEADLESS_GUARD_REASON =
  "agy print mode loads no hooks (docs/verification/p1-agy-runtime.md check 1), so no write was refused during this run";

/** `git status` entries (`XY path`), or null outside a git project. */
export function gitStatus(root, run = spawnSync) {
  const r = run("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  // A rename's source path follows its entry with no status prefix; only `XY path` entries are kept.
  return String(r.stdout).split("\0").filter((e) => e.length > 3 && e[2] === " ");
}

const pathOf = (entry) => entry.slice(3);

/** Files whose status changed between the two snapshots, `.sdlc/` aside. */
export function changedSince(before, after) {
  const seen = new Set(before ?? []);
  return [...new Set((after ?? []).filter((e) => !seen.has(e)).map(pathOf))].filter((p) => !p.startsWith(".sdlc/"));
}

/** The changed paths a contract does not allow: always-off-limits, its off_limits, or outside its allowlist. */
export function outsideContract(paths, contract) {
  const any = (p, list, anyCase) => (list ?? []).some((g) => matchGlob(p, g, { anyCase }) || matchGlob(p, `**/${g}`, { anyCase }));
  return paths.filter((p) => any(p, HARDCODED_OFF_LIMITS, true) || any(p, contract?.off_limits, true) || !(contract?.allowlist ?? []).some((g) => matchGlob(p, g)));
}

/**
 * The run record's `write_guard`, and the contract of this run switched off
 * once the driver loop ends, so it does not go on holding the project.
 */
export function finishWriteGuard({ projectRoot, runId, statusBefore, outcome, status = gitStatus }) {
  const guard = { state: "off", reason: HEADLESS_GUARD_REASON };
  const contract = readContract(projectRoot)?.parsed;
  if (contract?.run_id !== runId) return guard;
  const changed = changedSince(statusBefore, status(projectRoot));
  const outside = outsideContract(changed, contract);
  guard.contract = { run_id: runId, allowlist: contract.allowlist ?? [], off_limits: contract.off_limits ?? [] };
  guard.after_run_check = { files_changed: changed.length, outside_contract: outside };
  if (contractState(projectRoot).binding && !runEnded(projectRoot, runId)) {
    endRun(projectRoot, runId, { outcome, reason: "the headless driver loop ended" });
    guard.contract_closed = outcome;
  }
  return guard;
}
