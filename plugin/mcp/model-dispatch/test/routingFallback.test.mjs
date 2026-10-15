/**
 * Routing on the shipped policy: the task types the skills tell the planner
 * to use reach the mechanical tier, failing codegen and tests packets
 * escalate by rule, and a packet no rule matches is stamped `fallback` and
 * logged at WARN instead of silently paying the premium default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicyFromPath } from "../dist/policy.js";
import { pickModel } from "../dist/routing.js";
import { connectBridge } from "../dist/driverClient.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = join(HERE, "..", "..", "..", "config", "policies", "antigravity-flash38-plus-opus5.yaml");
const policy = loadPolicyFromPath(SHIPPED);
const route = (phase, task_type, retry_count = 0) => pickModel({ phase, task_type, module: "m", retry_count }, policy, {});
const modelName = (d) => policy.models.find((m) => m.id === d.modelId)?.model_name;

const SKILL_CODEGEN_TYPES = [
  "prisma_schema", "env_docs", "env_test_fixture", "test_unit", "test_integration", "docstring", "readme_section",
  "new_file_add", "existing_file_edit", "patch_apply", "bug_reproduce", "bug_fix_apply", "refactor_extract",
  "dependency_add", "test_add", "test_backfill", "doc_addition", "doc_update",
];

test("every mechanical codegen task type the skills name routes to Gemini Flash by an explicit rule", () => {
  for (const type of SKILL_CODEGEN_TYPES) {
    const d = route("codegen", type);
    assert.equal(modelName(d), "gemini-3.8-flash", type);
    assert.notEqual(d.ruleIndex, -1, type);
    assert.equal(d.fallback, undefined, type);
  }
});

test("bug_diagnose is judgment in any phase, by its own rule", () => {
  for (const phase of ["codegen", "debug", "tests"]) {
    const d = route(phase, "bug_diagnose");
    assert.equal(d.modelId, "opus", phase);
    assert.notEqual(d.ruleIndex, -1, phase);
    assert.equal(d.fallback, undefined, phase);
  }
});

test("codegen and tests packets escalate to Opus at retry_count 2, by rule", () => {
  for (const [phase, type] of [["codegen", "new_file_add"], ["codegen", "controller_handler"], ["tests", "test_add"], ["debug", "test_fix"]]) {
    assert.equal(modelName(route(phase, type, 1)), "gemini-3.8-flash", `${phase}/${type} at retry 1`);
    const d = route(phase, type, 2);
    assert.equal(d.modelId, "opus", `${phase}/${type} at retry 2`);
    assert.notEqual(d.ruleIndex, -1);
    assert.match(d.reason, /Escalation/);
  }
});

test("a codegen task type the skills do not name falls to the default, stamped fallback", () => {
  for (const type of ["dom_component", "code_fix", "codegen_refinement", "contract_reconciliation"]) {
    const d = route("codegen", type);
    assert.equal(d.modelId, "opus", type);
    assert.equal(d.ruleIndex, -1, type);
    assert.equal(d.fallback, true, type);
  }
});

test("a matched rule carries no fallback key", () => {
  assert.equal("fallback" in route("requirements_analysis", "requirements"), false);
});

// --- the real server, spawned over stdio ---

const NO_KEY_ENV = "MMO_FALLBACK_TEST_UNSET_KEY";
const FALLBACK_POLICY = `
version: 1
name: fallback-test
models:
  - id: unreachable
    adapter: builtin-anthropic
    model_name: claude-opus-5
    auth: { env: ${NO_KEY_ENV} }
rules:
  - when: { phase: docs }
    use: unreachable
  - default: unreachable
    reason: "Unrecognized task — fail safe to premium"
`;

test("execute_with_model logs route.fallback at WARN when no rule matched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-fallback-"));
  const policyPath = join(dir, "policy.yaml");
  const telemetryPath = join(dir, "telemetry.jsonl");
  writeFileSync(policyPath, FALLBACK_POLICY);
  delete process.env[NO_KEY_ENV];
  const bridge = await connectBridge({ env: { MMO_LOG_LEVEL: "info" } });
  try {
    const packet = {
      id: "pkt-fallback", phase: "codegen", task_type: "dom_component", module: "example",
      instruction: "Return {ok:true} as JSON.", inputs: [], outputSchema: { type: "object" },
      acceptance: ["valid JSON"], budget: { maxInputTokens: 8000, maxOutputTokens: 2000 }, pass_id: "fallback",
    };
    const error = await bridge.callTool("execute_with_model", { packet, policy_path: policyPath, telemetry_path: telemetryPath }).then(() => null, (err) => err);
    assert.match(String(error?.message), new RegExp(`${NO_KEY_ENV} not set`), "the dispatch got past routing and failed in the adapter");
    const log = readFileSync(join(dir, "orchestrator.log"), "utf8");
    assert.match(log, /WARN\s+route\.fallback .*packet_id=pkt-fallback/);
    assert.match(log, /route\.fallback .*task_type=dom_component/);
    assert.match(log, /route\.decide .*fallback=true/);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the dispatched event's routing block carries fallback only when the decision did", () => {
  const src = readFileSync(join(HERE, "..", "dist", "server.js"), "utf8");
  assert.match(src, /rule_reason: decision\.reason,\s*\.\.\.\(decision\.fallback \? \{ fallback: true \} : \{\}\),/);
});
