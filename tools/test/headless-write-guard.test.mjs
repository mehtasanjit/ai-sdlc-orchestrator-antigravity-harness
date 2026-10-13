/**
 * A headless run has no write guard: agy's print mode loads no hooks. The
 * run record says so, lists what the run changed outside its contract, and
 * switches the run's contract off when the driver loop ends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { changedSince, finishWriteGuard, outsideContract } from "../../plugin/agy/writeGuard.mjs";
import { contractState } from "../../plugin/scripts/lib/contract-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRITE_CONTRACT = join(ROOT, "plugin", "scripts", "write-contract.mjs");
const CONTRACT = { allowlist: ["src/**"], off_limits: ["secrets/**"] };

test("changedSince lists files whose status changed, the plugin's own .sdlc/ aside", () => {
  const before = [" M src/a.ts", "?? notes.txt"];
  const after = [" M src/a.ts", "?? notes.txt", " M README.md", "?? src/b.ts", "?? .sdlc/runs/r1/x.json"];
  assert.deepEqual(changedSince(before, after), ["README.md", "src/b.ts"]);
});

test("outsideContract names off-limits and not-allowlisted paths, off-limits in any case", () => {
  assert.deepEqual(outsideContract(["src/a.ts", "README.md", "SECRETS/k", "src/.ENV"], CONTRACT), ["README.md", "SECRETS/k", "src/.ENV"]);
});

test("without a contract for the run, the record says the guard was off and nothing more", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: [], outcome: "completed", status: () => [] });
    assert.equal(g.state, "off");
    assert.match(g.reason, /print mode loads no hooks/);
    assert.equal(g.after_run_check, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with this run's contract, the record lists what the run changed outside it and the contract stops binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "hwg-"));
  try {
    mkdirSync(join(dir, ".git"));
    const fz = spawnSync(process.execPath, [WRITE_CONTRACT, "--freeze", "--run-id=r1", `--allowlist=${JSON.stringify(CONTRACT.allowlist)}`, `--off-limits=${JSON.stringify(CONTRACT.off_limits)}`, `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(fz.status, 0, fz.stderr);
    const g = finishWriteGuard({ projectRoot: dir, runId: "r1", statusBefore: [], outcome: "stopped", status: () => ["?? src/a.ts", " M package.json", "?? secrets/k"] });
    assert.deepEqual(g.after_run_check, { files_changed: 3, outside_contract: ["package.json", "secrets/k"] });
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
