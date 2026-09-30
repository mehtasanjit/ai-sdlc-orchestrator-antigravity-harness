/**
 * The job-type proposal behind `/mmo:brownfield <text>` and `run.mjs --seed`:
 * plugin/scripts/infer-intent.mjs over the `cues` in plugin/config/intents.json.
 * A wrong proposal costs one confirmation question; a silent drift in the
 * cue table would cost a whole run, so the sentences below are pinned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INTENTS_PATH, inferIntent, loadIntents, matchCues } from "../../plugin/scripts/infer-intent.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "plugin", "scripts", "infer-intent.mjs");
const SKILLS = join(ROOT, "plugin", "skills");
const read = (p) => readFileSync(p, "utf8");

// ── the sentences the harness is asked to route ────────────────────────────

const SENTENCES = [
  ["add per-lane WIP limit to Board with over-cap indicator in LaneHeader", "feature-extend", "fallback"],
  ["add estimated-hours field to Card with per-lane hours rollup shown in LaneHeader", "feature-extend", "fallback"],
  ["add assignee and label filter chips at the top of Board with URL-persisted state", "feature-extend", "fallback"],
  ["extract LaneHeader component from Lane", "refactor", "cue"],
  ['add README section "Board features" documenting WIP limits, hours rollup, and filter chips', "docs", "cue"],
  ["add multi-day drag-to-select on WeekBody that creates a spanning event across the dragged day range", "feature-extend", "fallback"],
  ["add Repeats dropdown to Event detail panel with none/daily/weekly options; render derived instances read-only on the grid", "feature-extend", "fallback"],
  ["add six-color picker to Event detail panel with the selected color persisted per event and applied to the grid chip", "feature-extend", "fallback"],
  ["split WeekGrid into WeekHeader and WeekBody", "refactor", "cue"],
  ['add README section "Weekly view interactions" documenting multi-day select, recurring events, and event colors', "docs", "cue"],
  ["fix the /login endpoint returning 500 on missing password", "bugfix", "cue"],
  ["upgrade jest 28 → 29 (and adapt breaking changes)", "deps", "cue"],
  ["backfill unit tests for src/payments to reach 80% line coverage", "test", "cue"],
  ["add a webhooks module (endpoint, storage, retry loop)", "feature-new", "cue"],
];

test("every pinned sentence resolves to the job type its wording asks for", () => {
  for (const [text, intent, source] of SENTENCES) {
    const r = inferIntent(text);
    assert.equal(r.intent, intent, text);
    assert.equal(r.source, source, text);
  }
});

test("every intent's own example resolves to that intent", () => {
  for (const intent of loadIntents()) {
    assert.equal(inferIntent(intent.example).intent, intent.id, intent.example);
  }
});

test("a specific cue beats the generic add; two specific cues, or none, is ambiguous", () => {
  assert.equal(inferIntent("add docstrings to the auth module").intent, "docs");
  const collide = inferIntent("add a regression test for the 500");
  assert.equal(collide.intent, null);
  assert.deepEqual(collide.candidates.map((c) => c.id).sort(), ["bugfix", "test"]);
  for (const text of ["", "   ", "hello world"]) {
    const r = inferIntent(text);
    assert.equal(r.intent, null, JSON.stringify(text));
    assert.deepEqual(r.candidates, []);
  }
});

test("candidates come back most-matched first", () => {
  const r = inferIntent("fix the 500 crash and add a regression test");
  assert.equal(r.candidates[0].id, "bugfix");
  assert.ok(r.candidates[0].cues.length > r.candidates[1].cues.length);
});

// ── the registry ──────────────────────────────────────────────────────────

test("every intent carries non-empty, lowercase, trimmed cues, and no cue is claimed twice", () => {
  const seen = new Map();
  for (const intent of loadIntents()) {
    for (const key of ["cues", "fallback_cues"]) {
      if (!(key in intent)) { assert.equal(key, "fallback_cues", `${intent.id} lacks ${key}`); continue; }
      assert.ok(Array.isArray(intent[key]) && intent[key].length > 0, `${intent.id}.${key}`);
      for (const cue of intent[key]) {
        assert.equal(typeof cue, "string", `${intent.id}.${key}`);
        assert.equal(cue, cue.trim().toLowerCase(), `${intent.id}.${key}: ${JSON.stringify(cue)}`);
        assert.ok(cue.length > 0, `${intent.id}.${key} has an empty cue`);
        assert.ok(!seen.has(cue), `cue ${JSON.stringify(cue)} is under both ${seen.get(cue)} and ${intent.id}`);
        seen.set(cue, intent.id);
      }
    }
  }
  const extend = loadIntents().find((i) => i.id === "feature-extend");
  assert.ok(extend.fallback_cues.includes("add"), "add is the generic fallback");
});

test("INTENTS_PATH is the shipped registry", () => {
  assert.equal(resolve(INTENTS_PATH), join(ROOT, "plugin", "config", "intents.json"));
});

// ── matching rules ────────────────────────────────────────────────────────

test("cues match whole words and phrases, plurals, and any case", () => {
  assert.deepEqual(matchCues("Backfill the ADRs", ["adr", "backfill"]), ["adr", "backfill"]);
  assert.deepEqual(matchCues("write the api  docs", ["api docs"]), ["api docs"]);
  assert.deepEqual(matchCues("specials menu", ["spec"]), []);
  assert.deepEqual(matchCues("returns 1500 items", ["500"]), []);
  assert.deepEqual(matchCues("fixes the bugs", ["fix", "bug"]), ["fix", "bug"]);
  assert.deepEqual(matchCues("a c++ parser", ["c++"]), ["c++"]);
});

// ── the CLI ───────────────────────────────────────────────────────────────

const run = (...argv) => spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8" });

test("the CLI prints the id and exits 0, or ambiguous with candidates and exits 2, or usage and exits 1", () => {
  const ok = run("extract LaneHeader component from Lane");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "refactor\n");

  const json = run("--json", "extract LaneHeader component from Lane");
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).intent, "refactor");

  const amb = run("fix the 500 and add a regression test");
  assert.equal(amb.status, 2);
  const [first, second] = amb.stdout.split("\n");
  assert.equal(first, "ambiguous");
  assert.match(second, /^candidates: bugfix, test$/);

  const none = run();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Usage: node infer-intent\.mjs/);
});

// ── the handover the skills hand the guide ────────────────────────────────

test("the brownfield skill takes free text and asks for a proposal; the aliases still pre-select their intent", () => {
  const ids = loadIntents().map((i) => i.id);
  const brownfield = read(join(SKILLS, "brownfield", "SKILL.md"));
  assert.match(brownfield, /^argument-hint:/m);
  assert.match(brownfield, /`intent_from_seed: true`/);
  assert.match(brownfield, /\$ARGUMENTS/);
  for (const id of ids) assert.ok(!brownfield.includes(`\`intent: ${id}\``), `brownfield must not pre-select ${id}`);

  for (const id of ids) {
    const alias = read(join(SKILLS, id, "SKILL.md"));
    assert.ok(alias.includes(`\`intent: ${id}\``), `${id} alias pre-selects its intent`);
    assert.match(alias, /\$ARGUMENTS/);
    assert.ok(!alias.includes("intent_from_seed"), `${id} alias never asks for a proposal`);
  }

  const guide = read(join(SKILLS, "brownfield-guide", "SKILL.md"));
  assert.match(guide, /scripts\/infer-intent\.mjs/);
  assert.match(guide, /intent_from_seed/);
  assert.match(guide, /intent_source: inferred/);
  assert.ok(readdirSync(SKILLS).includes("brownfield-guide"));
});
