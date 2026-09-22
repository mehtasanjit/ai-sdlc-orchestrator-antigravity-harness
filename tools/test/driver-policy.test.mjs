/**
 * The antigravity policy's driver block — the one place the conductor pin
 * lives (docs/verification/p1-agy-runtime.md, "Findings that change the
 * plan" 2 and 6). The bridge's own suite checks the models[] cards against
 * the price list; this checks the block the bridge never reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICIES = join(ROOT, "plugin", "config", "policies");
const load = (name) => parseYaml(readFileSync(join(POLICIES, `${name}.yaml`), "utf8"));

const STUDY = "antigravity-flash38-plus-opus5";

for (const name of [STUDY]) {
  test(`${name}: driver block pins runtime, model, effort, card and billing mode`, () => {
    const policy = load(name);
    assert.equal(policy.name, name);
    const d = policy.driver;
    assert.ok(d, "driver block missing");
    assert.equal(d.runtime, "agy");
    assert.equal(d.model_name, "gemini-3.8-flash");
    assert.equal(d.reasoning?.effort, "high");
    assert.ok(["seat", "gemini-api-key"].includes(d.billing_mode), "billing_mode");
    for (const k of ["input", "input_cached", "output"]) assert.equal(typeof d.pricing?.[k], "number", `pricing.${k}`);
  });

  test(`${name}: the driver is not a models[] entry, so preflight never builds an adapter for it`, () => {
    const policy = load(name);
    assert.ok(!policy.models.some((m) => m.adapter === "agy" || m.id === "driver" || m.id === "gemini-driver"));
  });

  test(`${name}: the driver card equals the mechanical tier's card for the same model`, () => {
    const policy = load(name);
    const flash = policy.models.find((m) => m.id === "flash-completion");
    assert.equal(flash.model_name, policy.driver.model_name);
    assert.deepEqual(policy.driver.pricing, flash.pricing);
    assert.equal(policy.driver.pricing_last_verified, flash.pricing_last_verified);
  });

  test(`${name}: judgment phases route to the claude-agent-sdk adapter`, () => {
    const policy = load(name);
    const judgment = policy.models.find((m) => m.adapter === "claude-agent-sdk");
    assert.ok(judgment, "no claude-agent-sdk model");
    for (const phase of ["requirements_analysis", "architecture_design", "plan_task_packets", "senior_code_review", "security_review"]) {
      const rule = policy.rules.find((r) => r.when?.phase === phase);
      assert.equal(rule?.use, judgment.id, phase);
    }
  });
}

test("the study policy runs Opus 5 at high effort and caps the run at $50", () => {
  const opus = load(STUDY).models.find((m) => m.adapter === "claude-agent-sdk");
  assert.equal(opus.model_name, "claude-opus-5");
  assert.equal(opus.reasoning?.effort, "high");
  assert.equal(load(STUDY).hard_cost_cap_usd, 50);
});

test("the study policy is the only one shipped", () => {
  const shipped = readdirSync(POLICIES).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
  assert.deepEqual(shipped, [STUDY]);
});
