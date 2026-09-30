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
    assert.equal(driver.pin.verified, true, "the headless checks passed live on 2026-09-17");
    const modeled = readFileSync(join(out, "driver-cost-modeled.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(modeled.length, 2);
    assert.deepEqual(modeled.map((e) => [e.input_tokens, e.input_tokens_cached, e.output_tokens]), [[600, 400, 250], [1300, 1200, 580]], "check 16 pending: the resumed process is priced as fresh counters, the upper bound");
    assert.deepEqual(modeled.map((e) => e.invocation), [1, 2]);
    assert.equal(driver.driver_usage.resume_check.state, "pending");
    assert.equal(driver.driver_usage.cost_usd_low, 0.003241, "the cumulative reading differences the second result against the first");
    assert.equal(driver.driver_usage.cost_usd_high, 0.004658);
    assert.equal(driver.driver_cost_usd_modeled, 0.004658);
    assert.deepEqual(driver.driver_usage.invocations.map((i) => [i.invocation, i.result_events, i.exit_status]), [[1, 1, 0], [2, 1, 0]]);
    assert.deepEqual(driver.driver_usage.invocations_without_usage, []);
    const telemetry = readFileSync(join(out, "telemetry.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].provenance, "none", "written by the real bridge through dispatch.mjs");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.pass, "smoke");
    assert.equal(manifest.harness.runtime.name, "antigravity-cli");
    assert.equal(manifest.harness.runtime.version, "1.2.3");
    assert.equal(manifest.cost.driver_modeled_usd, 0.004658);
    assert.equal(manifest.cost.driver_modeled_usd_low, 0.003241);
    assert.equal(manifest.harness.driver_cost_resume_check.check, 16);
    assert.match(manifest.cost.lines[0].basis, /check 16 pending; lower bound \$0\.003241/);
    assert.equal(manifest.cost.dispatched_cash_usd, 0);
    const report = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), out], { encoding: "utf8" });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /Modeled cost\s+\$0\.0047/);
    assert.match(report.stdout, /Range\s+\$0\.0032 – \$0\.0047/);
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
    assert.deepEqual(modeled.map((e) => [e.invocation, e.input_tokens]), [[1, 600], [2, 1300]]);
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
