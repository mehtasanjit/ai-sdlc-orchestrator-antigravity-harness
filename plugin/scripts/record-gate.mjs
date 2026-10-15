#!/usr/bin/env node
/**
 * Records one gate answer in the run's gates.jsonl, by code: the decision,
 * the artifact the gate reviewed (project-relative), its SHA-256 at this
 * moment, and the reply verbatim as the conductor received it
 * (lib/gate-record.mjs reads the record).
 *
 * Usage:
 *   node record-gate.mjs --run-id=<id> --gate=<0-4> --decision=<decision> --artifact=<path> --reply="<the reply, verbatim>"
 *                        [--project-root=<dir>] [--output-dir=<run folder>]
 *
 * Decisions: approved, accepted, revise, reject, abort; approved-conditional
 * (Gate 0 only: a file the freeze marked --conditional, which the hook
 * refuses until this is recorded); auto-approved and auto-aborted (a headless
 * gate mode's, with no --reply). `--artifact` is relative to the project root;
 * a file in the run folder is recorded as `.sdlc/runs/<run-id>/<file>` wherever
 * --output-dir puts the folder, which is how lib/gate-record.mjs finds it.
 *
 * Exit 0 = recorded, 2 = refused or usage.
 */
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { RUN_ID, contractState, readContract, runEnded } from "./lib/contract-state.mjs";
import { APPROVING, CONDITIONAL_APPROVAL, GATE_RECORD_WRITER, GATES_FILE, MODE_DECISIONS, PERSON_DECISIONS, approvalState, readGateLines, sha256File } from "./lib/gate-record.mjs";
import { isMain } from "./lib/is-main.mjs";
import { matchGlob } from "../agy/hooks/write-contract-check.mjs";

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const USAGE = "usage: --run-id=<id> --gate=<0-4> --decision=<approved|accepted|revise|reject|abort|approved-conditional|auto-approved|auto-aborted> --artifact=<project-relative path> --reply=\"<the reply, verbatim>\" [--project-root=<dir>] [--output-dir=<run folder>]";

const toPosix = (p) => (sep === "/" ? p : p.split(sep).join("/"));

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/** `abs` relative to `dir` in posix form, as written or once links are followed; null when outside. */
function under(dir, abs) {
  for (const [d, a] of [[dir, abs], [real(dir), real(abs)]]) {
    const rel = toPosix(relative(d, a));
    if (rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) return rel;
  }
  return null;
}

const short = (sha) => (sha ? `${sha.slice(0, 12)}…` : "none");

/** Appends one gate line, or says why not. Returns `{ ok, line?, error? }`. */
export function recordGate({ runId, gate, decision, artifact, reply, projectRoot = process.cwd(), outputDir = null, now = () => new Date().toISOString() }) {
  const no = (error) => ({ ok: false, error });
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return no(`--run-id must be the run's id. ${USAGE}`);
  if (!/^[0-4]$/.test(String(gate ?? ""))) return no(`--gate must be 0, 1, 2, 3 or 4. ${USAGE}`);
  if (!PERSON_DECISIONS.has(decision) && !MODE_DECISIONS.has(decision)) return no(`--decision ${JSON.stringify(decision ?? "")} is not one of ${[...PERSON_DECISIONS, ...MODE_DECISIONS].join(", ")}`);
  const fromPerson = PERSON_DECISIONS.has(decision);
  if (fromPerson && !(typeof reply === "string" && reply.trim())) {
    return no(`a ${decision} records the person's reply, verbatim as you received it: --reply="<their reply>". Nothing is written. A gate nobody answered is not ${decision}.`);
  }
  if (!fromPerson && reply !== undefined) return no(`${decision} is a headless gate mode's decision: no person replied, so it takes no --reply`);
  if (decision === CONDITIONAL_APPROVAL && Number(gate) !== 0) return no(`${CONDITIONAL_APPROVAL} is a Gate 0 decision: it opens a file Gate 0 froze as conditional`);
  if (typeof artifact !== "string" || !artifact.trim()) return no(`--artifact names the file the gate reviewed, relative to the project root (.sdlc/runs/${runId}/requirements.md). ${USAGE}`);

  const root = resolve(projectRoot);
  const runDir = outputDir ? resolve(outputDir) : join(root, ".sdlc", "runs", runId);
  const abs = resolve(root, artifact);
  const inRun = under(runDir, abs);
  const rel = inRun ? `.sdlc/runs/${runId}/${inRun}` : under(root, abs);
  if (!rel) return no(`${artifact} lies outside the project ${root} and the run folder ${runDir}`);
  if (runEnded(root, runId)) return no(`run ${runId} has ended; its gate record is closed`);

  const sha256 = sha256File(abs);
  const extra = {};

  if (decision === CONDITIONAL_APPROVAL) {
    const state = contractState(root);
    if (!state.binding || state.runId !== runId || state.tampered) return no(`run ${runId} holds no live write contract in ${root}, so it has no conditional file to approve`);
    const entries = Array.isArray(readContract(root)?.parsed?.conditional) ? readContract(root).parsed.conditional : [];
    const entry = entries.find((e) => typeof e?.path === "string" && (e.path === rel || matchGlob(rel, e.path)));
    if (!entry) {
      return no(`${rel} is not a conditional file of run ${runId}${entries.length ? ` (Gate 0 froze ${entries.map((e) => JSON.stringify(e.path)).join(", ")})` : " (Gate 0 froze none)"}. A wider scope is the person's decision, for a new run with its own Gate 0.`);
    }
    extra.condition = entry.condition ?? null;
  } else if (APPROVING.has(decision)) {
    if (!sha256) return no(`no file at ${rel}: a gate approves the file it reviewed, and its SHA-256 is taken now. --artifact is relative to the project root (.sdlc/runs/${runId}/requirements.md)`);
    const previous = approvalState(readGateLines(runDir)).approved.get(rel);
    if (previous && previous.sha256 !== sha256) {
      return no(
        `${rel} changed after Gate ${previous.gate} approved it (recorded ${short(previous.sha256)}, now ${short(sha256)}), and no revise was recorded. ` +
          `An approved artifact changes only on the person's revise: record their answer first (--decision=revise --reply="<their reply, verbatim>"), then this approval. Nothing is written.`,
      );
    }
  }

  const line = {
    gate: Number(gate),
    decision,
    artifact: rel,
    ...extra,
    sha256,
    reply: fromPerson ? reply : null,
    ts: now(),
    run_id: runId,
    written_by: GATE_RECORD_WRITER,
  };
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, GATES_FILE), JSON.stringify(line) + "\n");
  return { ok: true, line, path: join(runDir, GATES_FILE) };
}

export function main(argv = process.argv.slice(2), { log = (m) => process.stdout.write(`${m}\n`), fail = (m) => process.stderr.write(`record-gate: ${m}\n`) } = {}) {
  const a = parseArgs(argv);
  const r = recordGate({
    runId: a["run-id"],
    gate: a.gate,
    decision: a.decision,
    artifact: a.artifact,
    reply: typeof a.reply === "string" ? a.reply : undefined,
    projectRoot: typeof a["project-root"] === "string" ? a["project-root"] : process.cwd(),
    outputDir: typeof a["output-dir"] === "string" ? a["output-dir"] : null,
  });
  if (!r.ok) { fail(r.error); return 2; }
  log(`record-gate: Gate ${r.line.gate} ${r.line.decision} for ${r.line.artifact} (sha256 ${short(r.line.sha256)}) recorded in ${r.path}`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
