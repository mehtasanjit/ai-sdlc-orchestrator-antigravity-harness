/**
 * The offline smoke run: plugin/agy/run.mjs end to end against the stub agy
 * in fixtures/fake-agy, which speaks the recorded stream-json shapes and
 * makes one real ($0) bridge call through the dispatch fallback. Proves the
 * launcher, the resume loop, cumulative-usage differencing, the bridge, the
 * code-written manifest and the report agree — before any paid run.
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
    assert.deepEqual(modeled.map((e) => [e.input_tokens, e.input_tokens_cached, e.output_tokens]), [[600, 400, 250], [700, 800, 330]], "the second result's cumulative counters are differenced against the first");
    const telemetry = readFileSync(join(out, "telemetry.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].provenance, "none", "written by the real bridge through dispatch.mjs");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.pass, "smoke");
    assert.equal(manifest.harness.runtime.name, "antigravity-cli");
    assert.equal(manifest.harness.runtime.version, "1.2.3");
    assert.equal(manifest.cost.driver_modeled_usd, 0.003241);
    assert.equal(manifest.cost.dispatched_cash_usd, 0);
    const report = spawnSync(process.execPath, [join(ROOT, "tools", "report.mjs"), out], { encoding: "utf8" });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /Modeled cost\s+\$0\.0032/);
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test("the stub refuses the argv shapes a real headless run must not carry", () => {
  const run = (args) => spawnSync(process.execPath, [FAKE_AGY, ...args], { encoding: "utf8" });
  const base = ["--print", "x /o/skills/pipeline.md", "--output-format", "stream-json", "--model", "gemini-3.8-flash-high", "--add-dir", "/p"];
  assert.match(run(base).stdout, /soft-denied/);
  assert.match(run([...base, "--dangerously-skip-permissions", "--sandbox"]).stdout, /--sandbox/);
  assert.match(run([...base.slice(0, 5), "gemini-9", ...base.slice(6), "--dangerously-skip-permissions"]).stdout, /unknown model/);
});
