/**
 * Every dispatch keeps its own result file, and a Claude worker line names
 * each model its events billed, side models included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDispatch, keepEarlierResult } from "../../plugin/agy/dispatch.mjs";
import { costLines } from "../../plugin/agy/manifest.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "agy-dispatch-results-")); }

test("two dispatches of one packet leave two result files, the newest at --out", async () => {
  const dir = tmp();
  try {
    const packetPath = join(dir, "packet.json");
    writeFileSync(packetPath, JSON.stringify({ id: "phase-1-requirements", phase: "requirements_analysis", pass_id: "r1" }));
    let n = 0;
    const connect = async () => ({ callTool: async () => ({ result: { success: true, cost_usd: ++n } }), close: async () => {} });
    const out = join(dir, "phase-1.result.json");
    const args = { packet: packetPath, out, telemetry: join(dir, "t.jsonl") };
    await runDispatch(args, { connect });
    await runDispatch(args, { connect });
    await runDispatch(args, { connect });
    assert.equal(JSON.parse(readFileSync(out, "utf8")).result.cost_usd, 3, "--out holds the newest result");
    assert.equal(JSON.parse(readFileSync(join(dir, "phase-1.result.1.json"), "utf8")).result.cost_usd, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, "phase-1.result.2.json"), "utf8")).result.cost_usd, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("keepEarlierResult leaves a path with nothing at it alone", () => {
  const dir = tmp();
  try {
    assert.equal(keepEarlierResult(join(dir, "none.json")), null);
    assert.equal(existsSync(join(dir, "none.1.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the Claude worker line names a side model its ledger billed", () => {
  const event = {
    pass: "r1", phase: "requirements_analysis", task_id: "t", model: "claude-opus-5", adapter: "claude-agent-sdk", provenance: "vendor",
    input_tokens: 21_518, input_tokens_cached: 0, output_tokens: 3_140, cost_usd: 0.1,
    worker_per_model: [
      { model: "claude-opus-5", reported_as: ["claude-opus-5"], tokens: { input: 18, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 3_100 }, cost_usd: 0.07759 },
      { model: "claude-haiku-4-5", reported_as: ["claude-haiku-4-5"], tokens: { input: 21_500, input_cached: 0, input_cache_write: 0, input_cache_write_1h: 0, output: 40 }, cost_usd: 0.0217 },
    ],
  };
  const lines = costLines({ dispatched: [event], modeled: [], policy: null, pin: null, env: { ANTHROPIC_API_KEY: "k" } });
  assert.deepEqual(lines.find((l) => l.line === "claude_worker").models, ["claude-opus-5", "claude-haiku-4-5"]);
});
