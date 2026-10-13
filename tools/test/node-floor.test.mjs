/**
 * The bridge's undici 8.5 requires Node >=22.19.0. The plugin's own floor,
 * both package.json engines and CI's node-version must say the same, or
 * setup passes a machine the bridge then fails on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MIN_NODE, meetsNodeFloor } from "../../plugin/scripts/lib/node-floor.mjs";
import { evaluate } from "../../plugin/agy/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

test("meetsNodeFloor compares major, minor and patch", () => {
  assert.equal(meetsNodeFloor("22.19.0"), true);
  assert.equal(meetsNodeFloor("v24.1.0"), true);
  assert.equal(meetsNodeFloor("22.18.9"), false);
  assert.equal(meetsNodeFloor("20.19.0"), false);
});

test("the floor is the dependencies' own, and engines and CI say it too", () => {
  const undici = join(ROOT, "plugin", "mcp", "model-dispatch", "node_modules", "undici", "package.json");
  if (existsSync(undici)) assert.equal(JSON.parse(readFileSync(undici, "utf8")).engines.node, `>=${MIN_NODE}`);
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
