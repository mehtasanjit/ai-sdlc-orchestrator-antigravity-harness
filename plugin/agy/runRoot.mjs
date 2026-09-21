/**
 * Per-run customization root — the fallback for p1-agy-runtime.md check 5.
 *
 * If agy does not expand `${VAR}` in a plugin's mcp_config.json, the bridge
 * starts with empty credentials. This builds a throwaway workspace whose
 * `.agents/plugins/mmo/` is the shipped plugin (subdirectories symlinked)
 * with an mcp_config.json whose env values are inlined from the launching
 * shell. It lives outside the repo, is never committed, and is removed
 * after the run unless the caller keeps it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LINKED_PLUGIN_DIRS = ["agy", "config", "examples", "mcp", "policy-console", "rules", "scripts", "skills", "templates"];

export function defaultRunRoot(runId, base = tmpdir()) {
  return join(base, `mmo-agy-run-${String(runId).replace(/[^A-Za-z0-9_.-]/g, "_")}`);
}

/** mcp_config.json with every `${VAR}` replaced by the launching env's value; unset vars are dropped. */
export function inlineMcpConfig(config, env) {
  const out = structuredClone(config);
  for (const server of Object.values(out.mcpServers ?? {})) {
    const inlined = {};
    for (const [key, value] of Object.entries(server.env ?? {})) {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(value));
      const resolved = m ? env[m[1]] : value;
      if (resolved !== undefined && resolved !== "") inlined[key] = String(resolved);
    }
    server.env = inlined;
  }
  return out;
}

export function materialiseRunRoot({ runRoot, pluginRoot, env = process.env }) {
  const pluginDir = join(runRoot, ".agents", "plugins", "mmo");
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(pluginDir, { recursive: true });
  for (const dir of LINKED_PLUGIN_DIRS) {
    const source = join(pluginRoot, dir);
    if (existsSync(source)) symlinkSync(source, join(pluginDir, dir), "dir");
  }
  for (const file of ["plugin.json", "hooks.json"]) {
    const source = join(pluginRoot, file);
    if (existsSync(source)) writeFileSync(join(pluginDir, file), readFileSync(source));
  }
  const config = JSON.parse(readFileSync(join(pluginRoot, "mcp_config.json"), "utf8"));
  writeFileSync(join(pluginDir, "mcp_config.json"), JSON.stringify(inlineMcpConfig(config, env), null, 2) + "\n");
  return { runRoot, pluginDir };
}

export function removeRunRoot(runRoot) {
  rmSync(runRoot, { recursive: true, force: true });
}
