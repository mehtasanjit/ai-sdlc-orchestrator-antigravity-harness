/**
 * The agy plugin surface: manifest, bridge registration and repo-level
 * discovery. Shapes come from the CLI's bundled docs (plugins.md,
 * mcp_servers.md, json_configs.md); docs/verification/p1-agy-runtime.md
 * checks 10 and 12 record why they look like this.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

test("plugin.json names the plugin mmo so /mmo references keep resolving", () => {
  const manifest = readJson("plugin/plugin.json");
  assert.equal(manifest.name, "mmo");
  assert.match(manifest.name, /^[A-Za-z0-9_-]+$/);
  assert.equal(typeof manifest.description, "string");
});

test("mcp_config.json registers model-dispatch relative to the plugin directory", () => {
  const config = readJson("plugin/mcp_config.json");
  const server = config.mcpServers?.["model-dispatch"];
  assert.ok(server, "mcpServers.model-dispatch missing");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["mcp/model-dispatch/dist/server.js"]);
  assert.ok(!("cwd" in server), "cwd is resolved to the plugin directory by agy (check 12); do not pin one");
  assert.ok(existsSync(join(ROOT, "plugin", "mcp", "model-dispatch", "src", "server.ts")));
});

test("mcp_config.json carries no secret: every env value is a ${VAR} reference to a same-named variable", () => {
  const { env } = readJson("plugin/mcp_config.json").mcpServers["model-dispatch"];
  for (const [key, value] of Object.entries(env)) {
    assert.equal(value, `\${${key}}`, `${key} must be passed through, not inlined`);
  }
  for (const key of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"]) {
    assert.ok(key in env, `${key} is one of the two Claude arms' variables and must reach the bridge`);
  }
});

test(".agents/plugins.json registers ./plugin and nothing else", () => {
  const reg = readJson(".agents/plugins.json");
  assert.deepEqual(reg, { entries: [{ path: ".", include_only: ["^plugin$"] }] });
});

test("the conductor rules ship inside the plugin", () => {
  const rules = readFileSync(join(ROOT, "plugin", "rules", "AGENTS.md"), "utf8");
  assert.match(rules, /author no shipped content/);
  assert.match(rules, /execute_with_model/);
});
