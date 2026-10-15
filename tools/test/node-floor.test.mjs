/**
 * The plugin's own floor, both package.json engines and CI's node-version must
 * say the same, and every locked package's engines.node must admit it, or setup
 * passes a machine the bridge then fails on.
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

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether an npm engines range admits a version, by npm's semver rules. A
 * comparator it cannot read, such as a prerelease, admits nothing, so the
 * lockfile check lists that package for a look instead of passing it.
 */
function admits(range, version) {
  const v = String(version).replace(/^v/, "").split(".").map(Number);
  return String(range).split("||").some((alternative) => {
    const comparators = alternative.trim().replace(/^(\S+)\s+-\s+(\S+)$/, ">=$1 <=$2").replace(/([<>=^~])\s+/g, "$1").split(/\s+/).filter(Boolean);
    return comparators.every((comparator) => {
      const m = /^(<=|>=|<|>|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(comparator);
      if (!m) return false;
      const op = m[1] ?? "";
      const parts = [];
      for (const p of [m[2], m[3], m[4]]) {
        if (!/^\d+$/.test(p ?? "")) break;
        parts.push(Number(p));
      }
      const n = parts.length;
      if (n === 0) return ["", "=", ">=", "^", "~"].includes(op);
      const low = [...parts, 0, 0].slice(0, 3);
      const next = (i) => [...parts.slice(0, i), parts[i] + 1, 0, 0].slice(0, 3);
      const caret = parts.findIndex((p) => p !== 0);
      switch (op) {
        case ">=": return cmp(v, low) >= 0;
        case ">": return n === 3 ? cmp(v, low) > 0 : cmp(v, next(n - 1)) >= 0;
        case "<": return cmp(v, low) < 0;
        case "<=": return n === 3 ? cmp(v, low) <= 0 : cmp(v, next(n - 1)) < 0;
        case "~": return cmp(v, low) >= 0 && cmp(v, next(n === 1 ? 0 : 1)) < 0;
        case "^": return cmp(v, low) >= 0 && cmp(v, next(caret === -1 ? n - 1 : Math.min(caret, n - 1))) < 0;
        default: return n === 3 ? cmp(v, low) === 0 : cmp(v, low) >= 0 && cmp(v, next(n - 1)) < 0;
      }
    });
  });
}

test("meetsNodeFloor compares major, minor and patch", () => {
  assert.equal(meetsNodeFloor("22.19.0"), true);
  assert.equal(meetsNodeFloor("v24.1.0"), true);
  assert.equal(meetsNodeFloor("22.18.9"), false);
  assert.equal(meetsNodeFloor("20.19.0"), false);
});

test("admits reads the engines shapes the lockfiles use", () => {
  for (const range of [">=22.19.0", ">= 14.6", ">=20", "^12.20.0 || ^14.13.1 || >=16.0.0", "^12.20 || >= 14.13", "*", ">= 0.8"]) {
    assert.equal(admits(range, "22.19.0"), true, range);
  }
});

test("admits turns away a range that leaves the floor out, even when part of it starts lower", () => {
  for (const range of ["^20.19.0 || >=24", ">22.19.0", ">22.19", ">=22.20", "~22.18.0", ">=18 <22.19.0", "<=22.18", "20 - 22.18", "22.19.0-rc.1"]) {
    assert.equal(admits(range, "22.19.0"), false, range);
  }
  for (const range of ["^22.19.0", "~22.19", ">22.18", ">22.18.9", "<=22.19", "20 - 22", ">=18 <23", "22.x", "22", "=22.19.0", "^0.0.0 || 22.19.0"]) {
    assert.equal(admits(range, "22.19.0"), true, range);
  }
  assert.equal(admits("^0.2.3", "0.3.0"), false);
  assert.equal(admits("^0.0.3", "0.0.4"), false);
  assert.equal(admits("^0.0", "0.0.9"), true);
});

test("every locked package's engines.node admits the floor, and engines and CI say the floor too", () => {
  const refused = [];
  for (const lock of LOCKFILES) {
    for (const [path, entry] of Object.entries(json(lock).packages ?? {})) {
      const range = entry.engines?.node;
      if (range && !admits(range, MIN_NODE)) refused.push(`${lock}: ${path || "(root)"} engines.node ${range} does not admit ${MIN_NODE}`);
    }
  }
  assert.deepEqual(refused, []);
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
