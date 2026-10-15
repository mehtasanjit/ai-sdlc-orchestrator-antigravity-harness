#!/usr/bin/env node
/**
 * Reads the two streams `tools/p1/live-checks.sh 16` records and says what
 * they show about check 16 (usage across a `--conversation` resume) and
 * check 17 (how agy's usage counters nest).
 *
 *   node tools/p1/check16.mjs --conversation <first.jsonl>
 *   node tools/p1/check16.mjs <first.jsonl> <first-exit> <resume.jsonl> <resume-exit>
 *
 * Dependency-free: it runs before the bridge is built.
 */

import { readFileSync } from "node:fs";
import { isMain } from "../../plugin/scripts/lib/is-main.mjs";
import { readingsThatFit } from "../../plugin/agy/telemetry/tokenLayouts.mjs";

function events(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === "object") out.push(ev);
    } catch { /* not an event line */ }
  }
  return out;
}

/** The first non-empty conversation id, from `init` or `result`, as run.mjs reads it. */
export function conversationId(text) {
  for (const ev of events(text)) {
    const id = ev.conversation_id ?? ev.result?.conversation_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

export function lastResult(text) {
  return events(text).filter((e) => e.event === "result").at(-1)?.result ?? null;
}

/**
 * The first call writes about 300 words; the resume replies "ok". If the
 * counters carry over, the resume's output_tokens include the first call's;
 * if they restart, they are a handful. Anything short of two successful
 * results is no answer at all. agy 1.3.0 reports `SUCCESS`; earlier builds `OK`.
 */
const OK_STATUSES = new Set(["OK", "SUCCESS"]);

export function verdict(first, resume) {
  const problems = [];
  for (const [name, call] of [["first call", first], ["resume", resume]]) {
    if (call.exit !== 0) problems.push(`${name} exited ${call.exit}`);
    if (!call.result) problems.push(`${name} printed no result event`);
    else if (!OK_STATUSES.has(call.result.status)) problems.push(`${name} status ${call.result.status}${call.result.error ? ` (${call.result.error})` : ""}`);
  }
  const a = first.result?.usage?.output_tokens ?? 0;
  const b = resume.result?.usage?.output_tokens ?? 0;
  if (!problems.length && a === 0) problems.push("first call reported 0 output tokens");
  if (!problems.length && resume.result?.conversation_id && first.result?.conversation_id && resume.result.conversation_id !== first.result.conversation_id) {
    problems.push(`resume answered on conversation ${resume.result.conversation_id}, not ${first.result.conversation_id}`);
  }
  if (problems.length) return { verdict: "invalid", reason: problems.join("; ") };
  if (b >= a) return { verdict: "cumulative", reason: `resume output_tokens ${b} ≥ first call's ${a}: the counters carried over` };
  if (b < a / 2) return { verdict: "per-invocation", reason: `resume output_tokens ${b} < half the first call's ${a}: the counters restarted` };
  return { verdict: "inconclusive", reason: `resume output_tokens ${b} against the first call's ${a} fits neither reading` };
}

/**
 * Check 17: which layout of agy's counters each non-zero result adds up to.
 * Answered when every result fits exactly one layout and all fit the same one.
 */
export function layoutVerdict(results) {
  const usable = results.filter((r) => r?.usage && (r.usage.total_tokens ?? 0) > 0);
  if (!usable.length) return { verdict: "invalid", reason: "no result reported non-zero usage" };
  const fits = usable.map((r) => readingsThatFit(r.usage));
  if (fits.some((f) => f.length === 0)) return { verdict: "inconclusive", reason: `a result's counters add up to no layout: ${JSON.stringify(usable[fits.findIndex((f) => !f.length)].usage)}` };
  const common = fits.reduce((a, b) => a.filter((x) => b.includes(x)));
  if (common.length === 1) return { verdict: common[0], reason: `every result sums to total_tokens only as ${common[0]}` };
  if (common.length === 0) return { verdict: "inconclusive", reason: "the results fit different layouts" };
  return { verdict: "inconclusive", reason: `the counters fit ${common.join(" and ")} alike; a result with both cache reads and thinking settles it` };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--conversation") {
    const id = conversationId(readFileSync(argv[1], "utf8"));
    if (id) console.log(id);
    process.exit(id ? 0 : 1);
  }
  if (argv.length !== 4) {
    console.error("usage: check16.mjs <first.jsonl> <first-exit> <resume.jsonl> <resume-exit>");
    process.exit(2);
  }
  const call = (file, exit) => ({ exit: Number(exit), result: lastResult(readFileSync(file, "utf8")) });
  const first = call(argv[0], argv[1]);
  const resume = call(argv[2], argv[3]);
  for (const [name, c] of [["16a first ", first], ["16b resume", resume]]) {
    console.log(`   ${name}: exit=${c.exit} status=${c.result?.status ?? "—"} conversation=${c.result?.conversation_id || "—"} usage=${JSON.stringify(c.result?.usage ?? null)}`);
  }
  const v = verdict(first, resume);
  console.log(`\n   check 16: ${v.verdict.toUpperCase()} — ${v.reason}`);
  const layout = layoutVerdict([first.result, resume.result]);
  console.log(`   check 17: ${layout.verdict.toUpperCase()} — ${layout.reason}`);
  process.exit(v.verdict === "invalid" ? 1 : 0);
}
