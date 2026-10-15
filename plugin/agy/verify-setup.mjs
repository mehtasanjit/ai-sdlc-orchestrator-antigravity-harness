#!/usr/bin/env node
/**
 * Offline check + repair for the antigravity harness install. Proves the
 * bundled MCP server is built, the plugin is discoverable from the repo, the
 * driver (`agy`) and the Opus worker (`claude`) are present, and the
 * credentials for the policy that would run are in the launching shell.
 *
 * Everything here is offline and free. agy's sign-in state is not probed:
 * every agy command that needs it starts a browser sign-in, which a check
 * script must not do. Confirm it yourself with `agy models`.
 *
 * Usage:
 *   node verify-setup.mjs                  check + report; exit 1 if unusable
 *   node verify-setup.mjs --fix            check, repair, re-check
 *   node verify-setup.mjs --enable-agent   route mechanical tier to the agent
 *                                          and build what it needs (implies --fix)
 *   node verify-setup.mjs --disable-agent  back to the model path
 *   node verify-setup.mjs --brownfield-check [--headless]
 *   ...--project-root=<path>               override process.cwd()
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readMmoSelectFile, writeMmoSelectFile } from "./mmoSelect.mjs";
import { runChecks as runEnvChecks, renderText as renderEnvChecks } from "./env-checks.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { staleBuild } from "../scripts/lib/stale-build.mjs";
import { MIN_NODE, meetsNodeFloor } from "../scripts/lib/node-floor.mjs";

// ─── pure helpers ─────────────────────────────────────────────────────

/** Major version from a `process.versions.node` string ("20.11.1" → 20). */
export function nodeMajorFrom(versionString) {
  const major = parseInt(String(versionString).split(".")[0], 10);
  return Number.isNaN(major) ? 0 : major;
}

/**
 * Path gcloud writes ADC to. Duplicated with `defaultAdcPath` in
 * geminiTransports.ts (this script runs before `npm ci` and cannot import TS).
 * Sync by hand.
 */
export function adcPath(home = homedir()) {
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

/**
 * mcp_config.json's declared env pass-throughs. Sync by hand with
 * plugin/mcp_config.json (plugin-manifest.test.mjs checks the file).
 */
export const DECLARED_ENV = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_BACKEND",
  "MMO_SELECT",
  "SDLC_SELECT",
  "GEMINI_WORKER_PYTHON",
  "MMO_LOG_LEVEL",
  "MMO_VERBOSE",
  "MMO_LOG_PREFIX",
];

/** `${NAME}` and nothing else. Anchored so a real value with `$` survives. */
export function isUnexpandedPlaceholder(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(value ?? "").trim());
}

/** Copy of `env` with unusable values dropped. Non-mutating — this script only reports. */
export function usableEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed === "" || isUnexpandedPlaceholder(trimmed)) continue;
    out[key] = value;
  }
  return out;
}

/** Declared variables that reached us as unexpanded placeholders, in declaration order. */
export function unexpandedDeclaredEnv(env = {}) {
  return DECLARED_ENV.filter((name) => isUnexpandedPlaceholder(env[name]));
}

/** Where a variable must be set for the bridge to see it. */
export const ENV_ADVICE =
  "the shell that launches agy (plugin/mcp_config.json passes it through as ${VAR}; run.mjs --inline-env " +
  "writes it into a per-run config if agy does not expand ${VAR} — p1-agy-runtime.md check 5)";

/** Credential types google-auth accepts in an ADC-shaped JSON file, and the fields each is useless without. */
export const CREDENTIAL_REQUIRED_FIELDS = {
  authorized_user: ["client_id", "client_secret", "refresh_token"],
  service_account: ["client_email", "private_key"],
  external_account: ["audience", "subject_token_type", "token_url"],
  impersonated_service_account: ["service_account_impersonation_url", "source_credentials"],
};

/**
 * `usable: false` only when CERTAIN.
 */
export function inspectCredentialFile(path, { exists = existsSync, read = readFileSync } = {}) {
  if (!path) return { present: false, usable: false, type: null, detail: null };
  if (!exists(path)) {
    return { present: false, usable: false, type: null, detail: `${path} does not exist` };
  }

  let parsed;
  try {
    parsed = JSON.parse(read(path, "utf8"));
  } catch (err) {
    return { present: true, usable: false, type: null, detail: `${path} is not valid JSON (${err.message})` };
  }

  const type = typeof parsed?.type === "string" ? parsed.type.trim() : null;
  if (!type) {
    return {
      present: true,
      usable: false,
      type: null,
      detail: `${path} has no "type" field, so no Google auth library can tell what kind of credential it is`,
    };
  }

  const required = CREDENTIAL_REQUIRED_FIELDS[type];
  if (!required) {
    return { present: true, usable: true, type, detail: `credential type '${type}' is not one this check knows how to verify` };
  }

  const missing = required.filter((field) => !parsed[field]);
  if (missing.length > 0) {
    return {
      present: true,
      usable: false,
      type,
      detail: `${path} is a '${type}' credential but is missing ${missing.join(", ")}`,
    };
  }

  return { present: true, usable: true, type, detail: null };
}

/**
 * Vertex/Gemini credential state in four values.  — Gemini's own credential precedence has nothing to do with the driver.
 */
export function vertexCredentialState({ env = {}, serviceAccountFile = null, adcFile = null } = {}) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (serviceAccountFile?.usable) {
      return { state: "credential", source: "GOOGLE_APPLICATION_CREDENTIALS", detail: serviceAccountFile.detail };
    }
    return {
      state: "broken",
      source: "GOOGLE_APPLICATION_CREDENTIALS",
      detail:
        serviceAccountFile?.detail ??
        `GOOGLE_APPLICATION_CREDENTIALS points at ${env.GOOGLE_APPLICATION_CREDENTIALS}, which cannot be read`,
    };
  }

  if (adcFile?.usable) return { state: "credential", source: "gcloud ADC file", detail: adcFile.detail };
  if (adcFile?.present) return { state: "broken", source: "gcloud ADC file", detail: adcFile.detail };
  if (env.GOOGLE_CLOUD_PROJECT) return { state: "project-only", source: "GOOGLE_CLOUD_PROJECT", detail: null };
  return { state: "none", source: null, detail: null };
}

/** Fallback when a caller only knows "is there an ADC file". */
function assumedVertexState(env, hasAdcFile) {
  return vertexCredentialState({
    env,
    serviceAccountFile: env.GOOGLE_APPLICATION_CREDENTIALS
      ? { present: true, usable: true, type: null, detail: null }
      : null,
    adcFile: { present: hasAdcFile, usable: hasAdcFile, type: null, detail: null },
  });
}

/** Any door into Gemini open. */
export function hasGeminiCredentials({ env = {}, vertex = null } = {}) {
  return Boolean(env.GEMINI_API_KEY || vertex?.state === "credential");
}

/** The three paths that decide whether the MCP dispatch path is real. */
export function mcpPaths(pluginRoot) {
  const serverDir = join(pluginRoot, "mcp", "model-dispatch");
  return {
    serverDir,
    distEntry: join(serverDir, "dist", "server.js"),
    nodeModules: join(serverDir, "node_modules"),
  };
}

/** Agent leaf id + slot. Sync by hand with antigravity-flash38-plus-opus5.yaml. */
export const AGENT_WORKER_MODEL_ID = "flash-agsdk-worker";
export const AGENT_WORKER_SLOT = "gemini-flash";
export const AGENT_WORKER_SELECT = `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID}`;

/**
 * Mirrors parseSelectOverrides in routing.ts.  — the select-spec grammar is a bridge concern, not a driver one.
 */
export function parseSelectSpec(spec) {
  const pairs = {};
  const invalid = [];
  if (!spec || !String(spec).trim()) return { pairs, invalid };
  for (const part of String(spec).split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      invalid.push(piece);
      continue;
    }
    pairs[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return { pairs, invalid };
}

/** Duplicated from workerProcess.ts's workerVenvPython. Carried unchanged. */
export function workerPaths(pluginRoot) {
  const workerDir = join(pluginRoot, "mcp", "model-dispatch", "worker");
  return {
    workerDir,
    venvPython: join(workerDir, ".venv", "bin", "python"),
    requirements: join(workerDir, "requirements.txt"),
  };
}

/** Has this install selected the agent? */
export function selectsAgentWorker(env = {}) {
  const { pairs } = parseSelectSpec(usableEnv(env).MMO_SELECT);
  return Object.values(pairs).includes(AGENT_WORKER_MODEL_ID);
}

/** Blocking finding for a spec the server will refuse to parse. Carried unchanged. */
export function selectSpecProblem(env = {}) {
  const spec = usableEnv(env).MMO_SELECT;
  const { invalid } = parseSelectSpec(spec);
  if (invalid.length === 0) return null;

  const bareLeaf = invalid.includes(AGENT_WORKER_MODEL_ID);
  return {
    id: "select-spec",
    severity: "blocking",
    message:
      `MMO_SELECT is set to '${spec}', which is not a valid selection. ` +
      `Each entry must be spelled 'slot=option'; ${invalid
        .map((p) => `'${p}'`)
        .join(", ")} ${invalid.length === 1 ? "is" : "are"} not.` +
      (bareLeaf
        ? ` '${AGENT_WORKER_MODEL_ID}' is the option, not the whole selection — it needs the slot in front of it.`
        : ""),
    fix:
      `Set it to '${AGENT_WORKER_SELECT}' for the agent path, or remove it for the model path. ` +
      `Re-run this script with --enable-agent to have it written correctly for you.`,
  };
}

/** Only `credential` counts. */
export function hasVertexCredentials(vertex = null) {
  return vertex?.state === "credential";
}


// ─── agy-native: driver CLI, Opus worker, plugin discovery, policy ───────

/** docs/verification/p1-agy-runtime.md, "This machine". */
export const MIN_AGY_VERSION = [1, 2, 3];

export function parseVersionTriple(versionOutput) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(versionOutput ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function meetsMinVersion(version, min) {
  if (!version) return false;
  for (let i = 0; i < min.length; i++) {
    if (version[i] > min[i]) return true;
    if (version[i] < min[i]) return false;
  }
  return true;
}

/** `agy --version` on PATH. A refused spawn is "unprovable", not "absent". */
export function probeAgyCli(run = spawnSync) {
  const result = run("agy", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) {
    const missing = result.error.code === "ENOENT";
    return { present: false, version: null, unprovable: !missing, detail: result.error.code ?? null };
  }
  if (result.status !== 0) return { present: false, version: null };
  return { present: true, version: parseVersionTriple(result.stdout) };
}

/** `claude --version` on PATH — the Opus worker's binary (claude-cli adapter). */
export function probeClaudeCli(run = spawnSync) {
  const result = run("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) {
    const missing = result.error.code === "ENOENT";
    return { present: false, version: null, unprovable: !missing };
  }
  if (result.status !== 0) return { present: false, version: null };
  return { present: true, version: parseVersionTriple(result.stdout) };
}

/**
 * Claude Code's own sign-in state, from `claude auth status` (JSON on 2.1.x).
 * A claude.ai subscription is the third Claude wallet — the seat: `claude -p`
 * runs on it with no key, and no invoice exists, so the Opus line is modeled.
 * Never reads ~/.claude; parses only the command's own output.
 */
export function probeClaudeLogin(run = spawnSync) {
  const result = run("claude", ["auth", "status"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) return { loggedIn: false, method: null, subscription: null };
  try {
    const j = JSON.parse(String(result.stdout));
    return { loggedIn: j.loggedIn === true, method: j.authMethod ?? null, subscription: j.subscriptionType ?? null };
  } catch {
    const out = String(result.stdout ?? "");
    return { loggedIn: /logged ?in/i.test(out) && !/not logged/i.test(out), method: null, subscription: null };
  }
}

export const DEFAULT_POLICY = "antigravity-flash38-plus-opus5";

export function policyAdapters(yamlText) {
  return [...String(yamlText ?? "").matchAll(/^\s*(?:-\s*)?adapter:\s*([^\s#]+)/gm)].map((m) => m[1]);
}

/**
 * Which policy this project would run, and which credentials it bills.
 * `selected: false` means no .sdlc/project.json chose one.
 */
export function observePolicy(pluginRoot, projectRoot = process.cwd(), read = readFileSync) {
  let chosen = null;
  try {
    chosen = JSON.parse(read(join(projectRoot, ".sdlc", "project.json"), "utf8")).default_policy ?? null;
  } catch { /* no project.json — the default is what would run */ }
  const selected = typeof chosen === "string" && chosen.length > 0;
  const name = selected ? chosen : DEFAULT_POLICY;
  const path = join(pluginRoot, "config", "policies", `${name}.yaml`);
  try {
    const adapters = policyAdapters(read(path, "utf8"));
    return {
      name, selected, path, adapters,
      // Any Claude worker — gates the wallet check, which both transports need.
      usesClaudeWorker: adapters.includes("claude-agent-sdk") || adapters.includes("claude-cli"),
      // Only the subprocess transport needs `claude` on PATH. The Agent SDK
      // ships its own platform binary as an optional dependency, so a policy
      // on claude-agent-sdk alone runs on a machine with no `claude` at all.
      usesClaudeCli: adapters.includes("claude-cli"),
      usesGemini: adapters.includes("mcp:model-dispatch") || adapters.includes("antigravity-worker"),
    };
  } catch {
    return { name, selected, path, adapters: null, usesClaudeWorker: null, usesClaudeCli: null, usesGemini: null };
  }
}

/**
 * Which Claude wallet the launching shell selects (SETUP.md). Both set is a
 * misconfiguration: `claude -p` would bill Vertex while the key sits unused,
 * and the run record could not say which arm ran.
 */
export function claudeArmState(env = {}, login = null) {
  const real = usableEnv(env);
  const key = Boolean(real.ANTHROPIC_API_KEY);
  const vertex = real.CLAUDE_CODE_USE_VERTEX === "1";
  if (key && vertex) return { arm: "both", detail: "ANTHROPIC_API_KEY and CLAUDE_CODE_USE_VERTEX=1 are both set" };
  if (key) return { arm: "A", detail: "ANTHROPIC_API_KEY" };
  if (vertex) {
    const missing = ["ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"].filter((k) => !real[k]);
    return { arm: "B", detail: missing.length ? `CLAUDE_CODE_USE_VERTEX=1 without ${missing.join(", ")}` : "Vertex", missing };
  }
  // The seat: Claude Code signed in to claude.ai. `claude -p` bills nothing per token; the
  // Opus line is modeled. Not the plan's arm A or B — a study on it needs the owner's say-so.
  if (login?.loggedIn && login.method === "claude.ai") {
    return { arm: "seat", detail: `Claude Code signed in to claude.ai${login.subscription ? ` (${login.subscription})` : ""}` };
  }
  return { arm: "none", detail: null };
}

/**
 * The repo-level discovery contract (p1-agy-runtime.md check 10, live
 * 2026-09-17): agy discovers a plugin as `<workspace>/.agents/plugins/<name>/`
 * holding plugin.json, mcp_config.json, hooks.json, rules/ and skills/ —
 * here symlinks into plugin/. The declared route (`.agents/plugins.json`)
 * did not resolve on 1.2.5 and is not used.
 */
export function pluginDiscoveryState(pluginRoot, read = readFileSync, exists = existsSync) {
  const harnessRoot = dirname(pluginRoot);
  const mount = join(harnessRoot, ".agents", "plugins", "mmo");
  const problems = [];
  for (const file of ["plugin.json", "mcp_config.json", "hooks.json"]) {
    if (!exists(join(pluginRoot, file))) problems.push(`${join(pluginRoot, file)} is missing`);
    if (!exists(join(mount, file))) problems.push(`${join(mount, file)} is missing (the discovery mount)`);
  }
  for (const dir of ["skills", "rules", "mcp", "agy"]) {
    if (!exists(join(mount, dir))) problems.push(`${join(mount, dir)} is missing (the discovery mount)`);
  }
  try {
    if (exists(join(mount, "plugin.json")) && JSON.parse(read(join(mount, "plugin.json"), "utf8")).name !== "mmo") problems.push(`${join(mount, "plugin.json")} does not name the plugin mmo`);
  } catch (err) {
    problems.push(`${join(mount, "plugin.json")} is not valid JSON: ${err.message}`);
  }
  return { ok: problems.length === 0, problems, mount };
}

// ─── decision logic ─────────────────────────────────────────────────────

/** Facts → ordered problem list. Pure. `blocking` fails the exit code. */
export function evaluate({
  nodeMajor,
  nodeVersion = null,
  agyCli = { present: false, version: null },
  claudeCli = { present: false, version: null },
  claudeLogin = null,
  hasNodeModules,
  hasDist,
  staleBuild = null,
  discovery = { ok: true, problems: [] },
  env = {},
  vertex = null,
  hasGcloud = true,
  agentWorker = null,
  policy = null,
}) {
  const problems = [];

  if (nodeVersion ? !meetsNodeFloor(nodeVersion) : nodeMajor < 22) {
    problems.push({
      id: "node-version",
      severity: "blocking",
      message: `Node ${nodeVersion ?? nodeMajor} is too old — the bridge needs Node ${MIN_NODE} or newer.`,
      fix: `Install Node ${MIN_NODE} or newer (https://nodejs.org) and re-run this script.`,
    });
  }

  if (agyCli.unprovable) {
    problems.push({
      id: "agy-cli-unprovable",
      severity: "warning",
      message: `Could not run \`agy --version\` (${agyCli.detail ?? "spawn refused"}); the driver's presence is unproven from here.`,
      fix: "Run this script from a plain terminal, outside any sandboxed session.",
    });
  } else if (!agyCli.present) {
    problems.push({
      id: "agy-cli",
      severity: "blocking",
      message: "The Antigravity CLI (`agy`) is not on PATH. It is the driver; nothing runs without it.",
      fix: "curl -fsSL https://antigravity.google/cli/install.sh | bash — then open a new shell (the installer adds ~/.local/bin to PATH).",
    });
  } else if (!meetsMinVersion(agyCli.version, MIN_AGY_VERSION)) {
    problems.push({
      id: "agy-cli",
      severity: "blocking",
      message: `agy ${agyCli.version?.join(".") ?? "?"} is older than the pinned ${MIN_AGY_VERSION.join(".")} (docs/verification/p1-agy-runtime.md).`,
      fix: "agy update",
    });
  }

  if (!discovery.ok) {
    problems.push({
      id: "plugin-discovery",
      severity: "blocking",
      message: `The plugin cannot be discovered from the repo: ${discovery.problems.join("; ")}.`,
      fix: "Restore .agents/plugins/mmo/ (symlinks into plugin/) and plugin/{plugin.json,mcp_config.json,hooks.json} from git — never `agy plugin install` this repo.",
    });
  }

  if (!hasNodeModules) {
    problems.push({
      id: "mcp-dependencies",
      severity: "blocking",
      message: "The bundled MCP server's dependencies are not installed — the bridge cannot start.",
      fix: "Run this script with --fix (or: npm run build at the repo root).",
    });
  }
  if (hasDist && staleBuild?.stale) {
    problems.push({
      id: "mcp-build-stale",
      severity: "warning",
      message: `The bundled MCP server's dist/ is older than its src/ (${staleBuild.files.slice(0, 3).join(", ")}): runs use the old build until it is rebuilt.`,
      fix: "Run this script with --fix (or: npm run build at the repo root).",
    });
  }
  if (!hasDist) {
    problems.push({
      id: "mcp-build",
      severity: "blocking",
      message: "The bundled MCP server is not compiled (dist/server.js missing) — mcp_config.json points at it.",
      fix: "Run this script with --fix (or: npm run build at the repo root).",
    });
  }

  const unexpanded = unexpandedDeclaredEnv(env);
  if (unexpanded.length > 0) {
    problems.push({
      id: "env-placeholders",
      severity: "warning",
      message: `${unexpanded.join(", ")} reached this process as literal \${VAR} text — nothing expanded it.`,
      fix: `Export real values in ${ENV_ADVICE}, or unset them.`,
    });
  }

  const arm = claudeArmState(env, claudeLogin);
  const usesClaudeWorker = policy?.usesClaudeWorker ?? policy?.usesClaudeCli;
  if (usesClaudeWorker !== false) {
    // The `claude` binary is only the claude-cli transport's requirement. A
    // policy on claude-agent-sdk gets its Claude Code from the SDK's own
    // bundled binary, so a missing `claude` is not a problem there at all.
    if (policy?.usesClaudeCli !== false) {
      if (claudeCli.unprovable) {
        problems.push({
          id: "claude-cli-unprovable",
          severity: "warning",
          message: "Could not run `claude --version`; the Opus worker's binary is unproven from here.",
          fix: "Run this script from a plain terminal.",
        });
      } else if (!claudeCli.present) {
        problems.push({
          id: "claude-cli",
          severity: policy?.usesClaudeCli ? "blocking" : "warning",
          message: `Claude Code (\`claude\`) is not on PATH — the claude-cli adapter spawns \`claude -p\` for every judgment phase${policy?.name ? ` of ${policy.name}` : ""}.`,
          fix: "Install Claude Code (https://code.claude.com/docs) and sign in or export ANTHROPIC_API_KEY.",
        });
      }
    }
    if (arm.arm === "seat") {
      problems.push({
        id: "claude-seat",
        severity: "warning",
        message: `The Opus worker will run on your Claude subscription (${arm.detail}) — no key, no invoice, so its cost line is modeled, not the study's arm A or B.`,
        fix: "Fine for wiring and development runs. For a study cost of record, export ANTHROPIC_API_KEY (arm A) or the Vertex variables (arm B), or get the study owner's sign-off on a seat-billed Opus line.",
      });
    } else if (arm.arm === "none") {
      problems.push({
        id: "claude-arm",
        severity: usesClaudeWorker ? "blocking" : "warning",
        message: "No Claude wallet is selected: no ANTHROPIC_API_KEY (arm A), no CLAUDE_CODE_USE_VERTEX=1 (arm B), and Claude Code is not signed in to claude.ai (seat).",
        fix: `Export one arm's variables in ${ENV_ADVICE}, or sign in once with \`claude\`. See SETUP.md.`,
      });
    } else if (arm.arm === "both") {
      problems.push({
        id: "claude-arm",
        severity: "blocking",
        message: `Both Claude arms are selected (${arm.detail}); the run record could not say which wallet paid.`,
        fix: "Unset one. Arm A: ANTHROPIC_API_KEY. Arm B: CLAUDE_CODE_USE_VERTEX=1 + ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION.",
      });
    } else if (arm.arm === "B" && arm.missing?.length) {
      problems.push({
        id: "claude-arm",
        severity: "blocking",
        message: `Arm B is selected but incomplete: ${arm.detail}.`,
        fix: "Export ANTHROPIC_VERTEX_PROJECT_ID=<gcp-project> and CLOUD_ML_REGION=global alongside CLAUDE_CODE_USE_VERTEX=1.",
      });
    }
  }

  if (vertex?.state === "broken") {
    problems.push({
      id: "gemini-credentials-broken",
      severity: "blocking",
      message: `A Google credential is configured but unusable (${vertex.source}): ${vertex.detail}.`,
      fix: vertex.source === "GOOGLE_APPLICATION_CREDENTIALS"
        ? "Point GOOGLE_APPLICATION_CREDENTIALS at a valid service-account JSON, or unset it to fall back to gcloud ADC."
        : "Re-run `gcloud auth application-default login`, or export GEMINI_API_KEY for the AI Studio door.",
    });
  } else if (policy?.usesGemini !== false && !hasGeminiCredentials({ env: usableEnv(env), vertex })) {
    problems.push({
      id: "gemini-credentials",
      severity: policy?.usesGemini ? "blocking" : "warning",
      message: "No Gemini credential: GEMINI_API_KEY is unset and no usable Google ADC was found.",
      fix: hasGcloud
        ? "Export GEMINI_API_KEY (AI Studio), or run `gcloud auth application-default login` for the Vertex door."
        : "Export GEMINI_API_KEY (AI Studio). For the Vertex door install gcloud and run `gcloud auth application-default login`.",
    });
  }

  const specProblem = selectSpecProblem(env);
  if (specProblem) problems.push(specProblem);

  if (selectsAgentWorker(env)) {
    if (!hasVertexCredentials(vertex)) {
      problems.push({
        id: "agent-worker-credentials",
        severity: "blocking",
        message: `MMO_SELECT routes the mechanical tier to ${AGENT_WORKER_MODEL_ID}, which has no API-key door — it needs Vertex ADC.`,
        fix: "Run `gcloud auth application-default login`, or select flash-completion (`--disable-agent`).",
      });
    }
    if (agentWorker && !agentWorker.hasVenv) {
      problems.push({
        id: "agent-worker-python",
        severity: "blocking",
        message: "The agent worker's Python environment is not built.",
        fix: "Run this script with --enable-agent (builds the venv), or --disable-agent.",
      });
    } else if (agentWorker && !agentWorker.sdkImportable) {
      problems.push({
        id: "agent-worker-sdk",
        severity: "blocking",
        message: `The agent worker's Python cannot import google.antigravity${agentWorker.detail ? `: ${agentWorker.detail}` : ""}.`,
        fix: "Run this script with --enable-agent to rebuild the environment.",
      });
    }
  }

  return { ok: !problems.some((p) => p.severity === "blocking"), problems };
}

// ─── observation + repair ──────────────────────────────────────────────

function onPath(cmd) {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

function observeAgentWorker(pluginRoot, env) {
  if (!selectsAgentWorker(env)) return null;
  const override = usableEnv(env).GEMINI_WORKER_PYTHON;
  const python = override || workerPaths(pluginRoot).venvPython;
  if (!existsSync(python)) return { hasVenv: false, sdkImportable: false, detail: null };
  const probe = spawnSync(python, ["-c", "import google.antigravity"], { encoding: "utf8" });
  if (probe.status === 0) return { hasVenv: true, sdkImportable: true, detail: null };
  const stderr = (probe.stderr || "").trim().split("\n").filter(Boolean).pop() ?? null;
  return { hasVenv: true, sdkImportable: false, detail: stderr };
}

function observe(pluginRoot, env = process.env, projectRoot = process.cwd()) {
  const { nodeModules, distEntry } = mcpPaths(pluginRoot);
  const resolvedSelect = env.MMO_SELECT ?? readMmoSelectFile(projectRoot) ?? undefined;
  const effectiveEnv = resolvedSelect !== undefined ? { ...env, MMO_SELECT: resolvedSelect } : env;
  const realEnv = usableEnv(effectiveEnv);
  const adcFile = adcPath();
  return {
    nodeMajor: nodeMajorFrom(process.versions.node),
    nodeVersion: process.versions.node,
    agyCli: probeAgyCli(),
    claudeCli: probeClaudeCli(),
    claudeLogin: probeClaudeLogin(),
    hasGcloud: onPath("gcloud"),
    hasNodeModules: existsSync(nodeModules),
    hasDist: existsSync(distEntry),
    staleBuild: staleBuild(mcpPaths(pluginRoot).serverDir),
    discovery: pluginDiscoveryState(pluginRoot),
    vertex: vertexCredentialState({
      env: realEnv,
      serviceAccountFile: realEnv.GOOGLE_APPLICATION_CREDENTIALS
        ? inspectCredentialFile(realEnv.GOOGLE_APPLICATION_CREDENTIALS)
        : null,
      adcFile: inspectCredentialFile(adcFile),
    }),
    env: effectiveEnv,
    agentWorker: observeAgentWorker(pluginRoot, effectiveEnv),
    policy: observePolicy(pluginRoot, projectRoot),
  };
}

/** `npm ci`, not `npm install` — resolve exactly the verified lockfile. */
function repair(pluginRoot, log) {
  const { serverDir } = mcpPaths(pluginRoot);
  for (const [label, args] of [
    ["installing dependencies", ["ci"]],
    ["building the server", ["run", "build"]],
  ]) {
    log(`  → ${label} (npm ${args.join(" ")})`);
    const result = spawnSync("npm", args, { cwd: serverDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      log(`  ✗ ${label} failed:\n${(result.stderr || result.stdout || "").trim()}`);
      return false;
    }
  }
  return true;
}

/** google-antigravity requires-python >= 3.10; macOS /usr/bin/python3 is 3.9. */
export const MIN_PYTHON = [3, 10];

export function findWorkerPython(run = spawnSync, resolve = onPath) {
  for (const name of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
    if (!resolve(name)) continue;
    const probe = run(name, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      encoding: "utf8",
    });
    if (probe.status !== 0) continue;
    const [major, minor] = String(probe.stdout).trim().split(".").map(Number);
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
      return { command: name, version: `${major}.${minor}` };
    }
  }
  return null;
}

export function buildWorkerEnvironment(pluginRoot, log = () => {}) {
  const { workerDir, venvPython } = workerPaths(pluginRoot);
  const python = findWorkerPython();
  if (!python) {
    return {
      ok: false,
      reason: "no-python",
      detail: `No Python ${MIN_PYTHON.join(".")} or newer found. macOS ships 3.9, which is too old. Install one (e.g. \`brew install python@3.12\`) and retry.`,
    };
  }

  log(`  → creating the worker environment with ${python.command} (${python.version})`);
  for (const [label, cmd, args] of [
    ["creating the virtual environment", python.command, ["-m", "venv", "--clear", ".venv"]],
    ["installing the Antigravity SDK", venvPython, ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"]],
  ]) {
    const result = spawnSync(cmd, args, { cwd: workerDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      return {
        ok: false,
        reason: "failed",
        detail: `${label} failed:\n${(result.stderr || result.stdout || "").trim()}`,
      };
    }
  }
  return { ok: true, reason: null, detail: `${python.command} (${python.version})` };
}

export function agentProbeHint(pluginRoot, env = {}, ok = true) {
  if (!ok || !selectsAgentWorker(env)) return null;
  return (
    `\n  This install selects the agent path, and the checks above are all offline.\n` +
    `  They cannot tell whether the project carries the Antigravity entitlement or\n` +
    `  whether its region serves the model. One trivial delegation settles both:\n` +
    `    node ${join(pluginRoot, "scripts", "probe-agent-worker.mjs")}`
  );
}

export function nextStepsBanner(cwd = process.cwd(), ok = true) {
  if (!ok) return null;
  let currentPolicy = null;
  try {
    currentPolicy = JSON.parse(readFileSync(join(cwd, ".sdlc", "project.json"), "utf8")).default_policy ?? null;
  } catch { /* no project.json yet */ }
  const policyLine = currentPolicy
    ? `\n  Current policy: ${currentPolicy}   (change: the policy skill)`
    : `\n  No policy set yet — the launcher defaults to ${DEFAULT_POLICY}.`;
  return (
    `\n✓ Setup complete for this project.\n\n` +
    `  Interactive: open \`agy\` in the repo root; /plugins lists mmo, /mcp shows model-dispatch,\n` +
    `  /skills lists greenfield, brownfield, pass, policy and the rest.\n\n` +
    `  Headless:    node plugin/agy/run.mjs --brief=<file> --project-root=<dir> --output-dir=<dir> --dry-run\n` +
    policyLine +
    `\n  Sign-in is not checked here: \`agy models\` must list models before a run.`
  );
}

export function agentPathAvailableHint(pluginRoot, vertex = null, env = {}) {
  if (!hasVertexCredentials(vertex)) return null;
  if (selectsAgentWorker(env)) return null;
  return (
    `\n  This machine has credentials for the Antigravity SDK agent path, which the\n` +
    `  mechanical tier is not using. The model path is the cheaper default; to have\n` +
    `  Gemini open the folder and run commands itself:\n` +
    `    node ${join(pluginRoot, "agy", "verify-setup.mjs")} --enable-agent`
  );
}

export function enableAgentPath({ projectRoot, enabled }) {
  const current = readMmoSelectFile(projectRoot);
  const { pairs } = parseSelectSpec(current);
  if (enabled) pairs[AGENT_WORKER_SLOT] = AGENT_WORKER_MODEL_ID;
  else delete pairs[AGENT_WORKER_SLOT];
  const spec = Object.entries(pairs).map(([slot, option]) => `${slot}=${option}`).join(",");
  const path = writeMmoSelectFile(projectRoot, spec || undefined);
  return { ok: true, spec: spec || undefined, path };
}

function report({ ok, problems }, log) {
  const blocking = problems.filter((p) => p.severity === "blocking");
  const warnings = problems.filter((p) => p.severity === "warning");
  for (const p of blocking) log(`  ✗ ${p.message}\n    fix: ${p.fix}`);
  for (const p of warnings) log(`  ! ${p.message}\n    fix: ${p.fix}`);
  if (ok && warnings.length === 0) log("  ✓ Setup is complete. The harness is ready to run.");
  else if (ok) log("  ✓ The harness can run. Warnings above limit which policies will work.");
  return ok;
}

if (isMain(import.meta.url)) {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const log = (m) => console.log(m);
  const shouldFix = process.argv.includes("--fix");
  const enableAgent = process.argv.includes("--enable-agent");
  const disableAgent = process.argv.includes("--disable-agent");
  const brownfieldCheck = process.argv.includes("--brownfield-check");
  const headless = process.argv.includes("--headless");
  const projectRootEq = process.argv.find((a) => a.startsWith("--project-root="));
  const projectRootSpaceIdx = process.argv.indexOf("--project-root");
  const projectRoot = projectRootEq
    ? projectRootEq.slice("--project-root=".length)
    : (projectRootSpaceIdx >= 0 ? process.argv[projectRootSpaceIdx + 1] : process.cwd());

  log("\nAI-SDLC orchestrator (antigravity harness) — setup check");

  let env = process.env;
  if (enableAgent && disableAgent) {
    log("  ✗ --enable-agent and --disable-agent contradict each other. Pass one.");
    process.exit(1);
  }
  if (enableAgent || disableAgent) {
    const written = enableAgentPath({ projectRoot, enabled: enableAgent });
    env = { ...process.env };
    if (written.spec) env.MMO_SELECT = written.spec;
    else delete env.MMO_SELECT;
    log(
      enableAgent
        ? `  ✓ Mechanical tier set to the Antigravity SDK agent path (MMO_SELECT=${written.spec}) in ${written.path}.`
        : `  ✓ Mechanical tier set back to the model path in ${written.path}.`,
    );
    log("    The dispatch fallback reads this file directly; the MCP route needs MMO_SELECT exported in the shell that launches agy.");
  }

  const repairing = shouldFix || enableAgent;
  let observed = observe(pluginRoot, env, projectRoot);
  let state = evaluate(observed);
  const needsRepair = state.problems.some((p) => p.id === "mcp-dependencies" || p.id === "mcp-build");
  if (needsRepair && repairing) {
    log("  The bundled MCP server needs building. Repairing:");
    if (repair(pluginRoot, log)) {
      observed = observe(pluginRoot, env, projectRoot);
      state = evaluate(observed);
    }
  }
  const needsWorker = state.problems.some((p) => p.id === "agent-worker-python" || p.id === "agent-worker-sdk");
  if (needsWorker && repairing) {
    log("  The agent worker needs a Python environment. Repairing:");
    const built = buildWorkerEnvironment(pluginRoot, log);
    if (built.ok) {
      observed = observe(pluginRoot, env, projectRoot);
      state = evaluate(observed);
    } else log(`  ✗ ${built.detail}`);
  }

  const passed = report(state, log);
  for (const hint of [
    agentProbeHint(pluginRoot, env, passed),
    agentPathAvailableHint(pluginRoot, observed.vertex, env),
    brownfieldCheck ? null : nextStepsBanner(projectRoot, passed),
  ]) {
    if (hint) log(hint);
  }

  let brownfieldOk = true;
  if (brownfieldCheck) {
    log("\nBrownfield-mode setup checks:");
    const bf = runEnvChecks();
    brownfieldOk = bf.ok;
    log(renderEnvChecks(bf).trimEnd());
    if (headless && !brownfieldOk) log("\nHeadless mode: a blocker check needs human action. Fix the reported items and re-run.");
    const banner = nextStepsBanner(projectRoot, passed && brownfieldOk);
    if (banner) log(banner);
  }
  process.exit(passed && brownfieldOk ? 0 : 1);
}
