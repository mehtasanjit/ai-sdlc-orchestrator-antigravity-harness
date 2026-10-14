/**
 * A run's own start, end and outcome (plugin/agy/telemetry/runWindow.mjs):
 * the run.start / run.end lines mmo-log.mjs writes, gates.jsonl and
 * SUMMARY.md, as the manifest and the interactive driver collector read them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHarnessManifest, MANIFEST_SCHEMA } from "../../plugin/agy/manifest.mjs";
import { collectionWindow } from "../../plugin/agy/collect-driver-usage.mjs";
import { inferRunId, parseLogfmt, readRunMarkers, runOutcome, sessionWindow } from "../../plugin/agy/telemetry/runWindow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = "antigravity-flash38-plus-opus5";
const RUN = "20260930-114000-greenfield";

const ev = (over) => JSON.stringify({
  ts: "2026-09-30T12:00:00.000Z", pass: RUN, phase: "codegen", task_type: "dto", task_id: "t", module: "m",
  model: "gemini-3.8-flash", routed_by: "orchestrator", provenance: "vendor",
  routing: { policy_name: POLICY, policy_version: 1, rule_index: 0, rule_reason: "x" },
  input_tokens: 1000, input_tokens_cached: 0, output_tokens: 100, cost_usd: 0.001, latency_ms: 10, success: true, retry_count: 0,
  ...over,
});

/** A project with an interactive run folder at .sdlc/runs/<RUN>: two dispatches, no launcher record. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "run-window-"));
  const dir = join(root, ".sdlc", "runs", RUN);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(dir, "policy_snapshot.yaml"));
  writeFileSync(join(dir, "telemetry.jsonl"), [
    ev({ ts: "2026-09-30T11:49:49.000Z", phase: "requirements_analysis", model: "claude-opus-5", cost_usd: 0.5 }),
    ev({ ts: "2026-09-30T14:03:05.000Z" }),
  ].join("\n") + "\n");
  return { root, dir };
}

const mmoLog = (root, ...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "mmo-log.mjs"), ...args, `--project-root=${root}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

const gatesLine = (gate, decision) => JSON.stringify({ gate, artifact: "x.md", decision, note: "n" });

test("parseLogfmt reads bare and quoted values the way log.mjs writes them", () => {
  assert.deepEqual(parseLogfmt('run_id=r1 started_at=2026-09-30T11:44:47Z note="a \\"b\\"\\nc" x='), { run_id: "r1", started_at: "2026-09-30T11:44:47Z", note: 'a "b"\nc', x: "" });
});

test("run.start and run.end written by mmo-log.mjs give an exact session window that differs from the dispatch window", () => {
  const { root, dir } = project();
  try {
    mmoLog(root, "--event=run.start", `--run-id=${RUN}`, "--started-at=2026-09-30T11:44:47Z", "--mode=greenfield", `--policy=${POLICY}`);
    mmoLog(root, "--event=run.end", `--run-id=${RUN}`, "--outcome=completed");
    const markers = readRunMarkers(dir, RUN);
    assert.equal(markers.start, "2026-09-30T11:44:47.000Z", "the entry command's recorded start, earlier than the line");
    assert.equal(markers.start_declared, true);
    assert.ok(markers.end > "2026-09-30T14:03:05.000Z", "run.end is the line's own clock");
    assert.equal(markers.outcome, "completed");

    const m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: RUN, env: {}, now: () => "N" });
    assert.equal(m.session_window.anchor, "markers");
    assert.equal(m.session_window.exact, true);
    assert.equal(m.session_window.start, "2026-09-30T11:44:47.000Z");
    assert.equal(m.dispatch_window.start, "2026-09-30T11:49:49.000Z", "the dispatch window keeps its own name");
    assert.equal(m.dispatch_window.end, "2026-09-30T14:03:05.000Z");
    assert.notEqual(m.session_window.duration_sec, m.dispatch_window.duration_sec);
    assert.equal(m.started_at, m.session_window.start, "the run's start is the session's, not the first dispatch's completion");
    assert.equal(m.ended_at, m.session_window.end);
    assert.equal(m.duration_sec, m.session_window.duration_sec);
    assert.equal(m.harness.schema, MANIFEST_SCHEMA);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("markers are found under any log prefix, in the rotated file, and only for this run", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-window-log-"));
  try {
    writeFileSync(join(dir, "orchestrator.log.1"), "X> 2026-09-30T10:00:00.000Z INFO  run.start run_id=r1\n");
    writeFileSync(join(dir, "orchestrator.log"), [
      "MMO: 2026-09-30T09:00:00.000Z INFO  run.start run_id=r0",
      "MMO: 2026-09-30T11:00:00.000Z INFO  dispatch.end run_id=r1",
      "MMO: 2026-09-30T12:00:00.000Z INFO  run.end run_id=r1 outcome=aborted",
      "MMO: 2026-09-30T13:00:00.000Z INFO  run.end run_id=r0",
    ].join("\n") + "\n");
    const r1 = readRunMarkers(dir, "r1");
    assert.deepEqual([r1.start, r1.end, r1.outcome], ["2026-09-30T10:00:00.000Z", "2026-09-30T12:00:00.000Z", "aborted"]);
    assert.equal(readRunMarkers(dir, "r0").end, "2026-09-30T13:00:00.000Z");
    const none = readRunMarkers(mkdtempSync(join(tmpdir(), "run-window-empty-")));
    assert.deepEqual([none.start, none.end], [null, null]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sessionWindow says when it is only a lower bound", () => {
  const dispatch = { start: "2026-09-30T11:49:49.000Z", end: "2026-09-30T14:03:05.000Z" };
  assert.deepEqual(sessionWindow({ dispatch }), { ...dispatch, duration_sec: 7996, anchor: "dispatches", exact: false });
  const half = sessionWindow({ markers: { start: "2026-09-30T11:44:47.000Z" }, dispatch });
  assert.deepEqual([half.start, half.end, half.anchor, half.exact], ["2026-09-30T11:44:47.000Z", dispatch.end, "markers+dispatches", false]);
  const headless = sessionWindow({ launcher: { started_at: "2026-09-30T11:00:00.000Z", ended_at: "2026-09-30T12:00:00.000Z" }, markers: { start: "2026-09-30T10:00:00.000Z" }, dispatch });
  assert.deepEqual([headless.anchor, headless.exact, headless.duration_sec], ["launcher", true, 3600]);
  assert.equal(sessionWindow({}).anchor, "none");
});

test("gates.jsonl with Gate 4 accepted and a SUMMARY.md gives completed:true on an interactive run", () => {
  const { root, dir } = project();
  try {
    let m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: RUN, env: {} });
    assert.deepEqual([m.harness.completed, m.harness.status, m.harness.gates, m.harness.gate_mode], [false, "incomplete", null, "prompt"]);

    writeFileSync(join(dir, "SUMMARY.md"), "# Summary\n");
    writeFileSync(join(dir, "gates.jsonl"), [1, 2, 3].map((g) => gatesLine(g, "approved")).join("\n") + "\n");
    m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: RUN, env: {} });
    assert.deepEqual([m.harness.completed, m.harness.status], [false, "awaiting_acceptance"], "the manifest Phase 9 writes before Gate 4");

    writeFileSync(join(dir, "gates.jsonl"), [gatesLine(1, "approved"), gatesLine(4, "reject"), gatesLine(4, "accepted")].join("\n") + "\n");
    m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: RUN, env: {} });
    assert.deepEqual([m.harness.completed, m.harness.status], [true, "completed"], "a Gate 4 reject sends the run back to revise; the last line decides");
    assert.deepEqual(m.harness.gates.map((g) => [g.gate, g.decision]), [[1, "approved"], [4, "reject"], [4, "accepted"]]);

    writeFileSync(join(dir, "gates.jsonl"), [gatesLine(1, "approved"), gatesLine(2, "aborted")].join("\n") + "\n");
    m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: RUN, env: {} });
    assert.deepEqual([m.harness.completed, m.harness.status], [false, "aborted"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a headless run keeps the launcher's completion verdict and gate mode, and lists its gate lines", () => {
  const { root, dir } = project();
  try {
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ run_id: RUN, policy: POLICY, gates: "auto-approve", started_at: "2026-09-30T11:40:00.000Z", ended_at: "2026-09-30T14:10:00.000Z", completed: true }));
    writeFileSync(join(dir, "gates.jsonl"), [1, 2, 3, 4].map((g) => gatesLine(g, "auto-approved")).join("\n") + "\n");
    const m = buildHarnessManifest({ runDir: dir, env: {} });
    assert.deepEqual([m.session_window.anchor, m.started_at, m.duration_sec], ["launcher", "2026-09-30T11:40:00.000Z", 9000]);
    assert.deepEqual([m.harness.completed, m.harness.status, m.harness.gate_mode, m.harness.gates.length], [true, "completed", "auto-approve", 4]);
    writeFileSync(join(dir, "driver-manifest.json"), JSON.stringify({ run_id: RUN, policy: POLICY, gates: "auto-approve", completed: false, interrupted: "SIGINT" }));
    assert.equal(buildHarnessManifest({ runDir: dir, env: {} }).harness.status, "interrupted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a SUMMARY.md older than the run's start does not complete it", () => {
  const { root, dir } = project();
  try {
    writeFileSync(join(dir, "SUMMARY.md"), "# stale\n");
    const out = runOutcome({ runDir: dir, gates: [{ gate: 4, decision: "accepted" }], since: new Date(Date.now() + 60_000).toISOString() });
    assert.deepEqual([out.completed, out.status], [false, "incomplete"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("with no --run-id, a folder holding several runs' lines is refused unless it is named after one of them", () => {
  const { root, dir } = project();
  try {
    assert.equal(inferRunId(dir, [{ pass: RUN }, { pass: null }]), RUN);
    assert.equal(inferRunId(dir, [{ pass: "r0" }, { pass: RUN }]), RUN, "the per-run folder names its run");
    assert.throws(() => inferRunId("/tmp/shared", [{ pass: "r0" }, { pass: "r1" }]), /2 runs \(r0, r1\); pass --run-id/);
    writeFileSync(join(dir, "telemetry.jsonl"), ev({ pass: "r0", cost_usd: 40 }) + "\n" + ev({}) + "\n");
    assert.equal(buildHarnessManifest({ runDir: dir, policyName: POLICY, env: {} }).pass, RUN);
    const shared = mkdtempSync(join(tmpdir(), "run-window-shared-"));
    copyFileSync(join(dir, "telemetry.jsonl"), join(shared, "telemetry.jsonl"));
    assert.throws(() => buildHarnessManifest({ runDir: shared, policyName: POLICY, env: {} }), /pass --run-id/);
    rmSync(shared, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the driver collector's window prefers --since/--until, then the run markers, then the folder and the clock", () => {
  const { root, dir } = project();
  try {
    const bare = collectionWindow({ runDir: dir, runId: RUN, now: () => "NOW" });
    assert.equal(bare.until, "NOW");
    assert.deepEqual(bare.sources, { since_from: "run folder created", until_from: "collection time" });
    mmoLog(root, "--event=run.start", `--run-id=${RUN}`, "--started-at=2026-09-30T11:44:47Z");
    mmoLog(root, "--event=run.end", `--run-id=${RUN}`);
    const marked = collectionWindow({ runDir: dir, runId: RUN, now: () => "NOW" });
    assert.equal(marked.since, "2026-09-30T11:44:47.000Z");
    assert.notEqual(marked.until, "NOW");
    assert.deepEqual(marked.sources, { since_from: "run.start", until_from: "run.end" });
    const explicit = collectionWindow({ runDir: dir, runId: RUN, since: "S", until: "U" });
    assert.deepEqual([explicit.since, explicit.until, explicit.sources.since_from, explicit.sources.until_from], ["S", "U", "--since", "--until"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a driver collected before run.end is flagged, and collecting again after it clears the flag", () => {
  const { root, dir } = project();
  try {
    mmoLog(root, "--event=run.start", `--run-id=${RUN}`, "--started-at=2026-09-30T11:44:47Z", "--mode=greenfield", `--policy=${POLICY}`);
    const collector = (until) => writeFileSync(join(dir, "driver-collector.json"), JSON.stringify({
      run_id: RUN, source: "agy local conversation record", window: { since: "2026-09-30T11:44:47.000Z", until }, conversations: [], calls: 0,
    }));
    collector("2026-09-30T14:20:00.000Z");
    mmoLog(root, "--event=run.end", `--run-id=${RUN}`, "--outcome=completed");
    const { end } = readRunMarkers(dir, RUN);

    const before = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: RUN, env: {} });
    const gap = before.harness.driver_collection_incomplete;
    assert.equal(gap.collected_until, "2026-09-30T14:20:00.000Z");
    assert.equal(gap.run_ended_at, end);
    assert.ok(gap.uncollected_sec > 0);
    const cli = spawnSync(process.execPath, [join(ROOT, "plugin", "agy", "manifest.mjs"), dir, `--policy=${POLICY}`, `--run-id=${RUN}`], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stderr, /collected up to 2026-09-30T14:20:00\.000Z, but the run ended at .*collect-driver-usage\.mjs/);

    collector(end);
    const after = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: RUN, env: {} });
    assert.equal(after.harness.driver_collection_incomplete, undefined, "a collection up to run.end covers the whole run");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the pipeline skill collects the driver again after run.end, before the final manifest", async () => {
  const { readFileSync } = await import("node:fs");
  const skill = readFileSync(join(ROOT, "plugin", "skills", "pipeline", "SKILL.md"), "utf8");
  const block = skill.slice(skill.indexOf("--event=run.end"));
  const collect = block.indexOf("collect-driver-usage.mjs");
  const manifest = block.indexOf("agy/manifest.mjs");
  assert.ok(collect > 0 && collect < manifest, "run.end, then collect-driver-usage.mjs, then manifest.mjs");
});
