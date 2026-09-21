#!/usr/bin/env node
/**
 * Environment prerequisite checks for brownfield mode. Invocable standalone
 * for CI/headless use, and by verify-setup.mjs.
 *
 * Checks:
 *   1. Node ≥ 20
 *   2. Git ≥ 2.30
 *   3. Filesystem write permission on .sdlc/ (if inside a repo)
 *   4. Plugin skill-name conflicts, via `agy plugin list`
 *
 * No `~/.gemini` writability check: this harness writes nothing there
 * (docs/verification/p1-agy-runtime.md check 10).
 *
 * Every check is fail-tolerant. Exit code: 0 when every failure is advisory,
 * 1 on a hard blocker.
 *
 * Usage:
 *   node env-checks.mjs              # text output, exit 0/1
 *   node env-checks.mjs --json       # JSON output
 *   node env-checks.mjs --headless   # never prompts; same as default for now
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Skill names this plugin ships (plugin/skills/*). Kept in step by env-checks.test.mjs. */
export const OUR_COMMAND_NAMES = new Set([
  "greenfield",
  "brownfield",
  "pass",
  "policy",
  "setup",
  "revert",
  "bugfix",
  "docs",
  "test",
  "refactor",
  "deps",
  "feature-new",
  "feature-extend",
  "pipeline",
  "brownfield-guide",
]);

const MIN_NODE_MAJOR = 20;
const MIN_GIT_VERSION = [2, 30];

// ─── check helpers ───────────────────────────────────────────────────

function check(id, severity, ok, details = {}) {
  return { id, severity, ok, ...details };
}

export function parseSemverLike(text) {
  const m = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] ?? "0", 10)];
}

export function cmpVer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ─── individual checks ───────────────────────────────────────────────

export function checkNodeVersion() {
  const ver = parseSemverLike(process.versions.node) ?? [0];
  const ok = ver[0] >= MIN_NODE_MAJOR;
  return check("node-version", "blocker", ok, {
    detected: process.versions.node,
    required_min: `${MIN_NODE_MAJOR}.0.0`,
    remediation: ok ? null : [
      "The harness's scripts and MCP server need Node 20 or newer.",
      "Upgrade with one of:",
      "  • nvm install 20 && nvm use 20    (if you have nvm)",
      "  • brew install node@20            (macOS with brew)",
      "  • Download from https://nodejs.org",
      "Re-run this check after upgrading.",
    ],
  });
}

export function checkGitVersion(run = spawnSync) {
  const r = run("git", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) {
    return check("git-version", "blocker", false, {
      detected: null,
      required_min: MIN_GIT_VERSION.join("."),
      remediation: [
        "git is not on your PATH.",
        "Install it: macOS → xcode-select --install · Ubuntu → sudo apt install git · Windows → https://git-scm.com",
        "Re-run this check after installing.",
      ],
    });
  }
  const ver = parseSemverLike(r.stdout);
  if (!ver) {
    return check("git-version", "blocker", false, {
      detected: String(r.stdout).trim(),
      required_min: MIN_GIT_VERSION.join("."),
      remediation: ["Could not parse git version. Re-check `git --version` output."],
    });
  }
  const ok = cmpVer(ver, MIN_GIT_VERSION) >= 0;
  return check("git-version", "blocker", ok, {
    detected: ver.join("."),
    required_min: MIN_GIT_VERSION.join("."),
    remediation: ok ? null : [
      `Git ${ver.join(".")} is older than the required ${MIN_GIT_VERSION.join(".")}.`,
      "Upgrade: macOS → brew upgrade git · Ubuntu → sudo apt update && sudo apt install git",
      "Re-run this check after upgrading.",
    ],
  });
}

export function checkSdlcDirWritable() {
  const root = findRepoRoot();
  if (!root) {
    return check("sdlc-dir-writable", "advisory", true, {
      note: "Not in a git repo — .sdlc/ writability check deferred to the first brownfield run in a project.",
    });
  }
  const dir = join(root, ".sdlc", "local");
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return check("sdlc-dir-writable", "blocker", true, { path: dir });
  } catch (e) {
    return check("sdlc-dir-writable", "blocker", false, {
      path: dir,
      error: e?.message ?? String(e),
      remediation: [
        `Cannot create/write ${dir}.`,
        "The harness needs this directory to persist per-run state.",
        `Check permissions on ${root} and its .sdlc/ subtree.`,
      ],
    });
  }
}

/**
 * Skill names a plugin entry declares, tolerating shapes this port has not
 * seen. `agy plugin list --json` on 1.2.3 prints "No imported plugins." when
 * none are staged, and no JSON shape has been observed with one installed —
 * so this reads defensively and returns nothing rather than guessing.
 */
export function commandNamesFrom(entry) {
  const names = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) names.push(v.trim().replace(/^\//, ""));
  };
  for (const key of ["skills", "commands", "command"]) {
    const value = entry?.[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") push(item);
        else push(item?.name);
      }
    } else if (value && typeof value === "object") {
      for (const k of Object.keys(value)) push(k);
    } else if (typeof value === "string") {
      push(value);
    }
  }
  return names;
}

/**
 * Conflict scan over `agy plugin list --json`. Advisory, never blocking: a
 * collision is worth naming, but how agy resolves one is its decision.
 */
export function checkPluginConflicts(run = spawnSync) {
  const r = run("agy", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 10_000 });
  if (r?.error || r?.status !== 0) {
    return check("plugin-conflicts", "advisory", true, {
      note: "Could not enumerate agy plugins (is agy on PATH?) — conflict scan skipped.",
    });
  }
  const out = String(r.stdout ?? "").trim();
  if (/^No imported plugins\.?$/i.test(out) || out === "") {
    return check("plugin-conflicts", "advisory", true, {
      scanned: 0,
      note: "No agy plugins imported into the user profile — nothing to conflict with.",
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return check("plugin-conflicts", "advisory", true, {
      note: "`agy plugin list --json` returned output this check could not parse — scan skipped.",
    });
  }

  const installed = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.plugins) ? parsed.plugins : Array.isArray(parsed?.installed) ? parsed.installed : [];
  const conflicts = [];
  for (const entry of installed) {
    const pluginName = typeof entry?.name === "string" ? entry.name : "(unnamed plugin)";
    if (pluginName === "mmo") continue;
    for (const cmd of commandNamesFrom(entry)) {
      if (OUR_COMMAND_NAMES.has(cmd)) conflicts.push({ plugin: pluginName, command: cmd });
    }
  }

  if (conflicts.length === 0) {
    return check("plugin-conflicts", "advisory", true, {
      scanned: installed.length,
      note: `Scanned ${installed.length} imported plugin(s); no skill-name collisions.`,
    });
  }
  return check("plugin-conflicts", "advisory", false, {
    scanned: installed.length,
    conflicts,
    remediation: [
      "Another imported agy plugin declares a skill name this harness also owns:",
      ...conflicts.map((c) => `  • ${c.command}  (from ${c.plugin})`),
      "Which one wins is agy's decision, not this harness's — if a skill",
      "behaves unexpectedly, remove one of the two: agy plugin uninstall <name>",
    ],
  });
}

// ─── main ────────────────────────────────────────────────────────────

export const CHECKS = [
  checkNodeVersion,
  checkGitVersion,
  checkSdlcDirWritable,
  checkPluginConflicts,
];

export function parseArgs(argv) {
  const args = { json: false, headless: false };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--headless") args.headless = true;
  }
  return args;
}

export function renderText(report) {
  const lines = [];
  for (const r of report.checks) {
    const status = r.ok ? "✓" : (r.severity === "blocker" ? "✗" : "⚠");
    lines.push(`${status} ${r.id}: ${r.ok ? "ok" : (r.severity + " — " + (r.error ?? "failed"))}`);
    if (!r.ok && Array.isArray(r.remediation)) {
      for (const line of r.remediation) lines.push("    " + line);
    }
    if (r.note) lines.push("    " + r.note);
  }
  const summary = report.blockers > 0
    ? `\nFAILED — ${report.blockers} blocker(s), ${report.advisories} advisory item(s).`
    : `\nPASSED${report.advisories ? ` (${report.advisories} advisory item(s))` : ""}.`;
  return lines.join("\n") + summary + "\n";
}

export function runChecks(checks = CHECKS) {
  const results = checks.map((fn) => {
    try { return fn(); }
    catch (e) { return { id: fn.name, severity: "blocker", ok: false, error: e?.message ?? String(e) }; }
  });
  const blockers = results.filter((r) => !r.ok && r.severity === "blocker").length;
  const advisories = results.filter((r) => !r.ok && r.severity === "advisory").length;
  return { schema_version: 1, ok: blockers === 0, blockers, advisories, checks: results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = { ...runChecks(), headless: args.headless };
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else process.stdout.write(renderText(report));
    process.exit(report.blockers === 0 ? 0 : 1);
  } catch (e) {
    process.stdout.write(JSON.stringify({ schema_version: 1, ok: false, error: e?.message ?? String(e) }) + "\n");
    process.exit(1);
  }
}
