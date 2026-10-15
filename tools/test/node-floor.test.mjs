/**
 * The plugin's own floor, both package.json engines and CI's node-version must
 * say the same, and no locked package may need a newer Node, or setup passes a
 * machine the bridge then fails on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_NODE, meetsNodeFloor } from "../../plugin/scripts/lib/node-floor.mjs";
import { evaluate } from "../../plugin/agy/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const LOCKFILES = ["package-lock.json", "plugin/mcp/model-dispatch/package-lock.json", "plugin/policy-console/package-lock.json"];

/** The lowest version an engines range admits: ">=20" → "20.0.0", "^12.20 || >=14" → "12.20.0", "*" → "0.0.0". */
function rangeFloor(range) {
  const floors = String(range).split("||").map((alternative) => {
    const m = /^\s*[>=^~v\s]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(alternative);
    return m ? [m[1], m[2], m[3]].map((n) => n ?? "0").join(".") : "0.0.0";
  });
  return floors.reduce((low, floor) => (meetsNodeFloor(low, floor) ? floor : low));
}

test("meetsNodeFloor compares major, minor and patch", () => {
  assert.equal(meetsNodeFloor("22.19.0"), true);
  assert.equal(meetsNodeFloor("v24.1.0"), true);
  assert.equal(meetsNodeFloor("22.18.9"), false);
  assert.equal(meetsNodeFloor("20.19.0"), false);
});

test("rangeFloor reads the engines shapes the lockfiles use", () => {
  assert.equal(rangeFloor(">=22.19.0"), "22.19.0");
  assert.equal(rangeFloor(">= 14.6"), "14.6.0");
  assert.equal(rangeFloor(">=20"), "20.0.0");
  assert.equal(rangeFloor("^12.20.0 || ^14.13.1 || >=16.0.0"), "12.20.0");
  assert.equal(rangeFloor("*"), "0.0.0");
});

test("no locked package needs a newer Node than the floor, and engines and CI say the floor too", () => {
  const above = [];
  for (const lock of LOCKFILES) {
    for (const [path, entry] of Object.entries(json(lock).packages ?? {})) {
      const range = entry.engines?.node;
      if (range && !meetsNodeFloor(MIN_NODE, rangeFloor(range))) above.push(`${lock}: ${path || "(root)"} needs node ${range}`);
    }
  }
  assert.deepEqual(above, []);
  assert.equal(json("package.json").engines.node, `>=${MIN_NODE}`);
  assert.equal(json("plugin/mcp/model-dispatch/package.json").engines.node, `>=${MIN_NODE}`);
  const ci = readFileSync(join(ROOT, ".github", "workflows", "test.yml"), "utf8");
  const pinned = /node-version: '([\d.]+)'/.exec(ci)?.[1];
  assert.ok(pinned && meetsNodeFloor(`${pinned}.0`.split(".").slice(0, 3).join(".")), `CI runs Node ${pinned}`);
});

test("verify-setup blocks a Node below the floor", () => {
  const problems = evaluate({ nodeMajor: 22, nodeVersion: "22.11.0", hasNodeModules: true, hasDist: true }).problems;
  assert.ok(problems.some((p) => p.id === "node-version" && p.severity === "blocking"));
  assert.ok(!evaluate({ nodeMajor: 22, nodeVersion: "22.19.0", hasNodeModules: true, hasDist: true }).problems.some((p) => p.id === "node-version"));
});
