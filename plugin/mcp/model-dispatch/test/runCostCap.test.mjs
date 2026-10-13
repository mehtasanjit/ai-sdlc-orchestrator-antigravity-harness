/**
 * The run-wide `hard_cost_cap_usd` check: the pure sum against
 * dist/runCostCap.js, then the real dist/server.js spawned over stdio
 * (as driverClient.test.mjs does) to prove a refusal lands before any adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRunCostCap, evaluateRunCostCap, runCostCapRefusal } from "../dist/runCostCap.js";
import { connectBridge } from "../dist/driverClient.js";

const line = (ev) => JSON.stringify({ phase: "codegen", task_id: "t", ...ev });

function withTelemetry(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-cost-cap-"));
  const path = join(dir, "telemetry.jsonl");
  try {
    if (lines) writeFileSync(path, lines.join("\n") + "\n");
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("spend under the cap is allowed", () => {
  withTelemetry([line({ cost_usd: 10 }), line({ cost_usd: 15.5 })], (path) => {
    const check = checkRunCostCap(50, path);
    assert.equal(check.allowed, true);
    assert.equal(check.spent_usd, 25.5);
    assert.equal(check.events_counted, 2);
  });
});

test("spend exactly at the cap is refused", () => {
  withTelemetry([line({ cost_usd: 30 }), line({ cost_usd: 20 })], (path) => {
    const check = checkRunCostCap(50, path);
    assert.equal(check.allowed, false);
    assert.equal(check.spent_usd, 50);
  });
});

test("spend over the cap is refused", () => {
  withTelemetry([line({ cost_usd: 49 }), line({ cost_usd: 3.05 })], (path) => {
    assert.equal(checkRunCostCap(50, path).allowed, false);
  });
});

test("orchestrator-tier lines are not dispatched spend and are ignored", () => {
  withTelemetry(
    [line({ cost_usd: 10 }), line({ tier: "orchestrator", phase: "orchestrator_overhead", cost_usd: 400 })],
    (path) => {
      const check = checkRunCostCap(50, path);
      assert.equal(check.allowed, true);
      assert.equal(check.spent_usd, 10);
      assert.equal(check.events_counted, 1);
    },
  );
});

test("a telemetry file that does not exist yet counts as zero spend", () => {
  withTelemetry(null, (path) => {
    const check = checkRunCostCap(50, path);
    assert.equal(check.allowed, true);
    assert.equal(check.spent_usd, 0);
    assert.equal(check.events_counted, 0);
  });
});

test("no cap, or no telemetry file to count from, means no check", () => {
  withTelemetry([line({ cost_usd: 999 })], (path) => {
    assert.equal(checkRunCostCap(undefined, path), null);
    assert.equal(checkRunCostCap(50, undefined), null);
  });
});

test("unreadable lines and lines without a cost are skipped, not fatal", () => {
  const check = evaluateRunCostCap(50, [
    line({ cost_usd: 5 }),
    "{not json",
    line({ phase: "docs" }),
    "",
    line({ cost_usd: Number.NaN }),
  ]);
  assert.equal(check.allowed, true);
  assert.equal(check.spent_usd, 5);
  assert.equal(check.unreadable_lines, 1);
  assert.equal(check.events_counted, 3);
});

test("with a run id, only that run's events count toward its cap", () => {
  withTelemetry(
    [line({ pass: "run-1", cost_usd: 49 }), line({ pass: "run-2", cost_usd: 3 }), line({ pass: null, cost_usd: 0 })],
    (path) => {
      const second = checkRunCostCap(50, path, "run-2");
      assert.equal(second.allowed, true, "run 1's spend does not refuse run 2");
      assert.equal(second.spent_usd, 3);
      assert.equal(second.events_counted, 2, "run 2's event and the run-less zero-cost row");
      assert.equal(checkRunCostCap(50, path).allowed, false, "without a run id the whole file counts");
    },
  );
});

test("the refusal names the spend, the cap and the file, and says no model was called", () => {
  const check = evaluateRunCostCap(50, [line({ cost_usd: 51.25 })]);
  const message = runCostCapRefusal(check, "/runs/r1/telemetry.jsonl");
  assert.match(message, /\$51\.2500/);
  assert.match(message, /hard_cost_cap_usd of \$50\.00/);
  assert.match(message, /\/runs\/r1\/telemetry\.jsonl/);
  assert.match(message, /No model was called/);
});

// --- the real server, spawned over stdio ---

// The only model reads its key from a variable no machine sets, so the
// adapter cannot be built: a dispatch that gets past the cap fails on the
// missing key instead of reaching a vendor. Offline and free either way.
const NO_KEY_ENV = "MMO_COST_CAP_TEST_UNSET_KEY";
const CAPPED_POLICY = `
version: 1
name: cost-cap-test
models:
  - id: unreachable
    adapter: builtin-anthropic
    model_name: claude-opus-5
    auth: { env: ${NO_KEY_ENV} }
rules:
  - default: unreachable
hard_cost_cap_usd: 1
`;

const CAP_PACKET = {
  id: "pkt-cap",
  phase: "codegen",
  task_type: "controller_handler",
  module: "example",
  instruction: "Return {ok:true} as JSON.",
  inputs: [],
  outputSchema: { type: "object" },
  acceptance: ["valid JSON"],
  budget: { maxInputTokens: 8000, maxOutputTokens: 2000 },
  pass_id: "cost-cap",
};

async function dispatchWithSpend(spentUsd, spentBy = undefined) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-cost-cap-server-"));
  const policyPath = join(dir, "policy.yaml");
  const telemetryPath = join(dir, "telemetry.jsonl");
  writeFileSync(policyPath, CAPPED_POLICY);
  writeFileSync(telemetryPath, line({ cost_usd: spentUsd, ...(spentBy ? { pass: spentBy } : {}) }) + "\n");
  delete process.env[NO_KEY_ENV];
  const bridge = await connectBridge({ env: { MMO_LOG_LEVEL: "error" } });
  try {
    const error = await bridge
      .callTool("execute_with_model", { packet: CAP_PACKET, policy_path: policyPath, telemetry_path: telemetryPath })
      .then(() => null, (err) => err);
    return { error, telemetryAfter: readFileSync(telemetryPath, "utf8") };
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("execute_with_model refuses a dispatch once the run's telemetry reaches the cap, before any adapter", async () => {
  const { error, telemetryAfter } = await dispatchWithSpend(1.5);
  assert.ok(error, "the dispatch must be refused");
  assert.match(error.message, /hard_cost_cap_usd of \$1\.00/);
  assert.match(error.message, /No model was called/);
  assert.doesNotMatch(error.message, new RegExp(NO_KEY_ENV), "the adapter was never constructed");
  assert.equal(telemetryAfter.trim().split("\n").length, 1, "a refusal writes no telemetry event");
});

test("under the cap the same dispatch goes on to the adapter", async () => {
  const { error } = await dispatchWithSpend(0.25);
  assert.ok(error, "the unreachable model still fails");
  assert.match(error.message, new RegExp(`${NO_KEY_ENV} not set`), "it failed in the adapter, past the cap check");
});

test("another run's spend in the same telemetry file does not refuse this run's dispatch", async () => {
  const { error } = await dispatchWithSpend(1.5, "an-earlier-run");
  assert.ok(error, "the unreachable model still fails");
  assert.match(error.message, new RegExp(`${NO_KEY_ENV} not set`), "it got past the cap check");
});

// --- server wiring (dist-grep: server.js starts a Server on import) ---

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

test("dispatched events carry the budget fields beside ceiling_used", () => {
  const src = readFileSync(SERVER, "utf8");
  assert.match(src, /ceiling_used: att\.ceiling_used,\s*budget_enforced: att\.budget_enforced,\s*budget_declared: att\.budget_declared,/);
});
