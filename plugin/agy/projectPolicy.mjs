/**
 * Which policy file a project runs, resolved the way the bridge resolves it.
 *
 * Takes the YAML parser as an argument instead of importing one: tools/setup.mjs
 * prints the chat start command from this before the clone's root `npm ci` has
 * run, when only the bridge's own install carries `yaml`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_POLICY = "antigravity-flash38-plus-opus5";

export function policyPath(policyName, pluginRoot) {
  return join(pluginRoot, "config", "policies", `${policyName}.yaml`);
}

export function loadPolicyFile(policyName, pluginRoot, parse) {
  const path = policyPath(policyName, pluginRoot);
  if (!existsSync(path)) throw new Error(`run: policy '${policyName}' not found at ${path}.`);
  return parse(readFileSync(path, "utf-8"));
}

/**
 * The policy a run uses, so the launcher's pin, rates and cap come from the
 * file the bridge routes by:
 *   1. <project-root>/routing-policy.yaml — the bridge always takes it when present
 *   2. --policy=<name>
 *   3. <project-root>/.sdlc/project.json default_policy (setup's console choice)
 *   4. the shipped default
 * Returns `{ name, path, source, policy, ignoredFlag }`.
 */
export function resolvePolicy({ projectRoot, flag = null, pluginRoot, parse, read = readFileSync, exists = existsSync }) {
  const override = join(projectRoot, "routing-policy.yaml");
  if (exists(override)) {
    const policy = parse(read(override, "utf-8"));
    if (!policy?.name) throw new Error(`run: ${override} has no name: field.`);
    return { name: policy.name, path: override, source: "routing-policy.yaml", policy, ignoredFlag: flag && flag !== policy.name ? flag : null };
  }
  const load = (name) => loadPolicyFile(name, pluginRoot, parse);
  if (flag) return { name: flag, path: policyPath(flag, pluginRoot), source: "--policy", policy: load(flag), ignoredFlag: null };
  const projectFile = join(projectRoot, ".sdlc", "project.json");
  if (exists(projectFile)) {
    let project = null;
    try { project = JSON.parse(read(projectFile, "utf-8")); } catch { throw new Error(`run: ${projectFile} is not valid JSON.`); }
    const name = typeof project?.default_policy === "string" ? project.default_policy.replace(/\.ya?ml$/, "") : null;
    if (name) return { name, path: policyPath(name, pluginRoot), source: ".sdlc/project.json", policy: load(name), ignoredFlag: null };
  }
  return { name: DEFAULT_POLICY, path: policyPath(DEFAULT_POLICY, pluginRoot), source: "default", policy: load(DEFAULT_POLICY), ignoredFlag: null };
}
