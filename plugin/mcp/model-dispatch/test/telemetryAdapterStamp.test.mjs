/**
 * Every dispatched telemetry event names the adapter that ran it, so
 * plugin/agy/manifest.mjs can book the event to the Claude or Gemini cost
 * line without a policy snapshot in the run directory.
 *
 * Checks the compiled source, as provenanceStamp.test.mjs does: importing
 * server.js starts a Server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

test("the adapter stamp comes from the routed model's policy entry", () => {
  const src = readFileSync(SERVER, "utf8");
  assert.match(src, /const \{ model_name: modelName, adapter: adapterId \} = getModel\(policy, decision\.modelId\);/);
});

test("the adapter stamp sits inside the dispatched-event construction", () => {
  const src = readFileSync(SERVER, "utf8");
  const routedIdx = src.indexOf('routed_by: "orchestrator"');
  const stampIdx = src.indexOf("adapter: adapterId,");
  assert.notEqual(routedIdx, -1, "baseEvent's routed_by literal must be findable");
  assert.notEqual(stampIdx, -1, "adapter stamp must be findable");
  assert.ok(stampIdx > routedIdx && stampIdx - routedIdx < 1500, "adapter stamp must sit in the same event object as routed_by");
});
