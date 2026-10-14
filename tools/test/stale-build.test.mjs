/**
 * A pull that changes the bridge's TypeScript leaves dist/ older than src/,
 * and every runner imports dist/: the pulled fixes do not run until a rebuild.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { staleBuild, staleBuildWarning } from "../../plugin/scripts/lib/stale-build.mjs";
import { evaluate } from "../../plugin/agy/verify-setup.mjs";

function bridge(files) {
  const dir = mkdtempSync(join(tmpdir(), "stale-build-"));
  for (const [rel, when] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    utimesSync(path, when, when);
  }
  return dir;
}

const OLD = new Date("2026-10-01T00:00:00Z");
const NEW = new Date("2026-10-13T00:00:00Z");

test("a source newer than its compiled file is stale and named", () => {
  const dir = bridge({ "src/a.ts": NEW, "dist/a.js": OLD, "src/adapters/b.ts": OLD, "dist/adapters/b.js": NEW });
  try {
    const check = staleBuild(dir);
    assert.equal(check.stale, true);
    assert.deepEqual(check.files, ["a.ts"]);
    assert.match(staleBuildWarning(check), /older than its source \(a\.ts\).*npm run build/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a source with no compiled file is stale; a fresh build is not", () => {
  const dir = bridge({ "src/a.ts": OLD, "dist/a.js": NEW, "src/new.ts": OLD });
  try {
    assert.deepEqual(staleBuild(dir).files, ["new.ts"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const fresh = bridge({ "src/a.ts": OLD, "dist/a.js": NEW, "src/types.d.ts": NEW });
  try {
    assert.deepEqual(staleBuild(fresh), { stale: false, missing: false, files: [] });
    assert.equal(staleBuildWarning(staleBuild(fresh)), null);
  } finally { rmSync(fresh, { recursive: true, force: true }); }
});

test("no dist/ at all is stale and missing", () => {
  const dir = bridge({ "src/a.ts": OLD });
  try {
    assert.equal(staleBuild(dir).missing, true);
    assert.match(staleBuildWarning(staleBuild(dir)), /is not built/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify-setup warns on a stale build without blocking", () => {
  const base = { nodeMajor: 22, hasNodeModules: true, hasDist: true };
  const stale = evaluate({ ...base, staleBuild: { stale: true, missing: false, files: ["server.ts"] } });
  const p = stale.problems.find((x) => x.id === "mcp-build-stale");
  assert.ok(p, "a stale build is reported");
  assert.equal(p.severity, "warning");
  assert.ok(!evaluate({ ...base, staleBuild: { stale: false, files: [] } }).problems.some((x) => x.id === "mcp-build-stale"));
});
