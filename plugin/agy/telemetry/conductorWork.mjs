/**
 * Work the conductor did itself, read back from the run folder: judgment
 * phases that left no telemetry row, and artifacts whose final content is not
 * what any worker returned. Both are evidence for a reader, not a verdict.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** State-machine order (plugin/skills/pipeline/SKILL.md); brownfield adds discovery. */
export const JUDGMENT_PHASES = {
  greenfield: ["requirements_analysis", "architecture_design", "plan_task_packets", "senior_code_review", "security_review"],
  brownfield: ["discovery", "requirements_analysis", "architecture_design", "plan_task_packets", "senior_code_review", "security_review"],
};

// A brownfield design phase may be dispatched as change_plan.
const ROW_PHASES = { architecture_design: ["architecture_design", "change_plan"] };

const ARTIFACTS = {
  discovery: ["discovery.md"],
  requirements_analysis: ["requirements.md"],
  architecture_design: ["design.md", "change_plan.md"],
  plan_task_packets: ["packets.json"],
  senior_code_review: ["review.json"],
  security_review: ["security_review.md"],
};

// A row in any of these means the run executed a plan.
const AFTER_PLAN = new Set(["codegen", "tests", "docs", "debug", "refactor"]);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function runMode(runDir, declared = null) {
  if (declared === "greenfield" || declared === "brownfield") return declared;
  if (["discovery.md", "intent_brief.md", "baseline.json"].some((f) => existsSync(join(runDir, f)))) return "brownfield";
  const packets = planPackets(runDir) ?? [];
  return packets.some((p) => p?.mode === "brownfield" || p?.intent) ? "brownfield" : "greenfield";
}

/**
 * Judgment phases the run went through with neither a dispatched event nor a
 * `provenance: "none"` row. A phase counts as gone through when its artifact
 * is in the run folder, when a later phase left a row or an artifact, or when
 * the run completed — so a run that stopped early does not list the phases
 * it never reached.
 */
export function unrecordedPhases({ runDir, telemetry, mode, completed = false }) {
  const phases = JUDGMENT_PHASES[mode] ?? JUDGMENT_PHASES.greenfield;
  const logged = new Set(telemetry.filter((e) => e.tier !== "orchestrator").map((e) => e.phase));
  const hasRow = (p) => (ROW_PHASES[p] ?? [p]).some((q) => logged.has(q));
  let reached = completed || existsSync(join(runDir, "SUMMARY.md")) ? phases.length - 1 : -1;
  if ([...logged].some((p) => AFTER_PLAN.has(p))) reached = Math.max(reached, phases.indexOf("plan_task_packets"));
  phases.forEach((p, i) => {
    if (hasRow(p) || ARTIFACTS[p].some((f) => existsSync(join(runDir, f)))) reached = Math.max(reached, i);
  });
  return phases.slice(0, reached + 1).filter((p) => !hasRow(p));
}

function planPackets(runDir) {
  const raw = readJson(join(runDir, "packets.json"));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.packets) ? raw.packets : null;
  return list?.filter((p) => p && typeof p === "object") ?? null;
}

/** JSON files in the run folder and one level below — where packet and result files land. */
function runJsonFiles(runDir) {
  const out = [];
  for (const name of readdirSync(runDir).sort()) {
    const path = join(runDir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isFile() && name.endsWith(".json")) out.push(path);
    else if (stat.isDirectory()) {
      for (const sub of readdirSync(path).sort()) if (sub.endsWith(".json")) out.push(join(path, sub));
    }
  }
  return out;
}

const normalizePath = (p) => String(p).replace(/^\.\//, "");
const sha256 = (text) => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");

// The two field names codegen packets' outputSchema uses. A `raw` or
// `__free_text__` result is a reply the bridge could not parse, so it is not
// the file and stays unknown.
function fileContent(output) {
  if (typeof output?.content === "string") return output.content;
  if (typeof output?.code === "string") return output.code;
  return undefined;
}

// A write tool adding or dropping the final newline is not an edit.
function sameContent(content, sha) {
  const bare = content.replace(/\n$/, "");
  return sha === sha256(bare) || sha === sha256(bare + "\n");
}

/**
 * For each planned `artifact_path`, whether the file the run left (its last
 * `sha_after` in provenance.json) differs from the content of the last
 * successful worker result for a packet that targets that path. `differs` is
 * null when either side is missing. The whole block is null when the run
 * folder cannot tell: no planned artifact paths, no provenance.json, or no
 * saved worker result (the MCP route returns results in-session only).
 */
export function conductorEdits(runDir) {
  const planned = (planPackets(runDir) ?? []).filter((p) => p.id && p.artifact_path);
  const provenance = readJson(join(runDir, "provenance.json"));
  const touched = Array.isArray(provenance?.files_touched) ? provenance.files_touched : null;
  if (!planned.length || !touched) return null;

  const pathOf = new Map(planned.map((p) => [p.id, normalizePath(p.artifact_path)]));
  const results = [];
  for (const file of runJsonFiles(runDir)) {
    const j = readJson(file);
    if (!j || typeof j !== "object" || Array.isArray(j)) continue;
    if (j.id && j.artifact_path && j.instruction && !pathOf.has(j.id)) pathOf.set(j.id, normalizePath(j.artifact_path));
    const content = fileContent(j.result?.result);
    const events = Array.isArray(j.events) ? j.events : [];
    if (typeof content !== "string" || j.result?.success === false || !events[0]?.task_id) continue;
    const ts = events.map((e) => e.ts ?? "").sort().at(-1);
    results.push({ task_id: events[0].task_id, ts, content });
  }
  if (!results.length) return null;

  const finalSha = new Map();
  for (const rec of touched) if (rec?.path && rec.sha_after) finalSha.set(normalizePath(rec.path), rec.sha_after);

  const paths = [...new Set(planned.map((p) => normalizePath(p.artifact_path)))];
  const files = paths.map((path) => {
    const last = results.filter((r) => pathOf.get(r.task_id) === path).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).at(-1);
    const sha = finalSha.get(path);
    return { path, packet_id: last?.task_id ?? null, differs: last && sha ? !sameContent(last.content, sha) : null };
  });
  const targeted = new Set(pathOf.values());
  return {
    basis: "sha256 of the last worker result's content per artifact_path, against its last sha_after in provenance.json",
    edited: files.filter((f) => f.differs === true).length,
    unchanged: files.filter((f) => f.differs === false).length,
    unknown: files.filter((f) => f.differs === null).length,
    files,
    unplanned: [...finalSha.keys()].filter((p) => !targeted.has(p)),
  };
}

/** The two fields buildHarnessManifest adds to its harness block. */
export function conductorWork({ runDir, telemetry, mode = null, completed = false }) {
  return {
    unrecorded_phases: unrecordedPhases({ runDir, telemetry, mode: runMode(runDir, mode), completed: completed === true }),
    conductor_edits: conductorEdits(runDir),
  };
}
