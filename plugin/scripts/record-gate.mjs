#!/usr/bin/env node
/**
 * Records one gate answer in the run's gates.jsonl, by code: the decision,
 * the artifact the gate reviewed (project-relative), its SHA-256 at this
 * moment, the reply verbatim as the conductor received it, and the SHA-256
 * of the record before the line (lib/gate-record.mjs reads the record).
 *
 * Usage:
 *   node record-gate.mjs --run-id=<id> --gate=<0-4> --decision=<decision> --artifact=<path>
 *                        --reply-file=.sdlc/runs/<id>/gate-reply.txt [--project-root=<dir>] [--output-dir=<run folder>]
 *
 * The reply is read from a `gate-reply*.txt` file in the run folder, which
 * the conductor writes word for word with its file tool; the file is removed
 * once the line is written. On a shell command line, quoting rewrites a
 * reply and can run parts of it. `--reply=<text>` takes the reply as one
 * argument, for a caller that passes argv without a shell.
 *
 * Decisions: approved, accepted, revise, reject, abort; approved-conditional
 * (Gate 0 only: a file the freeze marked --conditional, which the hook
 * refuses until this is recorded); auto-approved and auto-aborted (a headless
 * gate mode's, with no reply, only in a run plugin/agy/run.mjs launched in
 * that mode). A revise, reject or abort reply begins with that word; an
 * approving reply begins with none of them. `--artifact` is relative to the
 * project root; a file in the run folder is recorded as
 * `.sdlc/runs/<run-id>/<file>` wherever --output-dir puts the folder, which
 * is how lib/gate-record.mjs finds it.
 *
 * Exit 0 = recorded, 2 = refused or usage.
 */
import { appendFileSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { RUN_ID, contractState, gitRoot, readContract, readLock, runEnded } from "./lib/contract-state.mjs";
import {
  APPROVING, CONDITIONAL_APPROVAL, GATES_FILE, GATE_MODE_FILE, GATE_RECORD_WRITER, MAX_REPLY_BYTES, MODE_DECISION, MODE_DECISIONS, PERSON_DECISIONS, REOPENING,
  approvalState, launcherGateMode, readGateRecord, sha256Bytes, sha256File,
} from "./lib/gate-record.mjs";
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

const OPTIONS = new Set(["run-id", "gate", "decision", "artifact", "reply", "reply-file", "project-root", "output-dir"]);

const USAGE = "usage: --run-id=<id> --gate=<0-4> --decision=<approved|accepted|revise|reject|abort|approved-conditional|auto-approved|auto-aborted> --artifact=<project-relative path> --reply-file=.sdlc/runs/<id>/gate-reply.txt [--project-root=<dir>] [--output-dir=<run folder>]";

const REPLY_FILE = /^gate-reply[A-Za-z0-9._-]*\.txt$/;
const REPLY_WORD = /^\s*(revise|reject|abort)/i;

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

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const short = (sha) => (sha ? `${sha.slice(0, 12)}…` : "none");

const quoted = (text) => JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);

/** The reply file's text with one trailing newline dropped, or `{ error }`. */
function readReplyFile(file, { root, runDir, runId }) {
  const abs = resolve(root, file);
  if (!REPLY_FILE.test(basename(abs)) || under(runDir, abs) !== basename(abs)) {
    return { error: `--reply-file names a gate-reply*.txt file directly in the run folder (.sdlc/runs/${runId}/gate-reply.txt), not ${file}` };
  }
  let bytes;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { error: `${file} is not a file` };
    if (st.size > MAX_REPLY_BYTES) return { error: `${file} is ${st.size} bytes; a reply is at most ${MAX_REPLY_BYTES}` };
    bytes = readFileSync(abs);
  } catch {
    return { error: `no reply file at ${file}: write the person's reply there, word for word, with your file tool first` };
  }
  return { text: bytes.toString("utf8").replace(/\r?\n$/, ""), path: abs };
}

/** Why the reply does not give this decision, or null. */
function contradiction(decision, reply) {
  const word = REPLY_WORD.exec(reply)?.[1].toLowerCase() ?? null;
  if (REOPENING.has(decision) || decision === "abort") {
    return word === decision ? null : `a ${decision} is the person's "${decision}${decision === "abort" ? "" : ": <comments>"}", and the reply ${quoted(reply)} does not begin with "${decision}"`;
  }
  return word ? `the reply ${quoted(reply)} begins with "${word}", which is not ${decision}: record --decision=${word}` : null;
}

/** Appends one gate line, or says why not. Returns `{ ok, line?, path?, error? }`. */
export function recordGate({ runId, gate, decision, artifact, reply, replyFile, projectRoot = process.cwd(), outputDir = null, now = () => new Date().toISOString() }) {
  const no = (error) => ({ ok: false, error: `${error}. Nothing is written.` });
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return no(`--run-id must be the run's id. ${USAGE}`);
  if (!/^[0-4]$/.test(String(gate ?? ""))) return no(`--gate must be 0, 1, 2, 3 or 4. ${USAGE}`);
  if (!PERSON_DECISIONS.has(decision) && !MODE_DECISIONS.has(decision)) return no(`--decision ${JSON.stringify(decision ?? "")} is not one of ${[...PERSON_DECISIONS, ...MODE_DECISIONS].join(", ")}`);
  if (reply !== undefined && replyFile !== undefined) return no("give the reply once: --reply-file, or --reply without a shell");

  const root = resolve(projectRoot);
  const top = gitRoot(root);
  if (top && top !== root && readLock(top, runId)) return no(`run ${runId} belongs to the project at ${top}: pass --project-root="${top}"`);
  const runDir = outputDir ? resolve(outputDir) : join(root, ".sdlc", "runs", runId);
  if (!isDir(runDir)) return no(`no run folder at ${runDir}: --project-root is the project the run is in${outputDir ? "" : ", and --output-dir its run folder when that is elsewhere"}`);

  let file = null;
  if (replyFile !== undefined) {
    const r = typeof replyFile === "string" ? readReplyFile(replyFile, { root, runDir, runId }) : { error: "--reply-file names a file" };
    if (r.error) return no(r.error);
    reply = r.text;
    file = r.path;
  }
  const fromPerson = PERSON_DECISIONS.has(decision);
  if (fromPerson) {
    if (!(typeof reply === "string" && reply.trim())) {
      return no(`a ${decision} records the person's reply, verbatim as you received it: write it to .sdlc/runs/${runId}/gate-reply.txt with your file tool and pass --reply-file. A gate nobody answered is not ${decision}`);
    }
    if (Buffer.byteLength(reply) > MAX_REPLY_BYTES) return no(`the reply is ${Buffer.byteLength(reply)} bytes; a reply is at most ${MAX_REPLY_BYTES}`);
    const why = contradiction(decision, reply);
    if (why) return no(`${why}. The decision is the one the person's reply gives`);
  } else {
    if (reply !== undefined) return no(`${decision} is a headless gate mode's decision: no person replied, so it takes no reply`);
    const mode = launcherGateMode(runDir, runId);
    if (MODE_DECISION[mode] !== decision) {
      return no(
        `${decision} is the decision of a run plugin/agy/run.mjs launched unattended, and run ${runId} ` +
          (mode ? `was launched with --gates=${mode}` : `has no launcher record (${GATE_MODE_FILE})`) +
          ". When a person is answering, ask them and record their answer",
      );
    }
  }
  if (decision === CONDITIONAL_APPROVAL && Number(gate) !== 0) return no(`${CONDITIONAL_APPROVAL} is a Gate 0 decision: it opens a file Gate 0 froze as conditional`);
  if (typeof artifact !== "string" || !artifact.trim()) return no(`--artifact names the file the gate reviewed, relative to the project root (.sdlc/runs/${runId}/requirements.md). ${USAGE}`);

  const abs = resolve(root, artifact);
  const inRun = under(runDir, abs);
  const rel = inRun ? `.sdlc/runs/${runId}/${inRun}` : under(root, abs);
  if (!rel) return no(`${artifact} lies outside the project ${root} and the run folder ${runDir}`);
  if (runEnded(root, runId)) return no(`run ${runId} has ended; its gate record is closed`);
  const record = readGateRecord(runDir, runId);
  if (record?.problem) return no(`the gate record of run ${runId} cannot be trusted: ${record.problem}. Ending the run is the person's decision`);

  const sha256 = sha256File(abs);
  const extra = {};

  if (decision === CONDITIONAL_APPROVAL) {
    const state = contractState(root);
    if (!state.binding || state.runId !== runId || state.tampered) return no(`run ${runId} holds no live write contract in ${root}, so it has no conditional file to approve`);
    const entries = Array.isArray(readContract(root)?.parsed?.conditional) ? readContract(root).parsed.conditional : [];
    const entry = entries.find((e) => typeof e?.path === "string" && (e.path === rel || matchGlob(rel, e.path)));
    if (!entry) {
      return no(`${rel} is not a conditional file of run ${runId}${entries.length ? ` (Gate 0 froze ${entries.map((e) => JSON.stringify(e.path)).join(", ")})` : " (Gate 0 froze none)"}. A wider scope is the person's decision, for a new run with its own Gate 0`);
    }
    extra.condition = entry.condition ?? null;
  } else if (APPROVING.has(decision)) {
    if (!sha256) return no(`no file at ${rel}: a gate approves the file it reviewed, and its SHA-256 is taken now. --artifact is relative to the project root (.sdlc/runs/${runId}/requirements.md)`);
    const previous = approvalState(record?.lines).approved.get(rel);
    if (previous && previous.sha256 !== sha256) {
      return no(
        `${rel} changed after Gate ${previous.gate} approved it (recorded ${short(previous.sha256)}, now ${short(sha256)}), and no revise was recorded. ` +
          "An approved artifact changes only on the person's revise: record their answer first (--decision=revise), then this approval",
      );
    }
  }

  const path = join(runDir, GATES_FILE);
  let existing = Buffer.alloc(0);
  try { existing = readFileSync(path); } catch { existing = Buffer.alloc(0); }
  const lead = existing.length && existing[existing.length - 1] !== 0x0a ? "\n" : "";
  const line = {
    gate: Number(gate),
    decision,
    artifact: rel,
    ...extra,
    sha256,
    reply: fromPerson ? reply : null,
    ts: now(),
    run_id: runId,
    prev_sha256: sha256Bytes(Buffer.concat([existing, Buffer.from(lead)])),
    written_by: GATE_RECORD_WRITER,
  };
  appendFileSync(path, lead + JSON.stringify(line) + "\n");
  if (file) rmSync(file, { force: true });
  return { ok: true, line, path };
}

export function main(argv = process.argv.slice(2), { log = (m) => process.stdout.write(`${m}\n`), fail = (m) => process.stderr.write(`record-gate: ${m}\n`) } = {}) {
  const a = parseArgs(argv);
  const unknown = Object.keys(a).filter((k) => !OPTIONS.has(k));
  if (unknown.length) { fail(`unknown option ${unknown.map((k) => `--${k}`).join(", ")}. Nothing is written. ${USAGE}`); return 2; }
  const text = (k) => (typeof a[k] === "string" ? a[k] : a[k] === true ? true : undefined);
  const r = recordGate({
    runId: a["run-id"],
    gate: a.gate,
    decision: a.decision,
    artifact: a.artifact,
    reply: typeof a.reply === "string" ? a.reply : undefined,
    replyFile: text("reply-file"),
    projectRoot: typeof a["project-root"] === "string" ? a["project-root"] : process.cwd(),
    outputDir: typeof a["output-dir"] === "string" ? a["output-dir"] : null,
  });
  if (!r.ok) { fail(r.error); return 2; }
  log(`record-gate: Gate ${r.line.gate} ${r.line.decision} for ${r.line.artifact} (sha256 ${short(r.line.sha256)}) recorded in ${r.path}`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
