/**
 * The agy plugin surface: manifest, bridge registration and repo-level
 * discovery. Shapes come from the CLI's bundled docs (plugins.md,
 * mcp_servers.md, json_configs.md); docs/verification/p1-agy-runtime.md
 * checks 10 and 12 record why they look like this.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, lstatSync, readlinkSync } from "node:fs";
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

test(".agents/plugins/mmo/ is the discovery mount: every entry a relative symlink into plugin/ (check 10)", () => {
  const mount = join(ROOT, ".agents", "plugins", "mmo");
  assert.ok(!existsSync(join(ROOT, ".agents", "plugins.json")), "the declared route did not resolve on agy 1.2.5 and is not used");
  for (const name of ["plugin.json", "mcp_config.json", "hooks.json", "skills", "rules", "mcp", "agy", "config", "scripts"]) {
    const at = join(mount, name);
    assert.ok(lstatSync(at).isSymbolicLink(), `${name} is a symlink`);
    assert.equal(readlinkSync(at), join("..", "..", "..", "plugin", name));
    assert.ok(existsSync(at), `${name} resolves`);
  }
  assert.equal(readJson(".agents/plugins/mmo/plugin.json").name, "mmo");
});

test("the conductor rules ship inside the plugin", () => {
  const rules = readFileSync(join(ROOT, "plugin", "rules", "AGENTS.md"), "utf8");
  assert.match(rules, /author no shipped content/);
  assert.match(rules, /execute_with_model/);
});

test("hooks.json uses agy's format: named hooks, regex matchers on step types, commands relative to the plugin dir", () => {
  const hooks = readJson("plugin/hooks.json");
  assert.ok(!("hooks" in hooks), "the Claude Code {hooks:{...}} envelope is not agy's format (check 11)");
  const guard = hooks["mmo-write-contract"];
  assert.ok(guard?.PreToolUse?.[0]?.matcher, "PreToolUse is grouped: matcher + hooks");
  assert.match(guard.PreToolUse[0].matcher, /run_command/);
  for (const group of [...guard.PreToolUse, ...hooks["mmo-telemetry-heartbeat"].PostToolUse]) {
    for (const h of group.hooks) {
      assert.equal(h.type, "command");
      assert.ok(!h.command.includes("${CLAUDE_PLUGIN_ROOT}"), "no Claude Code variable");
      const script = h.command.replace(/^node\s+/, "");
      assert.ok(existsSync(join(ROOT, "plugin", script)), `${script} resolves from the plugin dir (hook cwd)`);
    }
  }
  assert.equal(hooks["mmo-telemetry-heartbeat"].PostToolUse[0].matcher, "mcp_tool");
});
