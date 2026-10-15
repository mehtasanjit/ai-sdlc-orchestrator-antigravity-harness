/**
 * Advisories already cleared from the lockfiles, by the range each one names.
 * npm audit needs the network; this keeps a lockfile merged in from an older
 * branch from bringing one back while npm test stays offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCKFILES = ["package-lock.json", "plugin/mcp/model-dispatch/package-lock.json", "plugin/policy-console/package-lock.json"];

const ADVISORIES = [
  { name: "@hono/node-server", fixed: "1.19.15" },
  { name: "@modelcontextprotocol/sdk", from: "1.12.0", fixed: "1.31.0" },
  { name: "body-parser", from: "2.0.0", fixed: "2.3.0" },
  { name: "fast-uri", from: "3.0.0", fixed: "3.1.8" },
  { name: "hono", fixed: "4.13.7" },
  { name: "ip-address", fixed: "10.7.1" },
  { name: "protobufjs", from: "7.5.0", fixed: "7.6.5" },
  { name: "proxy-addr", from: "1.1.0", fixed: "2.0.8" },
  { name: "qs", from: "2.2.5", fixed: "6.16.0" },
  { name: "undici", from: "8.0.0", fixed: "8.10.2" },
];

const parse = (version) => String(version).split("-")[0].split(".").map((n) => Number(n) || 0);

function below(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

const affected = (name, version) =>
  ADVISORIES.filter((a) => a.name === name && !below(version, a.from ?? "0.0.0") && below(version, a.fixed));

test("the range check flags the versions develop locked before the cleanup, and only those", () => {
  for (const [name, version] of [["@modelcontextprotocol/sdk", "1.30.0"], ["proxy-addr", "2.0.7"], ["hono", "4.12.22"], ["@hono/node-server", "1.19.14"], ["fast-uri", "3.1.2"], ["ip-address", "10.2.0"], ["undici", "8.5.0"], ["qs", "6.15.2"]]) {
    assert.equal(affected(name, version).length, 1, `${name} ${version}`);
  }
  for (const [name, version] of [["@modelcontextprotocol/sdk", "1.31.0"], ["@hono/node-server", "2.1.5"], ["body-parser", "1.20.3"], ["undici", "7.16.0"], ["ip-address", "10.7.1"]]) {
    assert.deepEqual(affected(name, version), [], `${name} ${version}`);
  }
});

test("no lockfile locks a version a cleared advisory names", () => {
  const problems = [];
  for (const lock of LOCKFILES) {
    const packages = JSON.parse(readFileSync(join(ROOT, lock), "utf8")).packages ?? {};
    for (const [path, entry] of Object.entries(packages)) {
      if (!path || !entry.version) continue;
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      for (const a of affected(name, entry.version)) problems.push(`${lock}: ${path} ${entry.version} (fixed in ${a.fixed})`);
    }
  }
  assert.deepEqual(problems, []);
});
