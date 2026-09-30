/**
 * Rename guard for the sdlc → mmo namespace, carried from the Claude Code
 * harness, plus the commands → skills move this harness made. Two directions:
 *   - forward: no shipped, non-historical file uses a retired spelling as a
 *     path, command, or server name.
 *   - reverse: the state directory and the AI-SDLC methodology name, which
 *     the rename deliberately never touches, are still there.
 *
 * EXCLUDED, and why:
 *   - docs/verification/** — the live-check record, kept as it was run.
 *   - examples/*\/passes/** — shipped evidence of real runs; rewriting a
 *     recorded run's paths would be falsification.
 *   - .agents/plugins/mmo/** — the discovery mount, symlinks into plugin/,
 *     which is scanned once under its real path.
 *   - node_modules/, dist/, .git/, .sdlc/ — dependencies, build output, or
 *     runtime state, not shipped source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HISTORICAL_PREFIXES = ["docs/verification/"];
const MOUNT_PREFIX = ".agents/plugins/";

function isHistorical(path) {
  if (HISTORICAL_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (path.startsWith(MOUNT_PREFIX)) return true;
  if (/^examples\/[^/]+\/passes\//.test(path)) return true;
  return false;
}

/** Every git-tracked file, minus historical records and this test itself. */
function shippedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !isHistorical(p))
    .filter((p) => p !== "tools/test/namespace.test.mjs")
    .filter((p) => !p.includes("package-lock.json")); // dependency tree, not shipped source
}

const RETIRED_PATTERNS = [
  { name: "/sdlc:", pattern: /\/sdlc:/ },
  { name: "plugin_sdlc_", pattern: /plugin_sdlc_/ },
  { name: "run-ai-sdlc", pattern: /run-ai-sdlc/ },
  {
    // agy has skills, not commands. skills.test.mjs asserts the directory is
    // gone; this catches a path that names it.
    name: "plugin/commands/",
    pattern: /plugin\/commands\//,
    exceptions: ["tools/test/skills.test.mjs"],
  },
  {
    // Bare gemini-flash-server used as a path or server id. The compat-shim
    // call sites in the bridge are the one legitimate exception.
    name: "gemini-flash-server",
    pattern: /gemini-flash-server/,
    exceptions: [
      "plugin/mcp/model-dispatch/src/adapters/index.ts",
      "plugin/mcp/model-dispatch/src/server.ts",
      "plugin/mcp/model-dispatch/src/adapters/geminiEndpoint.ts",
      "plugin/mcp/model-dispatch/test/policyResolution.test.mjs",
    ],
  },
];

test("no shipped file outside the historical record uses a retired spelling", () => {
  const files = shippedFiles();
  for (const path of files) {
    const text = readFileSync(resolve(ROOT, path), "utf8");
    for (const { name, pattern, exceptions } of RETIRED_PATTERNS) {
      if (exceptions?.includes(path)) continue;
      assert.ok(!pattern.test(text), `${path} still contains '${name}' — a retired spelling`);
    }
  }
});

test("the state directory and the AI-SDLC methodology name were never renamed", () => {
  const files = shippedFiles();
  let sawSdlcDir = false;
  let sawAiSdlc = false;
  for (const path of files) {
    const text = readFileSync(resolve(ROOT, path), "utf8");
    if (text.includes(".sdlc/") || text.includes(".sdlc\"") || text.includes(".sdlc'")) sawSdlcDir = true;
    if (text.includes("AI-SDLC")) sawAiSdlc = true;
    assert.ok(!/\.mmo\//.test(text), `${path} references .mmo/ — the state directory is not renamed`);
  }
  assert.ok(sawSdlcDir, "expected at least one shipped reference to .sdlc/ — did the guard break?");
  assert.ok(sawAiSdlc, "expected at least one shipped reference to AI-SDLC — did the guard break?");
});

test("OFF_LIMITS_DEFAULT still lists the state directory", () => {
  const src = readFileSync(resolve(ROOT, "plugin/scripts/lib/off-limits.mjs"), "utf8");
  assert.match(src, /\.sdlc\/\*\*/, "OFF_LIMITS_DEFAULT must keep guarding .sdlc/**");
});

test("the plugin manifest, the package and the discovery mount agree on the name and version", () => {
  const plugin = JSON.parse(readFileSync(resolve(ROOT, "plugin/plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const mounted = JSON.parse(readFileSync(resolve(ROOT, ".agents/plugins/mmo/plugin.json"), "utf8"));
  assert.equal(plugin.name, "mmo", "the plugin's canonical name is mmo");
  assert.equal(mounted.name, plugin.name, "the .agents mount resolves to a different plugin.json");
  assert.equal(pkg.version, plugin.version, "package.json and plugin.json disagree on the version");
});

test("the README badge and the methodology version notes name the plugin's version", () => {
  const { version } = JSON.parse(readFileSync(resolve(ROOT, "plugin/plugin.json"), "utf8"));
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  const badge = readme.match(/img\.shields\.io\/badge\/version-([0-9.]+)-/);
  assert.ok(badge, "README.md has no version badge");
  assert.equal(badge[1], version, "README.md's version badge disagrees with plugin.json");
  const methodology = readFileSync(resolve(ROOT, "docs/methodology.md"), "utf8");
  assert.match(methodology, new RegExp(`^### ${version.replace(/\./g, "\\.")}\\b`, "m"), "docs/methodology.md has no version notes for this version");
});

test("the moved paths exist under their new names, and not the old ones", () => {
  const moved = [
    ["plugin/skills/greenfield/SKILL.md", "plugin/commands/greenfield.md"],
    ["plugin/skills/pipeline", "plugin/skills/run-ai-sdlc"],
    ["plugin/mcp/model-dispatch", "plugin/mcp/gemini-flash-server"],
  ];
  const tracked = new Set(shippedFiles());
  const trackedPrefixes = (prefix) => [...tracked].some((p) => p === prefix || p.startsWith(`${prefix}/`));
  for (const [next, prev] of moved) {
    assert.ok(trackedPrefixes(next), `${next} should exist after the rename`);
    assert.ok(!trackedPrefixes(prev), `${prev} should no longer exist after the rename`);
  }
});
