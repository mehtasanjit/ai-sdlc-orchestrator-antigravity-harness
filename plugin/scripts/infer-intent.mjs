#!/usr/bin/env node
/**
 * Proposes a brownfield job type from a one-line job description, using the
 * `cues` and `fallback_cues` arrays in plugin/config/intents.json.
 *
 * A cue matches as a whole word or phrase, case-insensitive, with an optional
 * plural suffix. Cues decide on their own; fallback cues only count when no
 * intent's cues matched anywhere. Exactly one matching intent wins; none or
 * several is `ambiguous`, and the caller asks the seven-option question
 * instead. Gate 0 re-confirms whatever was proposed.
 *
 * The brownfield guide runs this at step 4a for `/mmo:brownfield <text>`;
 * plugin/agy/run.mjs runs it at launch for `--mode=brownfield --seed=<text>`
 * with no `--intent`, so the record never depends on the model's reading.
 *
 * Usage:
 *   node infer-intent.mjs [--json] <job description>
 *
 * Exit 0 with the id on stdout; 2 with `ambiguous` and a `candidates:` line
 * (or `{"intent":null,…}` under --json); 1 on a usage error.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

export const INTENTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "intents.json");

export function loadIntents(path = INTENTS_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? raw : (raw.intents ?? []);
}

function cuePattern(cue) {
  const escaped = cue.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![a-z0-9])${escaped}(?:s|es)?(?![a-z0-9])`, "i");
}

/** The cues from `cues` that occur in `text`, in registry order. */
export function matchCues(text, cues = []) {
  return cues.filter((cue) => cuePattern(cue).test(text));
}

/**
 * @returns {{ intent: string|null, source: "cue"|"fallback"|null, candidates: {id: string, cues: string[]}[] }}
 */
export function inferIntent(text, intents = loadIntents()) {
  const seed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!seed) return { intent: null, source: null, candidates: [] };
  const hits = (key) => intents
    .map((i) => ({ id: i.id, cues: matchCues(seed, i[key]) }))
    .filter((c) => c.cues.length > 0)
    .sort((a, b) => b.cues.length - a.cues.length);
  let source = "cue";
  let candidates = hits("cues");
  if (candidates.length === 0) {
    source = "fallback";
    candidates = hits("fallback_cues");
  }
  if (candidates.length === 1) return { intent: candidates[0].id, source, candidates };
  return { intent: null, source: null, candidates };
}

function main(argv) {
  const json = argv.includes("--json");
  const text = argv.filter((a) => a !== "--json").join(" ");
  if (!text.trim()) {
    console.error("infer-intent: pass the job description as an argument.\nUsage: node infer-intent.mjs [--json] <job description>");
    return 1;
  }
  const result = inferIntent(text);
  if (json) {
    console.log(JSON.stringify(result));
    return result.intent ? 0 : 2;
  }
  if (result.intent) {
    console.log(result.intent);
    return 0;
  }
  console.log("ambiguous");
  console.log(`candidates: ${result.candidates.length ? result.candidates.map((c) => c.id).join(", ") : "none"}`);
  return 2;
}

if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
