/**
 * A brownfield run's test record and what it decides: plugin/scripts/test-run.mjs
 * runs the test command and records its real status and exit code, and the
 * close-out (write-contract.mjs --close), the manifest, the headless launcher
 * and dispatch.mjs's test_run row all read that record, never the conductor's
 * own account of the run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readTestRecord, testVerdict } from "../../plugin/scripts/lib/test-record.mjs";
import { runTests, testStatus } from "../../plugin/scripts/test-run.mjs";
import { buildLogEventArgs, logReceipt, runDispatch } from "../../plugin/agy/dispatch.mjs";
import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";
import { headlessVerdict } from "../../plugin/agy/run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_RUN = join(ROOT, "plugin", "scripts", "test-run.mjs");
const WRITE_CONTRACT = join(ROOT, "plugin", "scripts", "write-contract.mjs");
const MMO_LOG = join(ROOT, "plugin", "scripts", "mmo-log.mjs");
const HOOK = join(ROOT, "plugin", "agy", "hooks", "write-contract-check.mjs");
const POLICY = "antigravity-flash38-plus-opus5";
const RUN = "20261014-154942-bugfix-login-500";
/** The test command Gate 0 confirmed and froze; each test writes the suite it runs. */
const SUITE = "sh suite.sh";
const PASS = "echo '3 passing'";

const BRIEF = (testCommand) => [
  "# Intent Brief — bugfix — login 500",
  "",
  "## Context",
  "POST /login returns 500 on a missing password.",
  "## Files in scope",
  "- src/auth.js",
  "## Test command",
  testCommand,
  "## Acceptance criteria",
  "- 400 on a missing password",
].join("\n") + "\n";

/** A git project with a contract frozen at Gate 0 with its test command, and the run's folder holding its brief. */
function project({ testCommand = SUITE } = {}) {
  const root = mkdtempSync(join(tmpdir(), "test-run-"));
  mkdirSync(join(root, ".git"));
  const runDir = join(root, ".sdlc", "runs", RUN);
  const fz = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", `--run-id=${RUN}`, '--allowlist=["src/**"]', '--off-limits=["node_modules/**",".sdlc/**"]', `--test-command=${testCommand}`, `--project-root=${root}`], { encoding: "utf8" });
  assert.equal(fz.status, 0, fz.stderr);
  writeFileSync(join(runDir, "intent_brief.md"), BRIEF(testCommand));
  return { root, runDir };
}

const testRun = (root, command = SUITE, extra = []) =>
  spawnSync(process.execPath, [TEST_RUN, `--run-id=${RUN}`, `--output-dir=${join(root, ".sdlc", "runs", RUN)}`, `--cwd=${root}`, `--command=${command}`, ...extra], { encoding: "utf8" });
/** Runs the frozen command against a suite that does `script`. */
const runSuite = (root, script) => {
  writeFileSync(join(root, "suite.sh"), script + "\n");
  return testRun(root);
};
const close = (root, ...args) => spawnSync(process.execPath, [WRITE_CONTRACT, "--close", `--run-id=${RUN}`, ...args, `--project-root=${root}`], { encoding: "utf8" });
const mmoLog = (root, ...args) => {
  const r = spawnSync(process.execPath, [MMO_LOG, ...args, `--project-root=${root}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};
const hookWrite = (root, path) =>
  JSON.parse(spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: path } }, workspacePaths: [root] }), encoding: "utf8", cwd: root }).stdout);

test("test-run.mjs records the command's real status, exit code and output, and keeps every attempt", () => {
  const { root, runDir } = project();
  try {
    const failing = runSuite(root, "echo '1 failing'; exit 3");
    assert.equal(failing.status, 1, "it exits 1 when the tests fail");
    assert.match(failing.stdout, /test-run: failed \(exit 3\)/);
    assert.match(failing.stdout, /1 failing/, "the failure's output is shown");
    let record = readTestRecord(runDir);
    assert.deepEqual([record.run_id, record.status, record.exit_code, record.attempt], [RUN, "failed", 3, 1]);
    assert.match(readFileSync(join(runDir, "test-output.txt"), "utf8"), /1 failing/);

    const missing = runSuite(root, "no-such-test-runner-xyz");
    assert.equal(missing.status, 1);
    record = readTestRecord(runDir);
    assert.deepEqual([record.status, record.exit_code], ["not_run", 127], "the shell could not find the command");
    assert.match(record.error, /could not find the command/);

    const passing = runSuite(root, PASS);
    assert.equal(passing.status, 0, passing.stderr);
    record = readTestRecord(runDir);
    assert.deepEqual([record.status, record.exit_code, record.attempt], ["passed", 0, 3]);
    assert.deepEqual(record.earlier_attempts.map((a) => [a.attempt, a.status, a.exit_code, a.output]), [[1, "failed", 3, "test-output.1.txt"], [2, "not_run", 127, "test-output.2.txt"]]);
    assert.match(readFileSync(join(runDir, "test-output.1.txt"), "utf8"), /1 failing/, "an earlier attempt's output is kept");
    assert.equal(record.cwd, root);
    assert.equal(record.written_by, "plugin/scripts/test-run.mjs");

    assert.equal(spawnSync(process.execPath, [TEST_RUN, `--run-id=${RUN}`, `--output-dir=${runDir}`], { encoding: "utf8" }).status, 2, "no --command is a usage error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("testStatus tells a run that could not start from a failing one", () => {
  assert.equal(testStatus({ status: 0 }), "passed");
  assert.equal(testStatus({ status: 1 }), "failed");
  assert.equal(testStatus({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }), "failed", "a suite that hangs past the timeout failed");
  assert.equal(testStatus({ status: null, error: { code: "ENOENT" } }), "not_run");
  assert.equal(testStatus({ status: 126 }), "not_run");
});

test("test-run.mjs refuses, before it runs, a command Gate 0 did not freeze or a folder other than the project root", () => {
  const { root, runDir } = project();
  const elsewhere = mkdtempSync(join(tmpdir(), "test-run-elsewhere-"));
  try {
    writeFileSync(join(root, "suite.sh"), PASS + "\n");
    for (const command of ["true", `${SUITE} || true`, "sh other.sh"]) {
      const r = testRun(root, command);
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /refused, nothing ran: .* is not the test command Gate 0 froze \("sh suite\.sh"\)/, command);
    }
    for (const cwd of [elsewhere, join(root, "src")]) {
      mkdirSync(cwd, { recursive: true });
      const out = testRun(root, SUITE, [`--cwd=${cwd}`]);
      assert.equal(out.status, 2, cwd);
      assert.match(out.stderr, /not the project root/, "a subfolder could hold a package.json of its own");
    }
    assert.equal(existsSync(join(runDir, "test-run.json")), false, "nothing is recorded");
    assert.equal(testRun(root, `  sh   suite.sh `).status, 0, "the frozen command, spaced differently, runs");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test("a passing record of another command, or from another folder, does not let the run complete", () => {
  const { root, runDir } = project();
  const elsewhere = mkdtempSync(join(tmpdir(), "test-run-elsewhere-"));
  try {
    runTests({ runId: RUN, outputDir: runDir, command: "true", cwd: root });
    let verdict = testVerdict(runDir, RUN);
    assert.deepEqual([verdict.status, verdict.passed, verdict.frozen_commands], ["passed", false, [SUITE]]);
    assert.match(verdict.reason, /does not count: "true" is not the test command Gate 0 froze/);
    let r = close(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot end as completed: the last test run does not count/);

    writeFileSync(join(elsewhere, "suite.sh"), PASS + "\n");
    runTests({ runId: RUN, outputDir: runDir, command: SUITE, cwd: elsewhere });
    verdict = testVerdict(runDir, RUN);
    assert.equal(verdict.passed, false);
    assert.match(verdict.reason, /not the project root/);

    assert.equal(runSuite(root, PASS).status, 0);
    assert.equal(testVerdict(runDir, RUN).passed, true);
    r = close(root);
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test("only the freeze record lifts the test requirement: a brief edited to none changes nothing", () => {
  const { root, runDir } = project();
  try {
    runSuite(root, "exit 1");
    assert.equal(hookWrite(root, join(runDir, "intent_brief.md")).decision, "allow", "the run's own folder is writable");
    writeFileSync(join(runDir, "intent_brief.md"), BRIEF("none"));
    assert.deepEqual([testVerdict(runDir, RUN).required, testVerdict(runDir, RUN).passed], [true, false]);
    const r = close(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot end as completed: the last test run \("sh suite\.sh"\) failed, exit code 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const none = project({ testCommand: "none" });
  try {
    assert.deepEqual(testVerdict(none.runDir, RUN), { required: false, passed: null, status: "none", frozen_commands: [], reason: "Gate 0 froze no test command (none)" });
  } finally { rmSync(none.root, { recursive: true, force: true }); }
});

test("a project write the hook allows after the test run started voids the pass", () => {
  const { root, runDir } = project();
  try {
    assert.equal(runSuite(root, PASS).status, 0);
    assert.equal(hookWrite(root, join(runDir, "final_report.md")).decision, "allow");
    assert.equal(testVerdict(runDir, RUN).passed, true, "a write to the run's own folder is no code change");

    assert.equal(hookWrite(root, join(root, "src", "auth.js")).decision, "allow");
    const verdict = testVerdict(runDir, RUN);
    assert.equal(verdict.passed, false);
    assert.match(verdict.reason, /the project changed after the last test run started .*src\/auth\.js.*run the tests again/);
    let r = close(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the project changed after the last test run started/);

    assert.equal(testRun(root).status, 0);
    r = close(root);
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a test record the conductor wrote, or one from another run, is no test record", () => {
  const { root, runDir } = project();
  try {
    writeFileSync(join(runDir, "test-run.json"), JSON.stringify({ run_id: RUN, status: "passed", exit_code: 0 }));
    assert.equal(readTestRecord(runDir), null);
    assert.equal(testVerdict(runDir, RUN).passed, false);
    writeFileSync(join(runDir, "test-run.json"), JSON.stringify({ run_id: "other", status: "passed", exit_code: 0, written_by: "plugin/scripts/test-run.mjs" }));
    assert.match(testVerdict(runDir, RUN).reason, /no test-run\.json for this run/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--close refuses to end a run as completed without a passing test record, and a stop records its reason and needs", () => {
  const { root, runDir } = project();
  try {
    let r = close(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot end as completed: no test-run\.json for this run/);
    assert.match(r.stderr, /--outcome=stopped --reason="<what failed>" --needs="<what the person must do>"/);
    assert.equal(existsSync(join(runDir, "run-end.json")), false, "nothing is written");

    runSuite(root, "exit 1");
    r = close(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the last test run \("sh suite\.sh"\) failed, exit code 1/);

    assert.match(close(root, "--outcome=stopped", "--reason=tests fail").stderr, /records why it stopped and what it needs/, "a stop without needs is refused");
    r = close(root, "--outcome=stopped", "--reason=src/auth.spec.js fails with exit code 1", "--needs=decide whether the expected status is still right");
    assert.equal(r.status, 0, r.stderr);
    const end = JSON.parse(readFileSync(join(runDir, "run-end.json"), "utf8"));
    assert.deepEqual([end.outcome, end.reason, end.needs], ["stopped", "src/auth.spec.js fails with exit code 1", "decide whether the expected status is still right"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--close ends a run as completed on a passing record, or when Gate 0 froze no test command", () => {
  for (const [label, testCommand] of [["passing", SUITE], ["none", "none"]]) {
    const { root, runDir } = project({ testCommand });
    try {
      if (testCommand !== "none") assert.equal(runSuite(root, PASS).status, 0);
      const r = close(root);
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.equal(JSON.parse(readFileSync(join(runDir, "run-end.json"), "utf8")).outcome, "completed", label);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

/** The bf-chat shape: Gate 4 accepted, SUMMARY.md written, run.end completed — and a failing suite. */
function acceptedRun(root, runDir) {
  copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(runDir, "policy_snapshot.yaml"));
  writeFileSync(join(runDir, "telemetry.jsonl"), "");
  writeFileSync(join(runDir, "gates.jsonl"), [0, 1, 3].map((g) => JSON.stringify({ gate: g, decision: "approved" })).concat(JSON.stringify({ gate: 4, decision: "accepted" })).join("\n") + "\n");
  mmoLog(root, "--event=run.start", `--run-id=${RUN}`, "--mode=brownfield", "--intent=bugfix");
  writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
}
const manifest = (runDir) => buildHarnessManifest({ runDir, policyName: POLICY, runId: RUN, env: {} });

test("the manifest marks a brownfield run incomplete when its tests did not pass, whatever Gate 4 said", () => {
  const { root, runDir } = project();
  try {
    acceptedRun(root, runDir);
    let m = manifest(runDir);
    assert.deepEqual([m.harness.completed, m.harness.status], [false, "incomplete"], "no test run at all");
    assert.equal(m.harness.tests.status, "not_run");
    assert.match(m.harness.incomplete_reason, /tests did not pass/);

    runSuite(root, "exit 1");
    mmoLog(root, "--event=run.end", `--run-id=${RUN}`, "--outcome=completed");
    m = manifest(runDir);
    assert.deepEqual([m.harness.completed, m.harness.status, m.harness.tests.status, m.harness.tests.exit_code], [false, "incomplete", "failed", 1]);

    runSuite(root, PASS);
    m = manifest(runDir);
    assert.deepEqual([m.harness.completed, m.harness.status, m.harness.tests.passed], [true, "completed", true]);
    assert.equal(m.harness.incomplete_reason, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a run Phase 7 stopped is recorded as stopped, with its reason and needs", () => {
  const { root, runDir } = project();
  try {
    acceptedRun(root, runDir);
    runSuite(root, "no-such-test-runner-xyz");
    mmoLog(root, "--event=run.end", `--run-id=${RUN}`, "--outcome=stopped", "--reason=the test runner is not installed", "--needs=run npm ci in the repo root");
    const m = manifest(runDir);
    assert.deepEqual([m.harness.completed, m.harness.status], [false, "stopped"]);
    assert.deepEqual(m.harness.stop, { reason: "the test runner is not installed", needs: "run npm ci in the repo root" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a brownfield run whose Gate 0 froze no test command completes without a test record; a greenfield run is not asked for one", () => {
  const { root, runDir } = project({ testCommand: "none" });
  try {
    acceptedRun(root, runDir);
    const m = manifest(runDir);
    assert.deepEqual([m.harness.completed, m.harness.status, m.harness.tests.required], [true, "completed", false]);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const green = mkdtempSync(join(tmpdir(), "test-run-green-"));
  try {
    assert.deepEqual(headlessVerdict({ outputDir: green, runId: RUN, mode: "greenfield", summaryWritten: true }), { completed: true, tests: null });
  } finally { rmSync(green, { recursive: true, force: true }); }
});

test("the headless launcher completes a brownfield run only on a passing test record", () => {
  const { root, runDir } = project();
  try {
    const verdict = () => headlessVerdict({ outputDir: runDir, runId: RUN, mode: "brownfield", summaryWritten: true });
    assert.equal(verdict().completed, false);
    assert.match(verdict().tests.reason, /never ran through plugin\/scripts\/test-run\.mjs/);
    runSuite(root, PASS);
    assert.equal(verdict().completed, true);
    assert.equal(headlessVerdict({ outputDir: runDir, runId: RUN, mode: "brownfield", summaryWritten: false }).completed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a test_run row and its receipt carry the recorded status and exit code, never a bare ok", async () => {
  const { root, runDir } = project();
  try {
    const telemetry = join(runDir, "telemetry.jsonl");
    const logged = [];
    const connect = async () => ({ callTool: async (name, args) => { logged.push(args); return "ok"; }, close: async () => {} });
    const args = { "log-phase": "test_run", "task-type": "in_session", telemetry, out: join(runDir, "test-run-log.json"), "run-id": RUN };
    await assert.rejects(() => runDispatch(args, { connect }), /a test_run row records the test run plugin\/scripts\/test-run\.mjs wrote/);
    assert.equal(logged.length, 0, "nothing is logged without a record");

    runSuite(root, "exit 1");
    await runDispatch({ ...args, reason: "npm test passed (3/3 tests)" }, { connect });
    const event = logged[0].event;
    assert.deepEqual([event.success, event.test_status, event.test_exit_code], [false, "failed", 1]);
    assert.match(event.routing.rule_reason, /failed, exit code 1 \(attempt 1, recorded by plugin\/scripts\/test-run\.mjs\)/, "the record's account, not the conductor's");
    const receipt = JSON.parse(readFileSync(join(runDir, "test-run-log.json"), "utf8"));
    assert.deepEqual(receipt, { logged: "test_run", task_type: "in_session", success: false, test_status: "failed", test_exit_code: 1, telemetry_path: telemetry, reply: "ok" });

    assert.equal(buildLogEventArgs({ phase: "test_run", taskType: "skipped", telemetryPath: telemetry }).event.success, true, "a skipped test phase needs no record");
    assert.deepEqual(logReceipt(buildLogEventArgs({ phase: "discovery", taskType: "in_session", telemetryPath: telemetry }), "ok"), { logged: "discovery", task_type: "in_session", success: true, telemetry_path: telemetry, reply: "ok" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a greenfield test_run row needs no test record; a brownfield one does", () => {
  const green = mkdtempSync(join(tmpdir(), "test-run-green-"));
  try {
    const telemetryPath = join(green, "telemetry.jsonl");
    const row = buildLogEventArgs({ phase: "test_run", taskType: "in_session", telemetryPath, runId: "g1" }).event;
    assert.equal(row.success, true, "greenfield Phase 7 runs its tests by hand, as before");
    assert.equal("test_status" in row, false);
    writeFileSync(join(green, "intent_brief.md"), BRIEF(SUITE));
    assert.throws(() => buildLogEventArgs({ phase: "test_run", taskType: "in_session", telemetryPath, runId: "g1" }), /holds none for this run/, "a brownfield run folder is read as one");
  } finally { rmSync(green, { recursive: true, force: true }); }
});

test("a headless run whose session wrote SUMMARY.md but whose tests failed says why it is incomplete", () => {
  const { root, runDir } = project();
  try {
    copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(runDir, "policy_snapshot.yaml"));
    writeFileSync(join(runDir, "telemetry.jsonl"), "");
    writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
    runSuite(root, "exit 1");
    writeFileSync(join(runDir, "driver-manifest.json"), JSON.stringify({ harness: "antigravity", run_id: RUN, mode: "brownfield", completed: false, started_at: new Date(Date.now() - 60_000).toISOString(), ended_at: new Date().toISOString() }));
    const m = manifest(runDir);
    assert.deepEqual([m.harness.completed, m.harness.status, m.harness.tests.status], [false, "incomplete", "failed"]);
    assert.match(m.harness.incomplete_reason, /tests did not pass: the last test run \("sh suite\.sh"\) failed, exit code 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
