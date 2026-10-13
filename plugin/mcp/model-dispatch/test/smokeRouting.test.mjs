/**
 * The brownfield pre-check's dispatch smoke goes to the mechanical tier on the
 * shipped policy. Without its own rule, `task_type: smoke` fell through to the
 * policy's default and paid Opus for the literal string "OK".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicyFromPath } from "../dist/policy.js";
import { pickModel } from "../dist/routing.js";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "antigravity-flash38-plus-opus5.yaml");

test("the pre-check smoke packet routes to Gemini Flash, not Opus", () => {
  const policy = loadPolicyFromPath(SHIPPED);
  for (const phase of ["pre_check", "codegen"]) {
    const d = pickModel({ phase, task_type: "smoke", module: "smoke", retry_count: 0 }, policy, {});
    assert.notEqual(d.modelId, "opus", `phase ${phase}`);
    assert.equal(policy.models.find((m) => m.id === d.modelId)?.model_name, "gemini-3.8-flash");
  }
});
