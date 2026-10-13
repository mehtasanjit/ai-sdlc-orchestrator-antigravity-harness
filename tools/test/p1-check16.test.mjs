/**
 * tools/p1/check16.mjs: the reader behind `tools/p1/live-checks.sh 16`. A
 * failed call must read as no answer, never as one of the two readings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { conversationId, lastResult, verdict } from "../p1/check16.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const usage = (o) => ({ input_tokens: 1000, output_tokens: o, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1000 + o });
const ok = (conv, o) => ({ conversation_id: conv, status: "OK", usage: usage(o) });
const ERROR = { conversation_id: "", status: "ERROR", error: "authentication failed or timed out", usage: usage(0) };

test("carried-over counters read as cumulative, restarted ones as per-invocation", () => {
  assert.equal(verdict({ exit: 0, result: ok("c1", 420) }, { exit: 0, result: ok("c1", 423) }).verdict, "cumulative");
  assert.equal(verdict({ exit: 0, result: ok("c1", 420) }, { exit: 0, result: ok("c1", 3) }).verdict, "per-invocation");
  assert.equal(verdict({ exit: 0, result: ok("c1", 420) }, { exit: 0, result: ok("c1", 300) }).verdict, "inconclusive");
});

test("a failed call, a missing result or a zero first call is no answer", () => {
  assert.match(verdict({ exit: 0, result: ok("c1", 420) }, { exit: 1, result: ERROR }).reason, /resume exited 1; resume status ERROR \(authentication/);
  assert.equal(verdict({ exit: 0, result: ok("c1", 420) }, { exit: 0, result: null }).verdict, "invalid");
  assert.equal(verdict({ exit: 0, result: ok("c1", 0) }, { exit: 0, result: ok("c1", 0) }).verdict, "invalid");
  assert.match(verdict({ exit: 0, result: ok("c1", 420) }, { exit: 0, result: ok("c2", 3) }).reason, /conversation c2, not c1/);
});

test("conversationId skips an empty id and lastResult takes the final result line", () => {
  const text = [JSON.stringify({ event: "result", result: ERROR }), '{"event":"init","conversation_id":"c9"}', "noise", JSON.stringify({ event: "result", result: ok("c9", 5) })].join("\n");
  assert.equal(conversationId(text), "c9");
  assert.equal(lastResult(text).status, "OK");
  assert.equal(conversationId("{}"), null);
});

test("the CLI prints a verdict and exits non-zero when the check gave no answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "p1-check16-"));
  try {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, `{"event":"init","conversation_id":"c1"}\n${JSON.stringify({ event: "result", result: ok("c1", 420) })}\n`);
    writeFileSync(b, `${JSON.stringify({ event: "result", result: ok("c1", 2) })}\n`);
    const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "tools", "p1", "check16.mjs"), ...args], { encoding: "utf8" });
    assert.equal(cli("--conversation", a).stdout.trim(), "c1");
    const good = cli(a, "0", b, "0");
    assert.equal(good.status, 0);
    assert.match(good.stdout, /check 16: PER-INVOCATION/);
    writeFileSync(b, `${JSON.stringify({ event: "result", result: ERROR })}\n`);
    const bad = cli(a, "0", b, "1");
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /check 16: INVALID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("check 17 names the one counter layout every result adds up to, and nothing less", async () => {
  const { layoutVerdict } = await import("../p1/check16.mjs");
  const r = (u) => ({ status: "OK", usage: u });
  assert.equal(layoutVerdict([r({ input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1250 })]).verdict, "cache-in-input+thinking-apart");
  assert.equal(layoutVerdict([r({ input_tokens: 1000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1650 })]).verdict, "cache-apart+thinking-apart");
  assert.equal(layoutVerdict([r({ input_tokens: 1000, output_tokens: 200, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1200 })]).verdict, "inconclusive", "no cache, no thinking: every layout fits");
  assert.equal(layoutVerdict([r({ input_tokens: 1, output_tokens: 1, total_tokens: 99 })]).verdict, "inconclusive");
  assert.equal(layoutVerdict([{ status: "ERROR", usage: { total_tokens: 0 } }]).verdict, "invalid");
});
