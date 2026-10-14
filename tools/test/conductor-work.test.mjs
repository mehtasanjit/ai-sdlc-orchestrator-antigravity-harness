/**
 * Conductor work the manifest detects (plugin/agy/telemetry/conductorWork.mjs):
 * judgment phases with no telemetry row, and planned files whose final
 * content is not what the last worker returned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { conductorEdits, conductorWork, runMode, unrecordedPhases, JUDGMENT_PHASES } from "../../plugin/agy/telemetry/conductorWork.mjs";
import { buildHarnessManifest, readJsonl } from "../../plugin/agy/manifest.mjs";
import { buildLogEventArgs } from "../../plugin/agy/dispatch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = "antigravity-flash38-plus-opus5";
const sha = (text) => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");

const row = (phase, over = {}) => ({
  ts: "2026-09-30T12:00:00.000Z", pass: "r1", phase, task_type: "x", task_id: phase, module: "m",
  model: "claude-opus-5", adapter: "claude-agent-sdk", routed_by: "orchestrator", provenance: "vendor",
  routing: { policy_name: POLICY, policy_version: 1, rule_index: 0, rule_reason: "x" },
  input_tokens: 10, input_tokens_cached: 0, output_tokens: 10, cost_usd: 0.01, success: true, retry_count: 0,
  ...over,
});

/** The exact row `dispatch.mjs --log-phase=<phase> --task-type=in_session` hands the bridge. */
const inSession = (phase) => buildLogEventArgs({ phase, taskType: "in_session", telemetryPath: "/unused" }).event;

function runDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "conductor-work-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

const telemetry = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** A finished brownfield run shaped like the 2026-09-30 interactive one: the plan was written locally. */
function brownfieldRun(extra = {}) {
  return runDir({
    "telemetry.jsonl": telemetry([
      row("requirements_analysis"),
      row("architecture_design"),
      row("codegen", { model: "gemini-3.8-flash", adapter: "mcp:model-dispatch" }),
      row("tests", { model: "gemini-3.8-flash", adapter: "mcp:model-dispatch" }),
      row("senior_code_review"),
      row("security_review"),
    ]),
    "discovery.md": "# discovery\n",
    "intent_brief.md": "# brief\n",
    "requirements.md": "# req\n",
    "change_plan.md": "# plan\n",
    "packets.json": [],
    "review.json": {},
    "security_review.md": "# sec\n",
    "SUMMARY.md": "# summary\n",
    ...extra,
  });
}

test("a run with no plan_task_packets row lists it; an in_session row clears it", () => {
  const dir = brownfieldRun();
  try {
    const read = () => unrecordedPhases({ runDir: dir, telemetry: readJsonl(join(dir, "telemetry.jsonl")), mode: runMode(dir) });
    assert.deepEqual(read(), ["discovery", "plan_task_packets"]);

    appendFileSync(join(dir, "telemetry.jsonl"), JSON.stringify(inSession("plan_task_packets")) + "\n");
    assert.deepEqual(read(), ["discovery"], "a provenance:none row records the phase");

    appendFileSync(join(dir, "telemetry.jsonl"), JSON.stringify(inSession("discovery")) + "\n");
    assert.deepEqual(read(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a dispatched plan_task_packets event records the phase", () => {
  const dir = brownfieldRun();
  try {
    const rows = [...readJsonl(join(dir, "telemetry.jsonl")), row("plan_task_packets", { task_type: "packet_plan" }), inSession("discovery")];
    assert.deepEqual(unrecordedPhases({ runDir: dir, telemetry: rows, mode: "brownfield" }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("greenfield expects no discovery, and a brownfield change_plan row stands for architecture_design", () => {
  const dir = runDir({ "requirements.md": "r", "design.md": "d", "packets.json": [], "SUMMARY.md": "s" });
  try {
    assert.equal(runMode(dir), "greenfield");
    const rows = JUDGMENT_PHASES.greenfield.filter((p) => p !== "plan_task_packets").map((p) => row(p));
    assert.deepEqual(unrecordedPhases({ runDir: dir, telemetry: rows, mode: "greenfield" }), ["plan_task_packets"]);
    const brown = ["discovery", "requirements_analysis", "change_plan", "plan_task_packets", "senior_code_review", "security_review"].map((p) => row(p));
    assert.deepEqual(unrecordedPhases({ runDir: dir, telemetry: brown, mode: "brownfield" }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run that stopped early does not list the phases it never reached", () => {
  const dir = runDir({ "discovery.md": "d", "requirements.md": "r" });
  try {
    assert.equal(runMode(dir), "brownfield");
    assert.deepEqual(unrecordedPhases({ runDir: dir, telemetry: [row("requirements_analysis")], mode: "brownfield" }), ["discovery"]);
    assert.deepEqual(unrecordedPhases({ runDir: dir, telemetry: [inSession("discovery"), row("requirements_analysis")], mode: "brownfield" }), []);
    assert.equal(
      unrecordedPhases({ runDir: dir, telemetry: [inSession("discovery"), row("requirements_analysis")], mode: "brownfield", completed: true }).length,
      4,
      "a completed run expects every phase",
    );
    // Codegen rows mean a plan was executed, even with packets.json gone.
    assert.deepEqual(unrecordedPhases({ runDir: dir, telemetry: [inSession("discovery"), row("requirements_analysis"), row("change_plan"), row("codegen")], mode: "brownfield" }), ["plan_task_packets"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the launcher's declared mode wins over what the folder suggests", () => {
  const dir = runDir({ "packets.json": [{ id: "tp", mode: "brownfield" }] });
  try {
    assert.equal(runMode(dir), "brownfield");
    assert.equal(runMode(dir, "greenfield"), "greenfield");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const packet = (id, path) => ({ id, phase: "codegen", task_type: "new_file_add", artifact_path: path, instruction: `write ${path}` });
const result = (id, content, ts = "2026-09-30T13:00:00.000Z") => ({
  decision: { modelId: "flash-completion" },
  result: { result: { content }, success: true },
  events: [{ task_id: id, ts }],
  terminal_reason: "success",
});
const touched = (path, text) => ({ path, existed_before: false, sha_before: null, sha_after: sha(text), written_at: "2026-09-30T14:00:00.000Z" });

function editsRun(over = {}) {
  return runDir({
    "packets.json": [packet("tp_a", "src/a.js"), packet("tp_b", "src/b.js"), packet("tp_c", "src/c.js")],
    "packets/tp_a_result.json": result("tp_a", "export const a = 1;"),
    "packets/tp_b_result.json": result("tp_b", "export const b = 1;"),
    "provenance.json": {
      schema_version: 1,
      files_touched: [
        touched("src/a.js", "export const a = 1;\n"),
        touched("src/b.js", "export const b = 2; // conductor's own fix\n"),
        touched("src/c.js", "export const c = 1;\n"),
        touched("tests/d.test.js", "test('unplanned')\n"),
      ],
    },
    ...over,
  });
}

test("conductor_edits flags a file that differs from its worker result and passes one that matches", () => {
  const dir = editsRun();
  try {
    const out = conductorEdits(dir);
    const by = Object.fromEntries(out.files.map((f) => [f.path, f]));
    assert.equal(by["src/a.js"].differs, false, "same content, give or take the final newline");
    assert.equal(by["src/b.js"].differs, true);
    assert.equal(by["src/b.js"].packet_id, "tp_b");
    assert.equal(by["src/c.js"].differs, null, "no saved worker result: unknown, not unedited");
    assert.deepEqual([out.edited, out.unchanged, out.unknown], [1, 1, 1]);
    assert.deepEqual(out.unplanned, ["tests/d.test.js"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a dispatched refinement is the last worker result for its path", () => {
  const dir = editsRun({
    "packet-tp_b_refine.json": packet("tp_b_refine", "src/b.js"),
    "result-tp_b_refine.json": result("tp_b_refine", "export const b = 2; // conductor's own fix\n", "2026-09-30T13:30:00.000Z"),
  });
  try {
    const b = conductorEdits(dir).files.find((f) => f.path === "src/b.js");
    assert.deepEqual(b, { path: "src/b.js", packet_id: "tp_b_refine", differs: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("conductor_edits is null when the run folder cannot tell", () => {
  const noProvenance = editsRun();
  rmSync(join(noProvenance, "provenance.json"));
  const noResults = editsRun();
  rmSync(join(noResults, "packets"), { recursive: true });
  const noPaths = editsRun({ "packets.json": [{ id: "tp_a", phase: "codegen" }] });
  try {
    assert.equal(conductorEdits(noProvenance), null);
    assert.equal(conductorEdits(noResults), null, "the MCP route saves no result file");
    assert.equal(conductorEdits(noPaths), null, "greenfield packets carry no artifact_path");
  } finally {
    for (const d of [noProvenance, noResults, noPaths]) rmSync(d, { recursive: true, force: true });
  }
});

test("buildHarnessManifest carries both fields in its harness block", () => {
  const dir = brownfieldRun({
    "packets.json": [packet("tp_a", "src/a.js"), packet("tp_b", "src/b.js"), packet("tp_c", "src/c.js")],
    "packets/tp_a_result.json": result("tp_a", "export const a = 1;"),
    "packets/tp_b_result.json": result("tp_b", "export const b = 1;"),
    "provenance.json": { files_touched: [touched("src/a.js", "export const a = 1;"), touched("src/b.js", "changed")] },
  });
  try {
    const m = buildHarnessManifest({ runDir: dir, policyName: POLICY, runId: "r1", env: {}, now: () => "N" });
    assert.deepEqual(m.harness.unrecorded_phases, ["discovery", "plan_task_packets"]);
    assert.equal(m.harness.conductor_edits.edited, 1);
    assert.equal(m.harness.conductor_edits.files.find((f) => f.path === "src/b.js").differs, true);
    assert.deepEqual(conductorWork({ runDir: dir, telemetry: readJsonl(join(dir, "telemetry.jsonl")) }).unrecorded_phases, m.harness.unrecorded_phases);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the playbooks tell the conductor to leave the rows this detection reads", () => {
  const pipeline = readFileSync(join(ROOT, "plugin", "skills", "pipeline", "SKILL.md"), "utf8");
  const phase4 = pipeline.slice(pipeline.indexOf("### Phase 4"), pipeline.indexOf("### Brownfield-mode task types"));
  assert.match(phase4, /Dispatch a packet \(`phase: "plan_task_packets"`/);
  assert.match(phase4, /never generate the plan with a local script/);
  assert.doesNotMatch(pipeline, /already counted in the driver-loop events/, "false on an interactive run, where the driver is not measured");
  assert.match(pipeline, /refinement\s+packets[\s\S]{0,40}are always dispatched/);
  const guide = readFileSync(join(ROOT, "plugin", "skills", "brownfield-guide", "SKILL.md"), "utf8");
  assert.match(guide, /--log-phase=discovery --task-type=in_session/);
});
