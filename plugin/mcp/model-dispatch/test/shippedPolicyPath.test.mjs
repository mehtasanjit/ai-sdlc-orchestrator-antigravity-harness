import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const POLICIES = fileURLToPath(new URL("../../../config/policies/", import.meta.url));

test("the shipped presets load from a clone whose path has a space in it", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo clone "));
  try {
    const server = join(root, "plugin", "mcp", "model-dispatch");
    mkdirSync(server, { recursive: true });
    cpSync(join(SERVER_DIR, "dist"), join(server, "dist"), { recursive: true });
    symlinkSync(join(SERVER_DIR, "node_modules"), join(server, "node_modules"), "dir");
    cpSync(POLICIES, join(root, "plugin", "config", "policies"), { recursive: true });

    const policyJs = pathToFileURL(join(server, "dist", "policy.js")).href;
    const env = { ...process.env };
    delete env.MMO_POLICY_DIR;
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const p = await import(${JSON.stringify(policyJs)}); console.log(p.loadPolicy({}).name);`],
      { env, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "antigravity-flash38-plus-opus5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
