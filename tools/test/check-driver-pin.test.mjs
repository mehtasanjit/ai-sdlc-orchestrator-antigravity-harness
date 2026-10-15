/**
 * The run-start pin check of a chat run (plugin/agy/check-driver-pin.mjs):
 * the chat's own model calls, read from a synthetic agy home, against the
 * policy's driver pin. Every home is a temp dir; the CLI runs with
 * MMO_AGY_HOME pointing at it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkDriverPin } from "../../plugin/agy/check-driver-pin.mjs";
import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";
import { agyHomeWith, T } from "./lib/agy-record.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "plugin", "agy", "check-driver-pin.mjs");
const POLICY = "antigravity-flash38-plus-opus5";
const SINCE = "2026-10-14T15:47:59Z";
const TODAY = "2026-10-14T16:00:00Z";

/** One chat in a fresh project: `models` is the model each call ran on, in order. */
function chat(models, { lastModified = "2026-10-14T16:00:00Z", firstStep = "2026-10-14T15:47:58Z" } = {}) {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const home = agyHomeWith(project, [{
    id: "chat-1", lastModified,
    steps: models.map((_, i) => T(firstStep) + i * 5),
    gens: models.map((model, i) => ({ model, fresh: 1000, thinking: 10, text: 10, step: i })),
  }]);
  return { project, home, cleanup: () => { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

const cli = (args, home) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, MMO_AGY_HOME: home } });

test("a chat whose every call is the pinned model passes, and says effort is not checked", async () => {
  const c = chat(["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash"]);
  try {
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.models, { "gemini-3.8-flash": 3 });
    assert.equal(r.effort_checked, false);
    assert.match(r.message, /Effort is not checked/);
    const run = cli([`--since=${SINCE}`, `--project-root=${c.project}`], c.home);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /check-driver-pin ok: gemini-3\.8-flash \(3 call\(s\)\)/);
  } finally { c.cleanup(); }
});

test("a chat started on agy's default model is refused, naming the model, the pin and the restart command", async () => {
  const c = chat(["gemini-4-argon", "gemini-4-argon"]);
  try {
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY, runId: "r1" });
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "off_pin");
    assert.deepEqual(r.off_pin, ["gemini-4-argon"]);
    assert.match(r.message, /ran on gemini-4-argon \(2 call\(s\)\)/);
    assert.match(r.message, /pins the driver to gemini-3\.8-flash at effort high/);
    assert.match(r.message, /^ {2}agy --model gemini-3\.8-flash-high$/m);
    assert.ok(!existsSync(join(c.project, ".sdlc", "runs", "r1", "policy_snapshot.yaml")), "a refused run gets no snapshot");
    const run = cli([`--since=${SINCE}`, `--project-root=${c.project}`], c.home);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /REFUSED[\s\S]*agy --model gemini-3\.8-flash-high/);
  } finally { c.cleanup(); }
});

test("one off-pin call among pinned ones refuses the chat, and only the off-pin model is named", async () => {
  const c = chat(["gemini-3.8-flash", "gemini-3.1-pro", "gemini-3.8-flash"]);
  try {
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY });
    assert.equal(r.status, "refused");
    assert.deepEqual(r.off_pin, ["gemini-3.1-pro"]);
    assert.match(r.message, /ran on gemini-3\.1-pro \(1 call\(s\)\), but/);
  } finally { c.cleanup(); }
});

test("the call that recorded run_started_at counts, though it is dated before it", async () => {
  const c = chat(["gemini-4-argon"], { firstStep: "2026-10-14T15:47:50Z" });
  try {
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY });
    assert.equal(r.status, "refused");
  } finally { c.cleanup(); }
});

test("with no conversation recorded yet the check says NOT CHECKED, exits 3, and never claims a pass", async () => {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "other-"));
  const home = agyHomeWith(project, [
    { id: "old", lastModified: "2026-10-01T00:00:00Z", steps: [T("2026-10-01T00:00:00Z")], gens: [{ model: "gemini-4-argon", fresh: 1, thinking: 1, text: 1, step: 0 }] },
    { id: "theirs", workspace: elsewhere, lastModified: "2026-10-14T16:00:00Z", steps: [T("2026-10-14T15:50:00Z")], gens: [{ model: "gemini-4-argon", fresh: 1, thinking: 1, text: 1, step: 0 }] },
  ]);
  try {
    const r = await checkDriverPin({ projectRoot: project, since: SINCE, home, today: TODAY, runId: "r1" });
    assert.equal(r.status, "unchecked", "another project's chat and an earlier chat are not this one");
    assert.equal(r.reason, "no_conversation");
    assert.match(r.message, /NOT CHECKED[\s\S]*not a pass/);
    assert.ok(existsSync(join(project, ".sdlc", "runs", "r1", "policy_snapshot.yaml")), "the run goes on, so it gets its snapshot");
    const run = cli([`--since=${SINCE}`, `--project-root=${project}`], home);
    assert.equal(run.status, 3);
    assert.doesNotMatch(run.stdout + run.stderr, / ok:/);
  } finally { for (const d of [home, project, elsewhere]) rmSync(d, { recursive: true, force: true }); }
});

test("a conversation with no model call yet is not checked either", async () => {
  const c = chat([]);
  try {
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY });
    assert.equal(r.status, "unchecked");
    assert.equal(r.reason, "no_model_call");
  } finally { c.cleanup(); }
});

test("an unreadable record of another conversation does not hide this chat's off-pin calls", async () => {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const home = agyHomeWith(project, [
    { id: "a-broken", lastModified: "2026-10-14T16:00:00Z", steps: [T("2026-10-14T15:48:00Z")], gens: [{ model: "gemini-3.8-flash", fresh: 1, thinking: 1, text: 1, output: 5, step: 0 }] },
    { id: "b-this-chat", lastModified: "2026-10-14T16:00:00Z", steps: [T("2026-10-14T15:48:00Z")], gens: [{ model: "gemini-4-argon", fresh: 1, thinking: 1, text: 1, step: 0 }] },
  ]);
  try {
    const r = await checkDriverPin({ projectRoot: project, since: SINCE, home, today: TODAY });
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "off_pin");
    assert.deepEqual(r.off_pin, ["gemini-4-argon"]);
    assert.deepEqual(r.unreadable.map((u) => u.id), ["a-broken"]);
    assert.match(r.message, /ran on gemini-4-argon \(1 call\(s\)\)/);
    assert.match(r.message, /a-broken could not be read/);
    const run = cli([`--since=${SINCE}`, `--project-root=${project}`], home);
    assert.equal(run.status, 1, "a definite refusal, not a yes/no prompt");
  } finally { for (const d of [home, project]) rmSync(d, { recursive: true, force: true }); }
});

test("an unreadable record beside on-pin ones is not checked, and names the conversation it could not read", async () => {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const home = agyHomeWith(project, [
    { id: "a-broken", lastModified: "2026-10-14T16:00:00Z", steps: [T("2026-10-14T15:48:00Z")], gens: [{ model: "gemini-3.8-flash", fresh: 1, thinking: 1, text: 1, output: 5, step: 0 }] },
    { id: "b-this-chat", lastModified: "2026-10-14T16:00:00Z", steps: [T("2026-10-14T15:48:00Z")], gens: [{ model: "gemini-3.8-flash", fresh: 1, thinking: 1, text: 1, step: 0 }] },
  ]);
  try {
    const r = await checkDriverPin({ projectRoot: project, since: SINCE, home, today: TODAY });
    assert.equal(r.status, "unchecked", "the unreadable conversation may be this chat");
    assert.equal(r.reason, "record_unreadable");
    assert.deepEqual(r.models, { "gemini-3.8-flash": 1 });
    assert.match(r.message, /NOT CHECKED[\s\S]*a-broken could not be read[\s\S]*not a pass/);
  } finally { for (const d of [home, project]) rmSync(d, { recursive: true, force: true }); }
});

test("--output-dir writes the snapshot where the manifest reads it, for a run folder outside .sdlc/runs", async () => {
  const c = chat(["gemini-3.8-flash"]);
  try {
    const outputDir = join("examples", "workforce-ops", "passes", "pass1");
    const runDir = join(c.project, outputDir);
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY, runId: "pass1", outputDir, policyName: POLICY });
    assert.equal(r.status, "ok");
    assert.equal(r.snapshot_written, join(runDir, "policy_snapshot.yaml"));
    assert.ok(!existsSync(join(c.project, ".sdlc", "runs", "pass1")), "nothing is written under .sdlc/runs for this run");
    writeFileSync(join(runDir, "telemetry.jsonl"), "");
    const m = buildHarnessManifest({ runDir, runId: "pass1", env: {} });
    assert.equal(m.harness.pin?.slug, "gemini-3.8-flash-high");

    const again = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY, runId: "pass1", outputDir, policyName: POLICY });
    assert.equal(again.snapshot_written, undefined, "a resumed run keeps the snapshot in its output dir");
    rmSync(runDir, { recursive: true, force: true });
    const run = cli([`--since=${SINCE}`, `--project-root=${c.project}`, "--run-id=pass1", `--output-dir=${outputDir}`], c.home);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(runDir, "policy_snapshot.yaml")), "the CLI resolves --output-dir against --project-root");
  } finally { c.cleanup(); }
});

test("--run-id writes the run's policy_snapshot.yaml, so the manifest reads the pin and judges it", async () => {
  const c = chat(["gemini-3.8-flash"]);
  try {
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY, runId: "r1", policyName: POLICY });
    assert.equal(r.status, "ok");
    const runDir = join(c.project, ".sdlc", "runs", "r1");
    assert.equal(r.snapshot_written, join(runDir, "policy_snapshot.yaml"));
    assert.equal(readFileSync(r.snapshot_written, "utf8"), readFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), "utf8"));
    writeFileSync(join(runDir, "telemetry.jsonl"), "");
    writeFileSync(join(runDir, "driver-collector.json"), JSON.stringify({ source: "agy-local-record", run_id: "r1", reported_models: ["gemini-4-argon"], model_mismatch: ["gemini-4-argon"] }));
    const m = buildHarnessManifest({ runDir, runId: "r1", env: {} });
    assert.equal(m.harness.pin.slug, "gemini-3.8-flash-high", "the pin comes from the snapshot");
    assert.deepEqual([m.harness.pin.verified, m.harness.pin.unverified_reason], [false, "model_mismatch"]);

    writeFileSync(join(runDir, "driver-collector.json"), JSON.stringify({ source: "agy-local-record", run_id: "r1", reported_models: ["gemini-3.8-flash"], model_mismatch: [] }));
    const held = buildHarnessManifest({ runDir, runId: "r1", env: {} }).harness.pin;
    assert.deepEqual([held.verified, held.effort, held.effort_verified], [true, "high", false], "a chat's verified pin covers the model name, not the effort");
  } finally { c.cleanup(); }
});

test("a resumed run is checked against its own snapshot, which is kept, and another --policy is refused", async () => {
  const c = chat(["gemini-3.7-flash"]);
  try {
    const runDir = join(c.project, ".sdlc", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    const snapshot = readFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), "utf8").replace("model_name: gemini-3.8-flash", "model_name: gemini-3.7-flash");
    writeFileSync(join(runDir, "policy_snapshot.yaml"), snapshot);
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY, runId: "r1" });
    assert.equal(r.status, "ok", "the run started under a 3.7 Flash pin");
    assert.equal(r.snapshot_written, undefined);
    assert.equal(readFileSync(join(runDir, "policy_snapshot.yaml"), "utf8"), snapshot);
    await assert.rejects(() => checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: TODAY, runId: "r1", policyName: "another-policy" }), /started under policy 'antigravity-flash38-plus-opus5'/);
  } finally { c.cleanup(); }
});

test("a pin with no price on the day is refused before anything is dispatched", async () => {
  const c = chat(["gemini-3.8-flash"]);
  try {
    const r = await checkDriverPin({ projectRoot: c.project, since: SINCE, home: c.home, today: "2026-08-01T00:00:00Z" });
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "pin_unpriced");
    assert.match(r.message, /'gemini-3\.8-flash' has no price on 2026-08-01/);
  } finally { c.cleanup(); }
});

test("the interactive skills run the pin check before anything is dispatched, and at the run's start", () => {
  const read = (rel) => readFileSync(join(ROOT, "plugin", "skills", rel), "utf8");
  const CHECK = "agy/check-driver-pin.mjs";

  const guide = read("brownfield-guide/SKILL.md");
  const step1 = guide.slice(guide.indexOf("# 1. Setup-status check"), guide.indexOf("# 2. Pre-check"));
  assert.ok(step1.indexOf(CHECK) > step1.indexOf("date -u"), "step 1 checks after recording run_started_at");
  assert.ok(step1.indexOf(CHECK) < step1.indexOf("session-hydrate.mjs"), "and before anything else runs");
  assert.match(step1.slice(step1.indexOf('kind: "run"')), /check-driver-pin\.mjs[^\n]*--run-id=<run_id>/, "a resume checks against the run's own policy");
  const smoke = guide.slice(guide.indexOf("3. **Dispatch smoke.**"), guide.indexOf("# 3. Discovery"));
  assert.match(smoke, /check-driver-pin\.mjs/, "an unchecked step 1 is checked again before the smoke is dispatched");
  const gate0 = guide.slice(guide.indexOf("On `approved`:"));
  assert.ok(gate0.indexOf(CHECK) >= 0 && gate0.indexOf(CHECK) < gate0.indexOf("write-contract.mjs\" --freeze"), "Gate 0 checks and snapshots before the freeze");
  assert.match(gate0.slice(0, gate0.indexOf("--event=run.start")), /check-driver-pin\.mjs[^\n]*--run-id=<run-id>[^\n]*--policy=<policy>/);

  const greenfield = read("greenfield/SKILL.md");
  const step3 = greenfield.slice(greenfield.indexOf("# 3. Confirm where the output goes"), greenfield.indexOf("# 4. Show what will run"));
  assert.ok(step3.indexOf(CHECK) > step3.indexOf("run_started_at"), "greenfield checks where it records run_started_at");

  const pipeline = read("pipeline/SKILL.md");
  const markers = pipeline.slice(pipeline.indexOf("## Run start and end markers"), pipeline.indexOf("## Phase -1"));
  assert.ok(markers.indexOf(CHECK) >= 0 && markers.indexOf(CHECK) < markers.indexOf("--event=run.start"), "the pipeline checks and snapshots before run.start");
  assert.match(markers, /check-driver-pin\.mjs[^\n]*--run-id=<run_id>[^\n]*--policy=<policy>/);
  assert.match(markers, /check-driver-pin\.mjs[^\n]*--output-dir="<output_dir>"/, "the snapshot goes where the manifest reads it, whatever the layout");
});

