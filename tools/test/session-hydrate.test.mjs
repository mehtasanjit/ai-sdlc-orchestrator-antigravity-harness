/**
 * Unit tests for plugin/scripts/session-hydrate.mjs — reads project state
 * for the orchestrator + commands to hand off (ticket §7.14, §10.1).
 *
 * Verifies: null-safe when no .sdlc/ present; reads project.json fields
 * (including default_policy); detects mid-setup resume from setup-status.json;
 * detects an interrupted run from its own .sdlc/runs/<run-id>/state.json;
 * emits the one-line marker via --marker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "plugin", "scripts", "session-hydrate.mjs");

function run(cwd, args = []) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeRepo({ project, setupStatus } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  const sdlc = join(dir, ".sdlc");
  if (project !== undefined) {
    mkdirSync(sdlc, { recursive: true });
    writeFileSync(join(sdlc, "project.json"), JSON.stringify(project));
  }
  if (setupStatus !== undefined) {
    mkdirSync(join(sdlc, "local"), { recursive: true });
    writeFileSync(join(sdlc, "local", "setup-status.json"), JSON.stringify(setupStatus));
  }
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

test("returns a well-formed empty payload when no .sdlc/ exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  try {
    const r = run(dir);
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project, null, "project must be null when no .sdlc/");
    assert.equal(payload.baseline, null);
    assert.deepEqual(payload.recent_runs, []);
    assert.equal(payload.resume, null);
  } finally { cleanup(dir); }
});

test("exposes default_policy from project.json in the payload", async () => {
  const dir = makeRepo({ project: { schema_version: 1, default_policy: "my-custom" } });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project.default_policy, "my-custom", "default_policy must round-trip");
  } finally { cleanup(dir); }
});

test("exposes stacks and test_command when project.json has them", async () => {
  const dir = makeRepo({
    project: { schema_version: 1, stacks: ["nest"], test_command: "npm test" },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.deepEqual(payload.project.stacks, ["nest"]);
    assert.equal(payload.project.test_command, "npm test");
    assert.equal(payload.project.default_policy, null, "unset default_policy → null, not undefined");
  } finally { cleanup(dir); }
});

test("detects a pending setup from setup-status.json and returns a resume hint", async () => {
  const dir = makeRepo({
    setupStatus: {
      schema_version: 1,
      sections_done: ["install"],
      sections_pending: [{ number: 2, name: "environment" }, { number: 3, name: "credentials" }],
      timestamp: "2026-08-13T00:00:00Z",
    },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.ok(payload.resume, "resume hint must be present when sections_pending non-empty");
    assert.equal(payload.resume.pending, true);
    assert.equal(payload.resume.kind, "setup");
  } finally { cleanup(dir); }
});

test("no resume hint when setup-status.json shows all sections done", async () => {
  const dir = makeRepo({
    setupStatus: {
      schema_version: 1,
      sections_done: ["install", "environment"],
      sections_pending: [],
      status: "complete",
      timestamp: "2026-08-13T00:00:00Z",
    },
  });
  try {
    const r = run(dir);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.resume, null, "no pending sections → no resume");
  } finally { cleanup(dir); }
});

test("--marker prints a single-line human summary", async () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    const r = run(dir, ["--marker"]);
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "--marker must produce a single line");
    assert.match(lines[0], /SDLC/, "marker must be recognisable");
  } finally { cleanup(dir); }
});

test("tolerates corrupt project.json — treats it as absent, does not crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-hydrate-test-"));
  try {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), "this is not json {[}");
    const r = run(dir);
    assert.equal(r.code, 0, "must not crash on corrupt project.json");
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.project, null, "corrupt project.json → project null");
  } finally { cleanup(dir); }
});

function writeRunState(dir, runId, state) {
  const runDir = join(dir, ".sdlc", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
}

test("offers to resume a run from the gate state in its own run folder", async () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    writeRunState(dir, "20261014-154942-bugfix-login-500", {
      run_id: "20261014-154942-bugfix-login-500", phase: "requirements", gate: 1, status: "gate_pending", at: "2026-10-14T16:02:00Z",
    });
    const payload = JSON.parse(run(dir).stdout);
    assert.equal(payload.resume?.kind, "run");
    assert.equal(payload.resume.run_id, "20261014-154942-bugfix-login-500");
    assert.equal(payload.resume.phase, "requirements");
    assert.equal(payload.resume.gate, 1);
    assert.equal(payload.resume.state_path, ".sdlc/runs/20261014-154942-bugfix-login-500/state.json");
    assert.match(payload.marker, /resume: run 20261014-154942-bugfix-login-500 at requirements/);
  } finally { cleanup(dir); }
});

test("no run resume once the run's state is terminal, or the run recorded its end", async () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    writeRunState(dir, "r1", { phase: "final_acceptance", gate: 4, status: "complete" });
    assert.equal(JSON.parse(run(dir).stdout).resume, null);
    writeRunState(dir, "r1", { phase: "final_acceptance", gate: 4, status: "gate_pending" });
    writeFileSync(join(dir, ".sdlc", "runs", "r1", "run-end.json"), JSON.stringify({ run_id: "r1", outcome: "aborted" }));
    assert.equal(JSON.parse(run(dir).stdout).resume, null, "an ended run is over whatever its state file says");
  } finally { cleanup(dir); }
});

test("the run that wrote its state last decides; an older interrupted run is not offered over it", async () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    writeRunState(dir, "20261014-090000-docs-a", { phase: "design", gate: 2, status: "gate_pending", at: "2026-10-14T09:10:00Z" });
    writeRunState(dir, "20261014-120000-docs-b", { phase: "requirements", gate: 1, status: "gate_pending", at: "2026-10-14T12:10:00Z" });
    assert.equal(JSON.parse(run(dir).stdout).resume.run_id, "20261014-120000-docs-b");
    writeRunState(dir, "20261014-120000-docs-b", { phase: "final_acceptance", gate: 4, status: "complete", at: "2026-10-14T12:50:00Z" });
    assert.equal(JSON.parse(run(dir).stdout).resume, null);
  } finally { cleanup(dir); }
});

test("reads .sdlc/local/state.json only while no run folder holds a state file", async () => {
  const dir = makeRepo({ project: { schema_version: 1 } });
  try {
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "state.json"), JSON.stringify({ run_id: "old-run", phase: "design", status: "gate_pending" }));
    const legacy = JSON.parse(run(dir).stdout).resume;
    assert.equal(legacy.run_id, "old-run");
    assert.equal(legacy.state_path, ".sdlc/local/state.json");
    writeRunState(dir, "new-run", { phase: "requirements", gate: 1, status: "gate_pending" });
    assert.equal(JSON.parse(run(dir).stdout).resume.run_id, "new-run");
  } finally { cleanup(dir); }
});
