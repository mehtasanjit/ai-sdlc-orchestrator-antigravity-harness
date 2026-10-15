/**
 * A run's gate record, `<run folder>/gates.jsonl`, read the same way by the
 * write hook, the close-out (write-contract.mjs --close), the manifest and
 * the headless launcher. plugin/scripts/record-gate.mjs writes each line: the
 * decision, the artifact (project-relative), its SHA-256 when the answer
 * came, and the reply as the conductor relayed it.
 *
 * A line without `written_by` naming record-gate.mjs was written by hand, as
 * every run before record-gate did. It still loads, but it locks nothing,
 * opens no conditional file, and in a run that has record-gate lines it
 * decides nothing.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { projectRootOf } from "./test-record.mjs";

export const GATES_FILE = "gates.jsonl";
export const GATE_RECORD_WRITER = "plugin/scripts/record-gate.mjs";
export const gatesRelPath = (runId) => `.sdlc/runs/${runId}/${GATES_FILE}`;

export const APPROVING = new Set(["approved", "accepted", "auto-approved"]);
export const REOPENING = new Set(["revise", "reject"]);
export const CONDITIONAL_APPROVAL = "approved-conditional";
/** Decisions a person's reply carries; `auto-*` are a headless gate mode's, with no reply. */
export const PERSON_DECISIONS = new Set(["approved", "accepted", CONDITIONAL_APPROVAL, "revise", "reject", "abort"]);
export const MODE_DECISIONS = new Set(["auto-approved", "auto-aborted"]);

const MAX_BYTES = 4 * 1024 * 1024;

export const codeWritten = (line) => line?.written_by === GATE_RECORD_WRITER;

/** Every parsed line of the run's gates.jsonl, in file order; null when the file is absent. */
export function readGateLines(runDir) {
  let text;
  try {
    const st = statSync(join(runDir, GATES_FILE));
    if (!st.isFile() || st.size > MAX_BYTES) return [];
    text = readFileSync(join(runDir, GATES_FILE), "utf8");
  } catch {
    return null;
  }
  return text.split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((g) => g && typeof g === "object");
}

export function sha256File(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * `approved`: the artifacts whose last record-gate line approves them, as
 * `Map<artifact, line>`. `reopened`: those approved once whose last line is
 * a revise or reject, with that line.
 */
export function approvalState(lines) {
  const last = new Map();
  const everApproved = new Set();
  for (const l of lines ?? []) {
    if (!codeWritten(l) || typeof l.artifact !== "string") continue;
    if (!APPROVING.has(l.decision) && !REOPENING.has(l.decision)) continue;
    last.set(l.artifact, l);
    if (APPROVING.has(l.decision)) everApproved.add(l.artifact);
  }
  const approved = new Map([...last].filter(([, l]) => APPROVING.has(l.decision)));
  const reopened = [...last].filter(([a, l]) => REOPENING.has(l.decision) && everApproved.has(a)).map(([, l]) => l);
  return { approved, reopened };
}

/** The paths or globs Gate 0 approved under a condition, from record-gate lines. */
export function conditionalApprovals(lines) {
  return (lines ?? [])
    .filter((l) => codeWritten(l) && l.decision === CONDITIONAL_APPROVAL && Number(l.gate) === 0 && typeof l.artifact === "string")
    .map((l) => l.artifact);
}

/** Where an artifact recorded as project-relative lies: the run folder for its own files, else the project. */
function artifactPath(artifact, { runDir, runId, root }) {
  const own = runId ? `.sdlc/runs/${runId}/` : null;
  if (own && artifact.startsWith(own)) return join(runDir, artifact.slice(own.length));
  return root ? join(root, artifact) : null;
}

/**
 * Whether every artifact a gate approved is still the one it approved.
 * `changed` lists each approved artifact whose bytes differ from the SHA-256
 * its approval recorded (`missing` when it is gone), and each one a revise
 * or reject re-opened and no later approval closed. `unchecked` lists the
 * ones outside the run folder when the project root is not known.
 */
export function approvalVerdict(runDir, runId = null, { projectRoot = null } = {}) {
  const lines = readGateLines(runDir) ?? [];
  const root = projectRoot ? resolve(projectRoot) : projectRootOf(runDir, runId);
  const { approved, reopened } = approvalState(lines);
  const changed = [];
  const unchecked = [];
  for (const [artifact, line] of approved) {
    const path = artifactPath(artifact, { runDir, runId, root });
    if (!path) { unchecked.push(artifact); continue; }
    const current = sha256File(path);
    if (current !== line.sha256) {
      changed.push({ path: artifact, gate: line.gate, state: current ? "changed" : "missing", approved_sha256: line.sha256 ?? null, current_sha256: current });
    }
  }
  for (const line of reopened) {
    changed.push({ path: line.artifact, gate: line.gate, state: "reopened", decision: line.decision });
  }
  const held = changed.length === 0;
  return {
    held,
    checked: approved.size,
    changed,
    ...(unchecked.length ? { unchecked } : {}),
    ...(held ? {} : { reason: describeChanged(changed) }),
  };
}

export function describeChanged(changed) {
  const one = (c) => c.state === "reopened"
    ? `${c.path} (re-opened by a ${c.decision} at Gate ${c.gate}, never approved again)`
    : `${c.path} (${c.state === "missing" ? "deleted" : "changed"} after Gate ${c.gate} approved it)`;
  return `approved artifact(s) no longer match their gate record: ${changed.map(one).join("; ")}`;
}
