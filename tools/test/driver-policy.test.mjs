/**
 * The antigravity policies' driver block — the one place the conductor pin
 * lives (docs/verification/p1-agy-runtime.md, "Findings that change the
 * plan" 2 and 6). The bridge's own suite checks the models[] cards against
 * the price list; this checks the block the bridge never reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICIES = join(ROOT, "plugin", "config", "policies");
const load = (name) => parseYaml(readFileSync(join(POLICIES, `${name}.yaml`), "utf8"));

const STUDY = "antigravity-flash38-plus-opus5";
const WIRING = "antigravity-flash38-plus-haiku45";

for (const name of [STUDY, WIRING]) {
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

  test(`${name}: judgment phases route to the claude-cli adapter`, () => {
    const policy = load(name);
    const judgment = policy.models.find((m) => m.adapter === "claude-cli");
    assert.ok(judgment, "no claude-cli model");
    for (const phase of ["requirements_analysis", "architecture_design", "plan_task_packets", "senior_code_review", "security_review"]) {
      const rule = policy.rules.find((r) => r.when?.phase === phase);
      assert.equal(rule?.use, judgment.id, phase);
    }
  });
}

test("the study policy runs Opus 5 at high effort; the wiring policy runs Haiku 4.5 with no effort (Haiku rejects it)", () => {
  const opus = load(STUDY).models.find((m) => m.adapter === "claude-cli");
  assert.equal(opus.model_name, "claude-opus-5");
  assert.equal(opus.reasoning?.effort, "high");
  const haiku = load(WIRING).models.find((m) => m.adapter === "claude-cli");
  assert.equal(haiku.model_name, "claude-haiku-4-5");
  assert.equal(haiku.reasoning, undefined);
  assert.ok(load(WIRING).hard_cost_cap_usd <= 5);
});

test("the two policies differ only in name, judgment model, its card and comments, and the cap", () => {
  const strip = (p) => {
    const c = structuredClone(p);
    delete c.name;
    delete c.hard_cost_cap_usd;
    const j = c.models.find((m) => m.adapter === "claude-cli");
    delete j.model_name; delete j.pricing; delete j.reasoning;
    return c;
  };
  assert.deepEqual(strip(load(STUDY)), strip(load(WIRING)));
});
