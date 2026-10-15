#!/usr/bin/env node
/**
 * Runs a run's test command and records, by code, what it did: the output in
 * <output-dir>/test-output.txt, the status and exit code in
 * <output-dir>/test-run.json. A brownfield run completes only on a passing
 * record (lib/test-record.mjs), so the conductor's own account of a test run
 * never stands in for one.
 *
 * Usage:
 *   node test-run.mjs --run-id=<id> --output-dir=<run folder> --command="<test command>"
 *                     [--cwd=<dir>] [--timeout-sec=<n>]
 *
 * Each call is one attempt; the last decides. An earlier attempt's output is
 * kept as test-output.<n>.txt. A command the run's freeze record does not
 * hold, or a folder other than the project root, is refused before it runs. Exit 0 =
 * passed, 1 = failed or could not run, 2 = usage or refused.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

import { RUN_ID } from "./lib/contract-state.mjs";
import { isMain } from "./lib/is-main.mjs";
import { frozenTestCommands, projectRootOf, readTestRecord, testRunMismatch, TEST_OUTPUT_FILE, TEST_RECORD_FILE, TEST_RECORD_WRITER } from "./lib/test-record.mjs";

export const DEFAULT_TIMEOUT_SEC = 30 * 60;
const TAIL_LINES = 40;

export function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return out;
}

/** passed, failed, or not_run when the shell could not start the command (126, 127) or nothing ran. */
export function testStatus({ status, signal, error }) {
  if (error && error.code !== "ETIMEDOUT") return "not_run";
  if (status === 0 && !signal) return "passed";
  if (status === 126 || status === 127) return "not_run";
  return "failed";
}

function moveAside(path) {
  if (!existsSync(path)) return null;
  const stem = path.replace(/\.txt$/, "");
  let n = 1;
  while (existsSync(`${stem}.${n}.txt`)) n += 1;
  renameSync(path, `${stem}.${n}.txt`);
  return `${stem}.${n}.txt`;
}

function writeWhole(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function tail(path, lines = TAIL_LINES) {
  try {
    if (statSync(path).size > 8 * 1024 * 1024) return "";
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Runs the command once and writes the record. Returns the record. */
export function runTests({ runId, outputDir, command, cwd = process.cwd(), timeoutSec = DEFAULT_TIMEOUT_SEC, spawn = spawnSync, now = () => new Date() }) {
  const outDir = resolve(outputDir);
  mkdirSync(outDir, { recursive: true });
  const previous = readTestRecord(outDir);
  const outputPath = join(outDir, TEST_OUTPUT_FILE);
  const keptAs = moveAside(outputPath);

  const started = now();
  const fd = openSync(outputPath, "w");
  let r;
  try {
    r = spawn(command, { shell: true, cwd: resolve(cwd), stdio: ["ignore", fd, fd], timeout: timeoutSec * 1000 });
  } finally {
    closeSync(fd);
  }
  const ended = now();
  const status = testStatus({ status: r.status, signal: r.signal, error: r.error });
  const error = r.error?.code === "ETIMEDOUT" ? `timed out after ${timeoutSec}s`
    : r.error ? String(r.error.message ?? r.error)
    : r.status === 127 ? "the shell could not find the command (exit 127)"
    : r.status === 126 ? "the shell could not execute the command (exit 126)"
    : null;

  const earlier = previous?.run_id === runId
    ? [...(previous.earlier_attempts ?? []), { attempt: previous.attempt ?? 1, command: previous.command, status: previous.status, exit_code: previous.exit_code, ended_at: previous.ended_at, output: keptAs ? basename(keptAs) : null }]
    : [];
  const record = {
    schema_version: 1,
    run_id: runId,
    command,
    cwd: resolve(cwd),
    status,
    exit_code: typeof r.status === "number" ? r.status : null,
    signal: r.signal ?? null,
    error,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: ended.getTime() - started.getTime(),
    output: TEST_OUTPUT_FILE,
    attempt: earlier.length + 1,
    earlier_attempts: earlier,
    written_by: TEST_RECORD_WRITER,
  };
  writeWhole(join(outDir, TEST_RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
  return record;
}

export function main(argv = process.argv.slice(2), { log = (m) => process.stdout.write(`${m}\n`), fail = (m) => process.stderr.write(`test-run: ${m}\n`) } = {}) {
  const a = parseArgs(argv);
  if (typeof a["run-id"] !== "string" || !RUN_ID.test(a["run-id"])) { fail("--run-id=<id> is required: the run's id"); return 2; }
  if (typeof a["output-dir"] !== "string" || !a["output-dir"]) { fail("--output-dir=<run folder> is required: where test-run.json is written"); return 2; }
  if (typeof a.command !== "string" || !a.command.trim()) { fail('--command="<test command>" is required: the test command Gate 0 confirmed'); return 2; }
  const timeoutSec = a["timeout-sec"] === undefined ? DEFAULT_TIMEOUT_SEC : Number(a["timeout-sec"]);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) { fail("--timeout-sec must be a positive number of seconds"); return 2; }
  const cwd = typeof a.cwd === "string" && a.cwd ? a.cwd : process.cwd();
  if (!existsSync(cwd)) { fail(`--cwd ${cwd} does not exist`); return 2; }
  const root = projectRootOf(a["output-dir"], a["run-id"]);
  const mismatch = testRunMismatch({ command: a.command, cwd: resolve(cwd) }, { frozen: frozenTestCommands(root, a["run-id"]), root });
  if (mismatch) { fail(`refused, nothing ran: ${mismatch}. Run the frozen command from the project root; a different one is the person's decision, for a new run with its own Gate 0.`); return 2; }

  const record = runTests({ runId: a["run-id"], outputDir: a["output-dir"], command: a.command, cwd, timeoutSec });
  const outputPath = join(resolve(a["output-dir"]), TEST_OUTPUT_FILE);
  log(`test-run: ${record.status} (exit ${record.exit_code ?? "none"}${record.error ? `, ${record.error}` : ""}) — ${record.command}; attempt ${record.attempt}; output in ${outputPath}; record in ${join(resolve(a["output-dir"]), TEST_RECORD_FILE)}`);
  if (record.status !== "passed") {
    const last = tail(outputPath);
    if (last) log(`--- last ${TAIL_LINES} lines of ${TEST_OUTPUT_FILE} ---\n${last}`);
  }
  return record.status === "passed" ? 0 : 1;
}

if (isMain(import.meta.url)) process.exitCode = main();
