/**
 * A run's gate record, `<run folder>/gates.jsonl`, read the same way by the
 * write hook, the close-out (write-contract.mjs --close), the manifest and
 * the headless launcher. plugin/scripts/record-gate.mjs writes each line: the
 * decision, the artifact (project-relative), its SHA-256 when the answer
 * came, the reply as the conductor relayed it, and `prev_sha256`, the
 * SHA-256 of the record's bytes before the line.
 *
 * A line without `written_by` naming record-gate.mjs was written by hand, as
 * every run before record-gate did. It still loads, but it locks nothing,
 * opens no conditional file, and in a run that has record-gate lines it
 * decides nothing.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** The headless launcher's record of the gate mode it launched the run in, written before agy starts. */
export const GATE_MODE_FILE = "gate-mode.json";
export const GATE_MODE_WRITER = "plugin/agy/run.mjs";
export const gateModeRelPath = (runId) => `.sdlc/runs/${runId}/${GATE_MODE_FILE}`;
export const MODE_DECISION = { "auto-approve": "auto-approved", "auto-abort": "auto-aborted" };

export const MAX_REPLY_BYTES = 16 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const LOCK_FILE = "contract.lock.json";

export const codeWritten = (line) => line?.written_by === GATE_RECORD_WRITER;

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return sha256Bytes(readFileSync(path));
  } catch {
    return null;
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** gates.jsonl's bytes; null when absent, `{ problem }` when it cannot be read as a record. */
function gateBytes(runDir) {
  const path = join(runDir, GATES_FILE);
  let st;
  try { st = statSync(path); } catch { return null; }
  if (!st.isFile()) return { problem: `${GATES_FILE} is not a file` };
  if (st.size > MAX_BYTES) return { problem: `${GATES_FILE} is ${st.size} bytes, over the ${MAX_BYTES} a gate record is read up to` };
  try { return { bytes: readFileSync(path) }; } catch { return null; }
}

/**
 * `{ lines, problem }` for the run's gates.jsonl, every parsed line in file
 * order; null when the file is absent. `problem` says why the record cannot
 * be trusted to say what its gates approved: it is too large to read, it
 * no longer begins with the bytes it held when Gate 0 froze the contract
 * (`gate_record` in contract.lock.json), a record-gate line's `prev_sha256`
 * is not the SHA-256 of the bytes before it, or a line after the first
 * record-gate line does not parse.
 */
export function readGateRecord(runDir, runId = null) {
  const read = gateBytes(runDir);
  const anchor = readJson(join(runDir, LOCK_FILE));
  const frozen = (!runId || anchor?.run_id === runId) && anchor?.gate_record && typeof anchor.gate_record === "object" ? anchor.gate_record : null;
  const lost = frozen ? `${GATES_FILE} no longer begins with the ${frozen.bytes} bytes it held when Gate 0 froze the contract (${LOCK_FILE}): a line recorded before the freeze was edited or removed` : null;
  if (read === null) return frozen ? { lines: [], problem: lost } : null;
  if (read.problem) return { lines: [], problem: read.problem };
  const { bytes } = read;
  const lines = [];
  let unparsed = 0;
  let broken = null;
  let coded = false;
  const before = createHash("sha256");
  for (let start = 0, n = 1; start < bytes.length; n++) {
    const nl = bytes.indexOf(0x0a, start);
    const end = nl === -1 ? bytes.length : nl + 1;
    const text = bytes.subarray(start, end).toString("utf8");
    if (text.trim()) {
      let line = null;
      try { line = JSON.parse(text); } catch { line = null; }
      if (line && typeof line === "object") {
        if (codeWritten(line)) {
          coded = true;
          if (broken === null && line.prev_sha256 !== before.copy().digest("hex")) broken = n;
        }
        lines.push(line);
      } else if (coded) unparsed++;
    }
    before.update(bytes.subarray(start, end));
    start = end;
  }
  const problem =
    frozen && !(Number.isInteger(frozen.bytes) && bytes.length >= frozen.bytes && sha256Bytes(bytes.subarray(0, frozen.bytes)) === frozen.sha256) ? lost
    : broken !== null ? `line ${broken} of ${GATES_FILE} does not follow the record before it (its prev_sha256 differs): an earlier line was edited or removed`
    : unparsed ? `${unparsed} line(s) of ${GATES_FILE} after its first record-gate line do not parse`
    : null;
  return { lines, problem };
}

/** Every parsed line of the run's gates.jsonl, in file order; null when the file is absent. */
export function readGateLines(runDir) {
  const record = readGateRecord(runDir);
  return record ? record.lines : null;
}

/** What contract.lock.json keeps of the gate record at the freeze: its length and SHA-256, or null when there is none. */
export function gateRecordAnchor(runDir) {
  const read = gateBytes(runDir);
  return read?.bytes?.length ? { bytes: read.bytes.length, sha256: sha256Bytes(read.bytes) } : null;
}

export function recordGateMode(runDir, runId, mode, { now = () => new Date().toISOString() } = {}) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, GATE_MODE_FILE), JSON.stringify({ run_id: runId, gates: mode, written_by: GATE_MODE_WRITER, at: now() }, null, 2) + "\n");
}

/** The gate mode the headless launcher recorded for this run, or null (a chat). */
export function launcherGateMode(runDir, runId) {
  const rec = readJson(join(runDir, GATE_MODE_FILE));
  return rec?.written_by === GATE_MODE_WRITER && rec.run_id === runId && Object.hasOwn(MODE_DECISION, rec.gates) ? rec.gates : null;
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
 * `record_problem` is set when the record itself cannot be trusted
 * (readGateRecord), which never holds.
 */
export function approvalVerdict(runDir, runId = null, { projectRoot = null } = {}) {
  const record = readGateRecord(runDir, runId);
  const lines = record?.lines ?? [];
  const problem = record?.problem ?? null;
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
  const reasons = [...(problem ? [`the gate record cannot be trusted: ${problem}`] : []), ...(changed.length ? [describeChanged(changed)] : [])];
  const held = reasons.length === 0;
  return {
    held,
    checked: approved.size,
    changed,
    ...(unchecked.length ? { unchecked } : {}),
    ...(problem ? { record_problem: problem } : {}),
    ...(held ? {} : { reason: reasons.join("; ") }),
  };
}

export function describeChanged(changed) {
  const one = (c) => c.state === "reopened"
    ? `${c.path} (re-opened by a ${c.decision} at Gate ${c.gate}, never approved again)`
    : `${c.path} (${c.state === "missing" ? "deleted" : "changed"} after Gate ${c.gate} approved it)`;
  return `approved artifact(s) no longer match their gate record: ${changed.map(one).join("; ")}`;
}
