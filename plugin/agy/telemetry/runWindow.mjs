/**
 * A run's own start, end and outcome, read from its folder: the `run.start`
 * and `run.end` lines plugin/scripts/mmo-log.mjs appends to orchestrator.log,
 * gates.jsonl, SUMMARY.md, run-end.json and the test record.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { LAUNCHER_STOP_REASON } from "../../scripts/write-contract.mjs";
import { GATE_RECORD_WRITER, readGateLines } from "../../scripts/lib/gate-record.mjs";

// MMO_LOG_PREFIX can change the prefix, so a marker is found by what follows it.
const MARKER = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) +[A-Z]+ +(run\.start|run\.end)(?: (.*))?$/;
const PAIR = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;

export const FINAL_GATE = 4;

/** Fields of one logfmt tail, in the format plugin/scripts/lib/log.mjs writes. */
export function parseLogfmt(tail) {
  const out = {};
  for (const [, key, raw] of (tail ?? "").matchAll(PAIR)) {
    out[key] = raw.startsWith("\"")
      ? raw.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c))
      : raw;
  }
  return out;
}

const isoOrNull = (value) => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * The first `run.start` and the last `run.end` this run logged. A `run.start`
 * may carry `started_at` (the time the entry command recorded at its first
 * step, before the run folder existed); it is the run's start when it is not
 * later than the line itself.
 */
export function readRunMarkers(runDir, runId = null) {
  const lines = ["orchestrator.log.1", "orchestrator.log"]
    .map((f) => join(runDir, f))
    .filter((p) => existsSync(p))
    .flatMap((p) => readFileSync(p, "utf8").split("\n"));
  const markers = [];
  for (const line of lines) {
    const m = MARKER.exec(line);
    if (!m) continue;
    const fields = parseLogfmt(m[3]);
    if (runId && fields.run_id && fields.run_id !== runId) continue;
    markers.push({ event: m[2], at: isoOrNull(m[1]), fields });
  }
  const first = markers.find((m) => m.event === "run.start");
  const last = markers.filter((m) => m.event === "run.end").at(-1);
  const declared = isoOrNull(first?.fields.started_at);
  const start = first ? (declared && declared <= first.at ? declared : first.at) : null;
  const end = last && (!start || last.at >= start) ? last.at : null;
  const outcome = end ? last.fields.outcome ?? null : null;
  return {
    start, end, outcome,
    mode: first?.fields.mode ?? null,
    stop: outcome === "stopped" ? { reason: last.fields.reason ?? null, needs: last.fields.needs ?? null } : null,
    start_declared: Boolean(first && declared && start === declared),
  };
}

const seconds = (start, end) => Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));

/**
 * The window the run's session spanned. `exact` holds when both ends were
 * recorded as the run's own start and end, by the headless launcher or by the
 * markers; otherwise a missing end is filled from the dispatches and the
 * window is a lower bound.
 */
export function sessionWindow({ launcher = null, markers = {}, dispatch = null }) {
  if (launcher?.started_at && launcher?.ended_at) {
    return { start: launcher.started_at, end: launcher.ended_at, duration_sec: seconds(launcher.started_at, launcher.ended_at), anchor: "launcher", exact: true };
  }
  const start = markers.start ?? dispatch?.start ?? null;
  let end = markers.end ?? dispatch?.end ?? null;
  if (start && end && end < start) end = start;
  if (!start || !end) return { start, end, duration_sec: null, anchor: "none", exact: false };
  const anchor = markers.start && markers.end ? "markers" : markers.start || markers.end ? "markers+dispatches" : "dispatches";
  return { start, end, duration_sec: seconds(start, end), anchor, exact: anchor === "markers" };
}

/**
 * One entry per gates.jsonl line that names a gate; null when the file is
 * absent. A line plugin/scripts/record-gate.mjs wrote keeps its SHA-256, the
 * reply it recorded and `written_by`; a hand-written one has none of them.
 */
export function readGates(runDir) {
  const lines = readGateLines(runDir);
  if (lines === null) return null;
  return lines
    .filter((g) => g.gate != null)
    .map((g) => ({
      gate: Number.isFinite(Number(g.gate)) ? Number(g.gate) : g.gate,
      decision: g.decision ?? null,
      ...(g.artifact ? { artifact: g.artifact } : {}),
      ...(g.ts ? { ts: g.ts } : {}),
      ...(g.written_by === GATE_RECORD_WRITER
        ? { sha256: g.sha256 ?? null, ...(g.condition ? { condition: g.condition } : {}), reply: g.reply ?? null, written_by: g.written_by }
        : {}),
    }));
}

const accepted = (decision) => /^(auto-)?(approved?|accept(ed)?)$/i.test(String(decision ?? "").trim());
// Gate 4's `reject: <comments>` sends the run back to revise; only an abort ends it.
const aborted = (decision) => /^(auto-)?abort(ed)?$/i.test(String(decision ?? "").trim());

/**
 * `completed`: SUMMARY.md written during this run and the final gate accepted
 * (the headless launcher's own verdict when it recorded one), and, when
 * `tests` says the run has a test command, a passing test record, and, when
 * `approvals` is given, every gate-approved artifact as its gate approved it.
 * Once a run has record-gate lines, a hand-written line decides nothing.
 * `status`: interrupted, aborted, stopped (the run's own stop record: a
 * `run.end` line or a run-end.json the launcher did not write), completed,
 * awaiting_acceptance (the report exists, the final gate has no accepting
 * line yet) or incomplete.
 */
export function runOutcome({ runDir, gates, launcher = null, markers = {}, since = null, tests = null, end = null, approvals = null }) {
  const summaryPath = join(runDir, "SUMMARY.md");
  // A second's slack for filesystems that store whole-second mtimes.
  const summary = existsSync(summaryPath) && (!since || statSync(summaryPath).mtimeMs >= Date.parse(since) - 1000);
  const all = gates ?? [];
  const counted = all.some((g) => g.written_by === GATE_RECORD_WRITER) ? all.filter((g) => g.written_by === GATE_RECORD_WRITER) : all;
  const last = new Map(counted.map((g) => [g.gate, g.decision]));
  const finalAccepted = accepted(last.get(FINAL_GATE));
  const finished = typeof launcher?.completed === "boolean" ? launcher.completed : summary && finalAccepted;
  const testsHeld = !tests?.required || tests.passed === true;
  const approvalsHeld = !approvals || approvals.held;
  const completed = finished && testsHeld && approvalsHeld;
  const stop = markers.stop ?? (end?.outcome === "stopped" && end.reason !== LAUNCHER_STOP_REASON ? { reason: end.reason ?? null, needs: end.needs ?? null } : null);
  const status = launcher?.interrupted ? "interrupted"
    : [...last.values()].some(aborted) || aborted(markers.outcome) ? "aborted"
    : stop ? "stopped"
    : completed ? "completed"
    : summary && testsHeld && approvalsHeld ? "awaiting_acceptance"
    : "incomplete";
  const why = [...(testsHeld ? [] : [`the run's tests did not pass: ${tests.reason}`]), ...(approvalsHeld ? [] : [approvals.reason])];
  const ignored = all.length - counted.length;
  return {
    completed, status, summary_written: summary,
    ...(stop ? { stop } : {}),
    ...(summary && why.length ? { incomplete_reason: why.join("; ") } : {}),
    ...(ignored ? { gate_lines_ignored: ignored } : {}),
  };
}

/**
 * This folder's run id when no caller named one: the only run its telemetry
 * names, or the folder's own name when that is one of them. A folder holding
 * several runs' lines has no single answer, and guessing one would book
 * another run's dollars as this run's.
 */
export function inferRunId(runDir, events) {
  const passes = [...new Set(events.map((e) => e?.pass).filter((p) => p != null))];
  if (passes.length <= 1) return passes[0] ?? null;
  if (passes.includes(basename(runDir))) return basename(runDir);
  throw new Error(`${runDir} holds lines from ${passes.length} runs (${passes.join(", ")}); pass --run-id to name the run.`);
}
