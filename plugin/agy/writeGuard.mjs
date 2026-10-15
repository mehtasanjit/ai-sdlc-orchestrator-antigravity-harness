/**
 * The write guard of a headless run. agy 1.3.5's print mode loads the plugin's
 * hooks and enforces a refusal; agy 1.2.5's loaded none (p1-agy-runtime.md
 * check 1). The record says which held, from the hook's own decisions for this
 * run, and a check after the run lists every file the run changed that its
 * contract does not allow.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { matchGlob } from "./hooks/write-contract-check.mjs";
import { HARDCODED_OFF_LIMITS } from "../scripts/lib/off-limits.mjs";
import { contractState, readContract, runEnded } from "../scripts/lib/contract-state.mjs";
import { LAUNCHER_STOP_REASON, endRun } from "../scripts/write-contract.mjs";

export const NO_CONTRACT_REASON = "no write contract was frozen for this run, so the hook had nothing to judge (a greenfield run takes none)";
export const NO_HOOK_DECISION_REASON =
  "the write hook recorded no decision for this run: agy loaded no hooks (print mode before agy 1.3.5 loads none, p1-agy-runtime.md check 1), or the run wrote nothing";

/** The hook's decisions that name this run, from the project's `.sdlc/local/guard-decisions.jsonl`. */
export function hookDecisions(projectRoot, runId) {
  const path = join(projectRoot, ".sdlc", "local", "guard-decisions.jsonl");
  if (!existsSync(path)) return { judged: 0, refused: 0, paths: [] };
  const mine = readFileSync(path, "utf8").split("\n").flatMap((l) => { try { const d = JSON.parse(l); return d?.run_id === runId ? [d] : []; } catch { return []; } });
  const rel = (p) => (isAbsolute(p) ? relative(projectRoot, p) : p).split(sep).join("/");
  const paths = [...new Set(mine.flatMap((d) => [...(d.paths ?? []), ...(d.path ? [d.path] : [])]).map(rel))];
  return { judged: mine.length, refused: mine.filter((d) => d.decision === "deny").length, paths };
}

/** Changed paths no hook decision for the run named: a file, or anything under a judged `node_modules/`. */
export function unjudgedChanges(changed, judgedPaths) {
  const judged = new Set(judgedPaths);
  const underModules = judgedPaths.some((p) => p.startsWith("node_modules/"));
  return changed.filter((p) => !judged.has(p) && !(underModules && p.startsWith("node_modules/")));
}

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

const SNAPSHOT_FILE = "git-status-at-launch.json";

/** Keeps the first launch's snapshot in the run folder, so a --resume checks the whole run, not its last launch. */
export function saveLaunchSnapshot(outputDir, snapshot) {
  if (snapshot) writeFileSync(join(outputDir, SNAPSHOT_FILE), JSON.stringify(Object.fromEntries(snapshot)) + "\n");
}

export function loadLaunchSnapshot(outputDir) {
  try { return new Map(Object.entries(JSON.parse(readFileSync(join(outputDir, SNAPSHOT_FILE), "utf8")))); } catch { return null; }
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
  const contract = readContract(projectRoot)?.parsed;
  if (contract?.run_id !== runId) return { state: "off", reason: NO_CONTRACT_REASON };
  const hook = hookDecisions(projectRoot, runId);
  const changed = changedSince(statusBefore, status(projectRoot));
  const outside = outsideContract(changed, contract);
  const unjudged = unjudgedChanges(changed, hook.paths);
  const guard = hook.judged
    ? {
        state: "hook",
        reason: `the write hook judged ${hook.judged} write(s) of this run and refused ${hook.refused}` +
          (unjudged.length ? `; ${unjudged.length} changed file(s) reached disk without a hook decision` : ""),
        hook_decisions: { judged: hook.judged, refused: hook.refused },
      }
    : { state: "off", reason: NO_HOOK_DECISION_REASON };
  guard.contract = { run_id: runId, allowlist: contract.allowlist ?? [], off_limits: contract.off_limits ?? [] };
  guard.after_run_check = { files_changed: changed.length, outside_contract: outside, unjudged_changes: unjudged };
  if (contractState(projectRoot).binding && !runEnded(projectRoot, runId)) {
    endRun(projectRoot, runId, { outcome, reason: LAUNCHER_STOP_REASON });
    guard.contract_closed = outcome;
  }
  return guard;
}
