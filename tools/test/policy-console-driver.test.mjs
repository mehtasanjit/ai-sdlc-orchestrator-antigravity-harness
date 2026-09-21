/**
 * A policy saved from the console keeps what plugin/agy/run.mjs needs: the
 * `driver:` block (the conductor pin) and `hard_cost_cap_usd`. The console
 * edits models, routing and thinking; it never edits the pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { buildCustomPolicy, baseFor, summarizePolicy, renderPolicyYaml, SHIPPED_PRESETS, ADAPTER_LABEL } from "../../plugin/policy-console/policy-server.mjs";
import { readPin, driverSlug } from "../../plugin/agy/telemetry/fairnessPin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (name) => parseYaml(readFileSync(join(ROOT, "plugin", "config", "policies", `${name}.yaml`), "utf8"));

function customizedFrom(name) {
  const base = load(name);
  const summary = summarizePolicy(name, base, "");
  return buildCustomPolicy(baseFor(base), {
    name: "my-custom",
    models: summary.models,
    routing: summary.routing,
    thinking: summary.thinking,
    intentOverrides: summary.intentOverrides,
  });
}

test("a policy customized from the study preset keeps the driver block and the cap, and run.mjs can read its pin", () => {
  const custom = customizedFrom("antigravity-flash38-plus-opus5");
  assert.deepEqual(custom.driver, load("antigravity-flash38-plus-opus5").driver);
  assert.equal(custom.hard_cost_cap_usd, 50);
  assert.equal(driverSlug(readPin(custom)), "gemini-3.8-flash-high");
  const yaml = renderPolicyYaml(custom, "antigravity-flash38-plus-opus5");
  const reparsed = parseYaml(yaml);
  assert.equal(reparsed.driver.model_name, "gemini-3.8-flash");
  assert.equal(reparsed.hard_cost_cap_usd, 50);
  assert.ok(Object.keys(reparsed).indexOf("driver") < Object.keys(reparsed).indexOf("models"), "driver: is written above models:, as the shipped file has it");
});

test("a policy customized from a base with no driver block gets none invented", () => {
  const base = load("antigravity-flash38-plus-opus5");
  delete base.driver;
  const summary = summarizePolicy("driverless", base, "");
  const custom = buildCustomPolicy(baseFor(base), { name: "my-custom", models: summary.models, routing: summary.routing, thinking: summary.thinking, intentOverrides: summary.intentOverrides });
  assert.ok(!("driver" in custom));
  assert.throws(() => readPin(custom), /no top-level driver: block/);
});

test("the summary exposes the driver pin and the cap for the page to show", () => {
  const s = summarizePolicy("antigravity-flash38-plus-opus5", load("antigravity-flash38-plus-opus5"), "");
  assert.equal(s.origin, "preset");
  assert.equal(s.driver.model_name, "gemini-3.8-flash");
  assert.equal(s.driver.reasoning.effort, "high");
  assert.equal(s.hardCostCapUsd, 50);
  const driverless = load("antigravity-flash38-plus-opus5"); delete driverless.driver;
  assert.equal(summarizePolicy("driverless", driverless, "").driver, null);
});

test("the antigravity preset is a preset, and the claude-cli label names the two arms", () => {
  assert.deepEqual(SHIPPED_PRESETS, ["antigravity-flash38-plus-opus5"]);
  assert.match(ADAPTER_LABEL["claude-cli"], /arm A.*arm B/);
  assert.ok(!/Max subscription/.test(ADAPTER_LABEL["claude-cli"]));
});

test("the page shows the driver on cards and in the editor", () => {
  const html = readFileSync(join(ROOT, "plugin", "policy-console", "index.html"), "utf8");
  assert.match(html, /badge driver/);
  assert.match(html, /renderDriverStrip\(policy\)/);
  assert.match(html, /carried as-is/);
});
