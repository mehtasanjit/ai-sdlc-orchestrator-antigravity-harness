#!/usr/bin/env node
/**
 * The command that starts an interactive run: `agy --model <slug>`, with the
 * slug derived from the project's policy the way run.mjs derives its --model.
 * A chat started with plain `agy` conducts on agy's default model, while
 * collect-driver-usage.mjs prices the conductor at the pin and checks the
 * models agy recorded against it.
 *
 * Usage:
 *   node plugin/agy/start-command.mjs [--project-root=<path>]
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePolicy } from "./projectPolicy.mjs";
import { driverSlug, readPin } from "./telemetry/fairnessPin.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function chatStartCommand(pin) {
  return `agy --model ${driverSlug(pin)}`;
}

export function whyThePin(slug) {
  return `Without --model the chat runs on agy's default model, while the run prices the conductor at the pin's rates and checks it against ${slug}, so the model check fails.`;
}

// The clone's root `npm ci` may not have run yet when setup prints this; the
// bridge's install, which setup needs before it passes, carries yaml too.
export function yamlParser(pluginRoot = PLUGIN_ROOT, installs = [import.meta.url, join(pluginRoot, "mcp", "model-dispatch", "package.json")]) {
  for (const from of installs) {
    try { return createRequire(from)("yaml").parse; } catch { /* the next install */ }
  }
  throw new Error(`the policy cannot be read until the bridge is installed: npm run build in ${dirname(pluginRoot)}`);
}

/** `{ command, slug, policy, source }`, or `{ command: null, error }` when the project's policy yields no driver pin. */
export function projectStartCommand({ projectRoot = process.cwd(), pluginRoot = PLUGIN_ROOT, parse = null } = {}) {
  try {
    const resolved = resolvePolicy({ projectRoot, pluginRoot, parse: parse ?? yamlParser(pluginRoot) });
    const pin = readPin(resolved.policy);
    return { command: chatStartCommand(pin), slug: driverSlug(pin), policy: resolved.name, source: resolved.source };
  } catch (err) {
    return { command: null, error: err?.message ?? String(err) };
  }
}

function projectRootArg(argv) {
  const eq = argv.find((a) => a.startsWith("--project-root="));
  if (eq) return eq.slice("--project-root=".length);
  const at = argv.indexOf("--project-root");
  return at >= 0 && argv[at + 1] ? argv[at + 1] : process.cwd();
}

if (isMain(import.meta.url)) {
  const start = projectStartCommand({ projectRoot: resolve(projectRootArg(process.argv.slice(2))) });
  if (!start.command) {
    console.error(`start-command: ${start.error}`);
    process.exit(1);
  }
  console.log(start.command);
}
