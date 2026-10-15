/**
 * A headless run's write guard: the record says whether the hook judged the
 * run's writes (agy 1.3.5 print mode loads it, agy 1.2.5's did not), lists what
 * the run changed outside its contract, and switches the contract off when the
 * driver loop ends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { changedSince, finishWriteGuard, outsideContract } from "../../plugin/agy/writeGuard.mjs";
import { contractState } from "../../plugin/scripts/lib/contract-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRITE_CONTRACT = join(ROOT, "plugin", "scripts", "write-contract.mjs");
const CONTRACT = { allowlist: ["src/**"], off_limits: ["secrets/**"] };

test("changedSince lists files whose status or content changed, the plugin's own .sdlc/ aside", () => {
  const before = new Map([["src/a.ts", " M|1|10"], ["notes.txt", "??|1|5"], ["src/dirty.ts", " M|1|7"]]);
  const after = new Map([["src/a.ts", " M|1|10"], ["notes.txt", "??|1|5"], ["src/dirty.ts", " M|2|9"], ["README.md", " M|2|3"], ["src/b.ts", "??|2|1"], [".env", "!!|2|4"], [".sdlc/runs/r1/x.json", "??|2|1"]]);
  assert.deepEqual(changedSince(before, after), [".env", "README.md", "src/b.ts", "src/dirty.ts"], "a dirty file written again, and an ignored .env, both show");
});

test("the snapshot sees ignored files a run writes", async () => {
  const { gitStatus } = await import("../../plugin/agy/writeGuard.mjs");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "hwg-git-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), ".env\ndist/\n");
    const before = gitStatus(dir);
    writeFileSync(join(dir, ".env"), "K=1\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "x.js"), "1");
    const changed = changedSince(before, gitStatus(dir));
    assert.ok(changed.includes(".env"));
    assert.ok(changed.includes("dist/"));
    assert.deepEqual(outsideContract(changed.filter((p) => p !== ".gitignore"), { allowlist: ["src/**"], off_limits: ["dist/**"] }), [".env", "dist/"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outsideContract names off-limits and not-allowlisted paths, off-limits in any case", () => {
  assert.deepEqual(outsideContract(["src/a.ts", "README.md", "SECRETS/k", "src/.ENV"], CONTRACT), ["README.md", "SECRETS/k", "src/.ENV"]);
});

test("without a contract for the run, the record says the guard was off and nothing more", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: new Map(), outcome: "completed", status: () => new Map() });
    assert.equal(g.state, "off");
    assert.match(g.reason, /no write contract was frozen for this run/);
    assert.equal(g.after_run_check, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with this run's contract, the record lists what the run changed outside it and the contract stops binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    mkdirSync(join(dir, ".git"));
    const fz = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", "--run-id=r1", `--allowlist=${JSON.stringify(CONTRACT.allowlist)}`, `--off-limits=${JSON.stringify(CONTRACT.off_limits)}`, `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(fz.status, 0, fz.stderr);
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: new Map(), outcome: "stopped", status: () => new Map([["src/a.ts", "??|1|1"], ["package.json", " M|1|1"], ["secrets/k", "??|1|1"]]) });
    assert.deepEqual(g.after_run_check, { files_changed: 3, outside_contract: ["package.json", "secrets/k"], unjudged_changes: ["package.json", "secrets/k", "src/a.ts"] }, "no hook decision named any of them");
    assert.equal(g.contract_closed, "stopped");
    assert.equal(contractState(dir).binding, false, "the run's contract no longer holds the project");
    assert.equal(JSON.parse(readFileSync(join(dir, ".sdlc", "runs", "r1", "run-end.json"), "utf8")).outcome, "stopped");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an interactive run's manifest records the hook; a headless one records the guard as off", async () => {
  const { buildHarnessManifest } = await import("../../plugin/agy/manifest.mjs");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "hwg-m-"));
  try {
    writeFileSync(join(dir, "telemetry.jsonl"), "");
    assert.equal(buildHarnessManifest({ runDir: dir, runId: "i1", policyName: "p", env: {} }).harness.write_guard.state, "hook");
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ run_id: "h1", policy: "p", write_guard: { state: "off", reason: "x" } }));
    assert.equal(buildHarnessManifest({ runDir: dir, runId: "h1", policyName: "p", env: {} }).harness.write_guard.state, "off");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function frozen(dir, runId = "r1") {
  mkdirSync(join(dir, ".git"), { recursive: true });
  const fz = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", `--run-id=${runId}`, `--allowlist=${JSON.stringify(CONTRACT.allowlist)}`, `--off-limits=${JSON.stringify(CONTRACT.off_limits)}`, `--project-root=${dir}`], { encoding: "utf8" });
  assert.equal(fz.status, 0, fz.stderr);
}

test("a run the hook judged records the guard as the hook, with its counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    frozen(dir);
    const log = join(dir, ".sdlc", "local", "guard-decisions.jsonl");
    mkdirSync(dirname(log), { recursive: true });
    for (const d of [{ decision: "allow", run_id: "r1" }, { decision: "deny", run_id: "r1" }, { decision: "deny", run_id: "an-earlier-run" }, { decision: "allow" }]) {
      appendFileSync(log, JSON.stringify(d) + "\n");
    }
    appendFileSync(log, "not json\n");
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: new Map(), outcome: "completed", status: () => new Map() });
    assert.equal(g.state, "hook");
    assert.deepEqual(g.hook_decisions, { judged: 2, refused: 1 }, "only this run's decisions count");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run with a contract and no hook decision records the guard as off", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    frozen(dir);
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: new Map(), outcome: "completed", status: () => new Map() });
    assert.equal(g.state, "off");
    assert.match(g.reason, /recorded no decision for this run/);
    assert.ok(g.after_run_check, "the after-run check still runs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a resume binds the contract the launcher's stop closed, exactly as frozen", async () => {
  const { resumeRun, endRun, LAUNCHER_STOP_REASON } = await import("../../plugin/scripts/write-contract.mjs");
  const { readdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    frozen(dir);
    endRun(dir, "r1", { outcome: "stopped", reason: LAUNCHER_STOP_REASON });
    assert.equal(contractState(dir).binding, false);
    assert.deepEqual(resumeRun(dir, "r1", { now: () => "2026-10-14T12:00:00.000Z" }), { resumed: true });
    const state = contractState(dir);
    assert.equal(state.binding, true);
    assert.equal(state.tampered, null, "the restored contract matches its freeze fingerprint");
    assert.ok(readdirSync(join(dir, ".sdlc", "runs", "r1")).includes("run-end.stopped-2026-10-14T12-00-00-000Z.json"), "the stop's record is kept");
    endRun(dir, "r1", { outcome: "completed", reason: LAUNCHER_STOP_REASON });
    assert.equal(contractState(dir).binding, false, "the resumed run ends as any run does");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a resume never reopens a run the person ended, or a contract edited since its freeze", async () => {
  const { resumeRun, endRun, LAUNCHER_STOP_REASON } = await import("../../plugin/scripts/write-contract.mjs");
  const { writeFileSync } = await import("node:fs");
  const closed = mkdtempSync(join(tmpdir(), "hwg-"));
  const edited = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    frozen(closed);
    endRun(closed, "r1", { outcome: "completed" });
    assert.equal(resumeRun(closed, "r1").resumed, false);
    assert.equal(contractState(closed).binding, false);

    frozen(edited);
    endRun(edited, "r1", { outcome: "stopped", reason: LAUNCHER_STOP_REASON });
    const path = join(edited, ".sdlc", "local", "write-contract.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"src/**"', '"**"'));
    const r = resumeRun(edited, "r1");
    assert.equal(r.resumed, false);
    assert.match(r.reason, /no longer matches its freeze record/);
    assert.equal(contractState(edited).binding, false);

    assert.deepEqual(resumeRun(mkdtempSync(join(tmpdir(), "hwg-")), "r1"), { resumed: false, ended: false }, "a run with no end record is not a resume case");
  } finally { rmSync(closed, { recursive: true, force: true }); rmSync(edited, { recursive: true, force: true }); }
});

test("the first launch's snapshot survives a resume, so the after-run check covers the whole run", async () => {
  const { saveLaunchSnapshot, loadLaunchSnapshot } = await import("../../plugin/agy/writeGuard.mjs");
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    frozen(dir);
    const atLaunch = new Map([["src/a.ts", " M|1|1"]]);
    saveLaunchSnapshot(dir, atLaunch);
    assert.deepEqual(loadLaunchSnapshot(dir), atLaunch);
    assert.equal(loadLaunchSnapshot(join(dir, "nowhere")), null);
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: loadLaunchSnapshot(dir), outcome: "completed", status: () => new Map([["src/a.ts", " M|1|1"], ["node_modules/x/index.js", "??|2|1"]]) });
    assert.deepEqual(g.after_run_check.outside_contract, ["node_modules/x/index.js"], "a file the first launch wrote is still in the final record");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the record lists changed files no hook decision named", async () => {
  const { unjudgedChanges } = await import("../../plugin/agy/writeGuard.mjs");
  assert.deepEqual(unjudgedChanges(["src/a.ts", "src/b.ts", "node_modules/x/i.js"], ["src/a.ts", "node_modules/.package-lock.json"]), ["src/b.ts"]);
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    frozen(dir);
    const log = join(dir, ".sdlc", "local", "guard-decisions.jsonl");
    appendFileSync(log, JSON.stringify({ decision: "allow", run_id: "r1", paths: [join(dir, "src", "a.ts")] }) + "\n");
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: new Map(), outcome: "completed", status: () => new Map([["src/a.ts", "??|1|1"], ["src/b.ts", "??|1|1"]]) });
    assert.deepEqual(g.after_run_check.unjudged_changes, ["src/b.ts"]);
    assert.match(g.reason, /1 changed file\(s\) reached disk without a hook decision/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("node_modules/ is the output of an install the hook allowed, not a write outside the contract", () => {
  const offModules = { allowlist: ["src/**"], off_limits: ["node_modules/**"] };
  assert.deepEqual(outsideContract(["node_modules/", "node_modules/x/i.js", "src/a.ts"], offModules), ["node_modules/", "node_modules/x/i.js"], "with no install, it is outside");
  assert.deepEqual(outsideContract(["node_modules/", "node_modules/x/i.js", "src/a.ts", "package-lock.json"], offModules, { installed: true }), ["package-lock.json"], "a lockfile change is still listed");

  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    mkdirSync(join(dir, ".git"));
    const fz = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", "--run-id=r1", '--allowlist=["src/**"]', '--off-limits=["node_modules/**"]', "--test-command=npm test", `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(fz.status, 0, fz.stderr);
    const hook = spawnSync(process.execPath, [join(ROOT, "plugin", "agy", "hooks", "write-contract-check.mjs")], { input: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "npm install --no-package-lock" } }, workspacePaths: [dir] }), encoding: "utf8", cwd: dir });
    assert.deepEqual(JSON.parse(hook.stdout), { decision: "allow" });
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: new Map(), outcome: "completed", status: () => new Map([["node_modules/", "!!|1|1"]]) });
    assert.deepEqual(g.after_run_check, { files_changed: 1, outside_contract: [], unjudged_changes: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
