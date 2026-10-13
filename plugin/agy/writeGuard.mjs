/**
 * The write guard of a headless run. agy's print mode loads no hooks
 * (p1-agy-runtime.md check 1), so nothing refuses a write while the run is
 * live; the record says so, and a check after the run lists every file the
 * run changed that its contract does not allow.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import { matchGlob } from "./hooks/write-contract-check.mjs";
import { HARDCODED_OFF_LIMITS } from "../scripts/lib/off-limits.mjs";
import { contractState, readContract, runEnded } from "../scripts/lib/contract-state.mjs";
import { endRun } from "../scripts/write-contract.mjs";

export const HEADLESS_GUARD_REASON =
  "agy print mode loads no hooks (docs/verification/p1-agy-runtime.md check 1), so no write was refused during this run";

/**
 * A snapshot of the files git sees as changed, untracked or ignored, each
 * with its status, mtime and size: `Map<path, signature>`, or null outside a
 * git project. Ignored files are in it (`--ignored=matching`), so a write to
 * `.env` or into `dist/` shows; an ignored folder is one entry whose mtime
 * moves when an entry directly in it is added or removed.
 */
export function gitStatus(root, run = spawnSync, stat = statSync) {
  const r = run("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const snapshot = new Map();
  // A rename's source path follows its entry with no status prefix; only `XY path` entries are kept.
  for (const entry of String(r.stdout).split("\0").filter((e) => e.length > 3 && e[2] === " ")) {
    const path = entry.slice(3);
    let sig = entry.slice(0, 2);
    try { const st = stat(join(root, path)); sig += `|${st.mtimeMs}|${st.size}`; } catch { sig += "|gone"; }
    snapshot.set(path, sig);
  }
  return snapshot;
}

/** Paths whose status or content signature differs between the snapshots, the plugin's own `.sdlc/` aside. */
export function changedSince(before, after) {
  const a = before ?? new Map();
  const b = after ?? new Map();
  const paths = new Set([...b.keys(), ...a.keys()]);
  return [...paths].filter((p) => a.get(p) !== b.get(p) && !p.startsWith(".sdlc/")).sort();
}

/** The changed paths a contract does not allow: always-off-limits, its off_limits, or outside its allowlist. */
export function outsideContract(paths, contract) {
  // An ignored folder is listed as `dir/`: judged as the folder and as anything under it.
  const any = (p, list, anyCase) => (list ?? []).some((g) => [p, p.endsWith("/") ? `${p}x` : p].some((q) => matchGlob(q, g, { anyCase }) || matchGlob(q, `**/${g}`, { anyCase })));
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
