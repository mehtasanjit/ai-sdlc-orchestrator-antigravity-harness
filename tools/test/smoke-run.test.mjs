/**
 * The offline smoke run: plugin/agy/run.mjs end to end against the stub agy
 * in fixtures/fake-agy, which speaks the recorded stream-json shapes and
 * makes one real ($0) bridge call through the dispatch fallback. Proves the
 * launcher, the resume loop, the driver line's check-16 range, the bridge,
 * the code-written manifest and the report agree — before any paid run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE_AGY = join(ROOT, "tools", "test", "fixtures", "fake-agy", "agy");
const built = existsSync(join(ROOT, "plugin", "mcp", "model-dispatch", "dist", "server.js"));

test("run.mjs completes a two-invocation run against the stub agy and writes every record", { skip: built ? false : "bridge not built (npm run build)" }, () => {
  const proj = mkdtempSync(join(tmpdir(), "agy-smoke-"));
  try {
    copyFileSync(join(ROOT, "examples", "quick-demo", "brief.md"), join(proj, "brief.md"));
    const out = join(proj, ".sdlc");
    const r = spawnSync(process.execPath, [
      join(ROOT, "plugin", "agy", "run.mjs"), `--project-root=${proj}`, `--output-dir=${out}`,
      "--policy=antigravity-flash38-plus-opus5", "--gates=auto-approve", "--run-id=smoke", "--allow-unverified-pin", `--agy-bin=${FAKE_AGY}`,
    ], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /resuming fake-conv-/, "the first invocation ended without SUMMARY.md and was resumed");
    for (const f of ["SUMMARY.md", "telemetry.jsonl", "gates.jsonl", "driver-events.jsonl", "driver-cost-modeled.jsonl", "driver-manifest.json", "manifest.json", "policy_snapshot.yaml", "skills/pipeline.md"]) {
      assert.ok(existsSync(join(out, f)), f);
    }
    const driver = JSON.parse(readFileSync(join(out, "driver-manifest.json"), "utf8"));
    assert.equal(driver.agy_invocations, 2);
    assert.equal(driver.completed, true);
    assert.equal(driver.pin.verified, true, "the checks passed live and the stub's init event names the pinned slug");
    assert.deepEqual(driver.pin.observed_models, ["gemini-3.8-flash-high"]);
    assert.equal(driver.pin.unverified_reason, undefined);
    const modeled = readFileSync(join(out, "driver-cost-modeled.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(modeled.length, 2);
    assert.deepEqual(modeled.map((e) => [e.input_tokens, e.input_tokens_cached, e.output_tokens]), [[600, 400, 250], [700, 800, 330]], "check 16 recorded cumulative: the resumed process is differenced against the first");
    assert.deepEqual(modeled.map((e) => e.invocation), [1, 2]);
    assert.equal(driver.driver_usage.resume_check.state, "cumulative");
    assert.equal(driver.driver_usage.cost_usd_low, 0.003241, "the cumulative reading differences the second result against the first");
    assert.equal(driver.driver_usage.cost_usd_high, 0.004658);
    assert.equal(driver.driver_cost_usd_modeled, 0.003241);
    assert.deepEqual(driver.driver_usage.invocations.map((i) => [i.invocation, i.result_events, i.exit_status]), [[1, 1, 0], [2, 1, 0]]);
    assert.deepEqual(driver.driver_usage.invocations_without_usage, []);
    const telemetry = readFileSync(join(out, "telemetry.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].provenance, "none", "written by the real bridge through dispatch.mjs");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.pass, "smoke");
    assert.equal(manifest.harness.runtime.name, "antigravity-cli");
    assert.equal(manifest.harness.runtime.version, "1.2.3");
    assert.equal(manifest.cost.driver_modeled_usd, 0.003241);
    assert.equal(manifest.cost.driver_modeled_usd_low, undefined, "a recorded check 16 leaves one figure, no range");
    assert.equal(manifest.harness.driver_cost_resume_check, undefined, "written only while check 16 is pending");
    assert.doesNotMatch(manifest.cost.lines[0].basis, /range \$/);
    assert.equal(manifest.usage.driver.bound, undefined);
    assert.equal(manifest.usage.driver.low, undefined);
    assert.equal(manifest.cost.dispatched_cash_usd, 0);
    const report = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), out], { encoding: "utf8" });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /Modeled cost\s+\$0\.0032/);
    assert.doesNotMatch(report.stdout, /Range\s+\$/, "a recorded check 16 prints one figure");
    const md = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), out, "--markdown"], { encoding: "utf8" });
    assert.doesNotMatch(md.stdout, /range is \$/);
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test("a --resume launch keeps the earlier launch's driver usage instead of overwriting it", { skip: built ? false : "bridge not built (npm run build)" }, () => {
  const proj = mkdtempSync(join(tmpdir(), "agy-smoke-resume-"));
  try {
    copyFileSync(join(ROOT, "examples", "quick-demo", "brief.md"), join(proj, "brief.md"));
    const out = join(proj, ".sdlc");
    const launch = (extra) => spawnSync(process.execPath, [
      join(ROOT, "plugin", "agy", "run.mjs"), `--project-root=${proj}`, `--output-dir=${out}`,
      "--policy=antigravity-flash38-plus-opus5", "--gates=auto-approve", "--run-id=smoke", `--agy-bin=${FAKE_AGY}`, ...extra,
    ], { encoding: "utf8", timeout: 120_000 });
    const first = launch(["--max-turns=1"]);
    assert.match(first.stdout, /hit --max-turns=1/, first.stderr + first.stdout);
    const before = JSON.parse(readFileSync(join(out, "driver-manifest.json"), "utf8"));
    assert.equal(before.agy_invocations, 1);

    const second = launch([`--resume=${before.conversation_id}`]);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    const after = JSON.parse(readFileSync(join(out, "driver-manifest.json"), "utf8"));
    assert.equal(after.agy_invocations, 2, "the earlier invocation is carried, not overwritten");
    assert.equal(after.started_at, before.started_at);
    assert.equal(after.driver_usage.invocations[0].carried_from_earlier_launch, true);
    const modeled = readFileSync(join(out, "driver-cost-modeled.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(modeled.map((e) => [e.invocation, e.input_tokens]), [[1, 600], [2, 700]]);
    assert.equal(after.driver_usage.cost_usd_low, 0.003241);
    const events = readFileSync(join(out, "driver-events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((e) => e.event === "result").length, 2, "both launches' streams are in driver-events.jsonl");
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test("the stub refuses the argv shapes a real headless run must not carry", () => {
  const run = (args) => spawnSync(process.execPath, [FAKE_AGY, ...args], { encoding: "utf8" });
  const base = ["--print", "x /o/skills/pipeline.md", "--output-format", "stream-json", "--model", "gemini-3.8-flash-high", "--add-dir", "/p"];
  assert.match(run(base).stdout, /soft-denied/);
  assert.match(run([...base, "--dangerously-skip-permissions", "--sandbox"]).stdout, /--sandbox/);
  assert.match(run([...base.slice(0, 5), "gemini-9", ...base.slice(6), "--dangerously-skip-permissions"]).stdout, /unknown model/);
});

test("two runs in one project each get their own folder, and an earlier run's SUMMARY.md does not end a later one", { skip: built ? false : "bridge not built (npm run build)" }, () => {
  const proj = mkdtempSync(join(tmpdir(), "agy-smoke-runs-"));
  try {
    copyFileSync(join(ROOT, "examples", "quick-demo", "brief.md"), join(proj, "brief.md"));
    const launch = (runId, extra = []) => spawnSync(process.execPath, [
      join(ROOT, "plugin", "agy", "run.mjs"), `--project-root=${proj}`,
      "--policy=antigravity-flash38-plus-opus5", "--gates=auto-approve", `--run-id=${runId}`, `--agy-bin=${FAKE_AGY}`, ...extra,
    ], { encoding: "utf8", timeout: 120_000 });

    assert.equal(launch("first").status, 0);
    assert.equal(launch("second").status, 0);
    for (const id of ["first", "second"]) {
      const dir = join(proj, ".sdlc", "runs", id);
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      assert.equal(m.pass, id);
      assert.equal(m.cost.driver_modeled_usd, 0.003241, `run ${id}'s driver line holds its own two turns only`);
      assert.equal(m.harness.other_runs_in_directory, undefined);
    }

    // A reused --output-dir with an earlier run's SUMMARY.md: the new run still resumes until it writes its own.
    const shared = join(proj, ".sdlc", "runs", "first");
    const r = launch("third", [`--output-dir=${shared}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resuming fake-conv-/, "the stale SUMMARY.md did not mark run 'third' complete");
    const third = JSON.parse(readFileSync(join(shared, "manifest.json"), "utf8"));
    assert.equal(third.pass, "third");
    assert.equal(third.cost.driver_modeled_usd, 0.003241, "run 'first''s turns are not in run 'third''s driver line");
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test("a run interrupted mid-invocation keeps the events agy had printed and records the interrupt", { skip: built ? false : "bridge not built (npm run build)" }, async () => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync, chmodSync } = await import("node:fs");
  const proj = mkdtempSync(join(tmpdir(), "agy-smoke-kill-"));
  try {
    copyFileSync(join(ROOT, "examples", "quick-demo", "brief.md"), join(proj, "brief.md"));
    const slowAgy = join(proj, "slow-agy");
    writeFileSync(slowAgy, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("1.2.3"); process.exit(0); }
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ event: "init", conversation_id: "slow-conv", model: "gemini-3.8-flash-high" });
emit({ event: "result", result: { conversation_id: "slow-conv", status: "OK", num_turns: 1, usage: { input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1250 } } });
setInterval(() => {}, 1000);
`);
    chmodSync(slowAgy, 0o755);
    const child = spawn(process.execPath, [
      join(ROOT, "plugin", "agy", "run.mjs"), `--project-root=${proj}`, "--policy=antigravity-flash38-plus-opus5",
      "--gates=auto-approve", "--run-id=killed", `--agy-bin=${slowAgy}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const out = join(proj, ".sdlc", "runs", "killed");
    const events = join(out, "driver-events.jsonl");
    for (let i = 0; i < 100 && !(existsSync(events) && readFileSync(events, "utf8").includes('"result"')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(readFileSync(events, "utf8"), /"event":"init"/, "events are on disk while agy is still running");
    child.kill("SIGTERM");
    const status = await new Promise((r) => child.on("close", r));
    assert.equal(status, 1);
    const driver = JSON.parse(readFileSync(join(out, "driver-manifest.json"), "utf8"));
    assert.equal(driver.interrupted, "SIGTERM");
    assert.equal(driver.completed, false);
    assert.equal(driver.driver_turns, 1, "the turn agy reported before the interrupt is on the driver line");
    assert.ok(existsSync(join(out, "manifest.json")));
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test("a quota stop from agy's own model waits and resumes the same conversation", { skip: built ? false : "bridge not built (npm run build)" }, () => {
  const proj = mkdtempSync(join(tmpdir(), "agy-smoke-quota-"));
  try {
    copyFileSync(join(ROOT, "examples", "quick-demo", "brief.md"), join(proj, "brief.md"));
    const out = join(proj, ".sdlc");
    const run = (extra) => spawnSync(process.execPath, [
      join(ROOT, "plugin", "agy", "run.mjs"),
      `--project-root=${proj}`, `--output-dir=${out}`, "--policy=antigravity-flash38-plus-opus5", "--gates=auto-approve",
      "--run-id=quota", "--allow-unverified-pin", `--agy-bin=${FAKE_AGY}`, ...extra,
    ], { encoding: "utf8", timeout: 120_000, env: { ...process.env, FAKE_AGY_QUOTA_FIRST: "1" } });
    const r = run(["--quota-waits=0"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /hit its quota \(429\) in invocation 1 — resuming .* in 0s \(quota retry 1 of 1\)/);
    const driver = JSON.parse(readFileSync(join(out, "driver-manifest.json"), "utf8"));
    assert.equal(driver.completed, true);
    assert.equal(driver.agy_invocations, 2);
    assert.deepEqual(driver.driver_usage.invocations.map((i) => i.exit_status), [3, 0], "the quota stop is on the record");

    rmSync(out, { recursive: true, force: true });
    const none = run(["--quota-waits="]);
    assert.notEqual(none.status, 0);
    assert.match(none.stdout, /still over its quota after 0 wait\(s\)/, "with no waits configured the run stops and says why");
  } finally { rmSync(proj, { recursive: true, force: true }); }
});
