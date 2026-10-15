/**
 * A run's test record, read the same way by everything that decides whether
 * the run completed: plugin/scripts/write-contract.mjs --close, the manifest
 * (plugin/agy/manifest.mjs), the headless launcher and dispatch.mjs.
 *
 *   <run folder>/test-run.json     what plugin/scripts/test-run.mjs saw the test command do
 *   <run folder>/test-output.txt   the command's output
 *   <run folder>/intent_brief.md   `## Test command`: the command Gate 0 confirmed, or `none`
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const TEST_RECORD_FILE = "test-run.json";
export const TEST_OUTPUT_FILE = "test-output.txt";
export const TEST_RECORD_WRITER = "plugin/scripts/test-run.mjs";
export const testRecordRelPath = (runId) => `.sdlc/runs/${runId}/${TEST_RECORD_FILE}`;

const MAX_BYTES = 1024 * 1024;

function readText(path) {
  try {
    const st = statSync(path);
    return st.isFile() && st.size <= MAX_BYTES ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** The run folder's test record, or null when there is none or it is not one test-run.mjs wrote. */
export function readTestRecord(runDir) {
  const text = readText(join(runDir, TEST_RECORD_FILE));
  if (text === null) return null;
  try {
    const record = JSON.parse(text);
    return record && typeof record === "object" && record.written_by === TEST_RECORD_WRITER ? record : null;
  } catch {
    return null;
  }
}

/**
 * The `## Test command` section of the run's intent brief: `{ declared: false }`
 * when the brief has none, `{ declared: true, command: null }` when it says
 * `none`, otherwise the command.
 */
export function briefTestCommand(runDir) {
  const text = readText(join(runDir, "intent_brief.md"));
  const heading = text === null ? null : /^##[ \t]+Test command[ \t]*$/im.exec(text);
  if (!heading) return { declared: false };
  const rest = text.slice(heading.index + heading[0].length);
  const end = rest.search(/^#{1,2}[ \t]/m);
  const first = (end === -1 ? rest : rest.slice(0, end)).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const value = first.replace(/^[-*][ \t]+/, "").replace(/^`+|`+$/g, "").trim();
  if (!value) return { declared: false };
  return /^none\b/i.test(value) ? { declared: true, command: null } : { declared: true, command: value };
}

/**
 * Whether the run's tests allow it to complete. `required` is false only when
 * the brief says the run has no test command; then `passed` is null.
 */
export function testVerdict(runDir, runId = null) {
  const brief = briefTestCommand(runDir);
  if (brief.declared && brief.command === null) {
    return { required: false, passed: null, status: "none", reason: "the intent brief's test command is none" };
  }
  const base = { required: true, record: TEST_RECORD_FILE, brief_command: brief.command ?? null };
  const record = readTestRecord(runDir);
  if (!record || (runId && record.run_id !== runId)) {
    return { ...base, passed: false, status: "not_run", exit_code: null, command: null, reason: `no ${TEST_RECORD_FILE} for this run: the test command never ran through ${TEST_RECORD_WRITER}` };
  }
  const passed = record.status === "passed" && record.exit_code === 0;
  return {
    ...base,
    passed,
    status: record.status ?? null,
    exit_code: record.exit_code ?? null,
    command: record.command ?? null,
    attempt: record.attempt ?? 1,
    ended_at: record.ended_at ?? null,
    ...(passed ? {} : { reason: `the last test run (${JSON.stringify(record.command ?? "?")}) ${record.status === "not_run" ? "could not run" : "failed"}, exit code ${record.exit_code ?? "none"}${record.error ? `: ${record.error}` : ""}` }),
  };
}
