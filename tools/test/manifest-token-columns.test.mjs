/**
 * The manifest's cost lines and usage block, and the report's tables, carry
 * the cache-read, cache-write (with the 1-hour share) and thinking tokens the
 * dollars were billed on, so each line re-prices from its own columns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";
import { computeCostUsd } from "../../plugin/mcp/model-dispatch/dist/pricing.js";
import { lookupPrice } from "../../plugin/mcp/model-dispatch/dist/prices.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = join(ROOT, "tools", "report.mjs");
const POLICY = "antigravity-flash38-plus-opus5";
const DAY = "2026-09-16";

const price = (model) => lookupPrice(model, DAY).pricing;

const reprice = (model, row) => computeCostUsd({
  input: row.input_tokens,
  input_cached: row.input_tokens_cached,
  input_cache_write: row.input_tokens_cache_write - row.input_tokens_cache_write_1h,
  input_cache_write_1h: row.input_tokens_cache_write_1h,
  output: row.output_tokens,
}, price(model));

function ev({ model, adapter, input, cached = 0, write5m = 0, write1h = 0, output, reasoning, phase = "codegen" }) {
  return {
    ts: `${DAY}T10:00:00.000Z`, pass: "r1", phase, task_type: "x", task_id: "t", module: "m", model, adapter,
    routed_by: "orchestrator", provenance: "vendor",
    routing: { policy_name: POLICY, policy_version: 1, rule_index: 0, rule_reason: "x" },
    input_tokens: input, input_tokens_cached: cached,
    ...(write5m + write1h > 0 ? { input_tokens_cache_write: write5m + write1h, input_tokens_cache_write_1h: write1h } : {}),
    output_tokens: output,
    ...(reasoning !== undefined ? { output_tokens_reasoning: reasoning } : {}),
    cost_usd: computeCostUsd({ input, input_cached: cached, input_cache_write: write5m, input_cache_write_1h: write1h, output }, price(model)),
    latency_ms: 10, success: true, retry_count: 0,
  };
}

const EVENTS = [
  ev({ model: "claude-opus-5", adapter: "claude-agent-sdk", phase: "requirements_analysis", input: 18, cached: 2_643, write1h: 230_809, output: 4_000 }),
  ev({ model: "claude-opus-5", adapter: "claude-agent-sdk", phase: "architecture_design", input: 6, cached: 33_475, write5m: 900, write1h: 1_200, output: 6_000 }),
  ev({ model: "gemini-3.8-flash", adapter: "mcp:model-dispatch", input: 9_000, cached: 4_000, output: 2_000, reasoning: 1_500 }),
];

function runDir() {
  const dir = mkdtempSync(join(tmpdir(), "agy-token-columns-"));
  copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(dir, "policy_snapshot.yaml"));
  writeFileSync(join(dir, "telemetry.jsonl"), EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

test("each worker line re-prices from its own token columns to its cost_usd", () => {
  const dir = runDir();
  try {
    const m = buildHarnessManifest({ runDir: dir, runId: "r1", env: { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" } });
    const claude = m.cost.lines.find((l) => l.line === "claude_worker");
    const gemini = m.cost.lines.find((l) => l.line === "gemini_workers");
    assert.ok(Math.abs(reprice("claude-opus-5", claude) - claude.cost_usd) <= 2e-6, `${reprice("claude-opus-5", claude)} vs ${claude.cost_usd}`);
    assert.ok(Math.abs(reprice("gemini-3.8-flash", gemini) - gemini.cost_usd) <= 1e-6);
    assert.equal(claude.input_tokens_cache_write, 232_909);
    assert.equal(claude.input_tokens_cache_write_1h, 232_009);
    assert.equal(gemini.output_tokens_reasoning, 1_500);
    for (const [model, row] of Object.entries(m.model_breakdown)) {
      assert.ok(Math.abs(reprice(model, row) - row.cost_usd) <= row.calls * 1e-6, model);
    }
    assert.equal(m.usage.dispatched.input_tokens_cache_write_1h, 232_009);
    assert.equal(m.usage.dispatched.output_tokens_reasoning, 1_500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the report shows cache reads and writes beside tokens in, and names the 1-hour writes", () => {
  const dir = runDir();
  try {
    const r = spawnSync(process.execPath, [REPORT, dir, "--run-id=r1"], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "k" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /claude worker\s+cash\s+2\s+24 \/ 10\.0K\s+36\.1K \/ 232\.9K\s+\$/);
    assert.match(r.stdout, /^\s+requirements_analysis\s+V\s+1\s+18 \/ 4\.0K\s+2\.6K \/ 230\.8K\s+\$/m);
    assert.match(r.stdout, /232009 of 232909 cache writes are 1-hour writes/);

    const md = spawnSync(process.execPath, [REPORT, dir, "--run-id=r1", "--markdown"], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "k" } }).stdout;
    assert.match(md, /\| claude worker \| cash \| 2 \| 24 \/ 10\.0K \| 36\.1K \/ 232\.9K \| \$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
