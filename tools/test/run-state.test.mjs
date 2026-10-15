/**
 * The gate state file lives in the run's own folder, `.sdlc/runs/<run-id>/state.json`:
 *   - the write hook lets a live brownfield run write it, though `.sdlc/**` is off-limits;
 *   - every skill, prompt and doc names that path, and no reader builds the old shared one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OFF_LIMITS_DEFAULT } from "../../plugin/scripts/lib/off-limits.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(ROOT, "plugin", "agy", "hooks", "write-contract-check.mjs");
const WRITE_CONTRACT = join(ROOT, "plugin", "scripts", "write-contract.mjs");
const RUN = "20261014-154942-bugfix-login-500";

function liveRun() {
  const dir = mkdtempSync(join(tmpdir(), "run-state-"));
  mkdirSync(join(dir, ".git"));
  const r = spawnSync(process.execPath, [
    WRITE_CONTRACT, "--freeze", `--run-id=${RUN}`,
    `--allowlist=${JSON.stringify(["src/**", "test/**"])}`,
    `--off-limits=${JSON.stringify(OFF_LIMITS_DEFAULT)}`,
    `--project-root=${dir}`,
  ], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

function write(dir, target, name = "write_to_file") {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ toolCall: { name, args: { TargetFile: target } }, workspacePaths: [dir] }),
    encoding: "utf8",
    cwd: dir,
  });
  return JSON.parse(r.stdout);
}

test("a live brownfield run may write its gate state into its own run folder", () => {
  const dir = liveRun();
  try {
    assert.ok(OFF_LIMITS_DEFAULT.includes(".sdlc/**"), "the default off-limits list holds .sdlc/**");
    assert.equal(write(dir, join(dir, ".sdlc", "runs", RUN, "state.json")).decision, "allow");
    assert.equal(write(dir, `.sdlc/runs/${RUN}/state.json`).decision, "allow", "a path relative to the project");
    assert.equal(write(dir, `.sdlc/runs/${RUN}/state.json`, "multi_replace_file_content").decision, "allow", "an edit in place");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the shared .sdlc/local/state.json is refused under a live contract, with the stop-and-ask reply", () => {
  const dir = liveRun();
  try {
    const reply = write(dir, join(dir, ".sdlc", "local", "state.json"));
    assert.equal(reply.decision, "deny");
    assert.match(reply.reason, /matches off-limits pattern "\.sdlc\/\*\*"/);
    assert.match(reply.reason, /stop and tell the person/);
    assert.equal(write(dir, join(dir, ".sdlc", "runs", "20261013-000000-docs-other", "state.json")).decision, "deny", "another run's folder");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function walk(dir, keep, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (/(^|\/)(node_modules|dist|walkthroughs)(\/|$)/.test(rel)) continue;
    if (entry.isDirectory()) walk(full, keep, acc);
    else if (keep(entry.name)) acc.push(full);
  }
  return acc;
}

const instructionFiles = () => [
  ...walk(join(ROOT, "plugin"), (n) => n.endsWith(".md")),
  ...walk(join(ROOT, "docs"), (n) => n.endsWith(".md")),
  join(ROOT, "README.md"),
  join(ROOT, "SETUP.md"),
].filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile());

/** The directory a `├── state.json` tree entry sits in: the nearest line above it indented less. */
function treeParent(lines, i) {
  const col = lines[i].indexOf("── ");
  for (let j = i - 1; j >= 0; j--) {
    const c = lines[j].indexOf("── ");
    if (c === -1) return lines[j].trim().split(/\s/)[0];
    if (c < col) return lines[j].slice(c + 3).trim().split(/\s/)[0];
  }
  return null;
}

test("every skill, prompt and doc names the run folder's state.json, never the shared one", () => {
  const offenders = [];
  for (const file of instructionFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("state.json")) return;
      const where = `${relative(ROOT, file)}:${i + 1}`;
      if (/local\/state\.json/.test(line)) offenders.push(`${where}: ${line.trim()}`);
      if (/── state\.json/.test(line) && treeParent(lines, i) === "local/") offenders.push(`${where}: listed under local/`);
    });
  }
  assert.deepEqual(offenders, []);

  const pipeline = readFileSync(join(ROOT, "plugin", "skills", "pipeline", "SKILL.md"), "utf8");
  assert.match(pipeline, /Persist\s+the gate-pending state to `<output_dir>\/state\.json` before printing/);
  assert.match(pipeline, /`\.sdlc\/runs\/<run-id>\/state\.json`/);
  const guide = readFileSync(join(ROOT, "plugin", "skills", "brownfield-guide", "SKILL.md"), "utf8");
  assert.match(guide, /`\.sdlc\/runs\/<run_id>\/state\.json`/, "the discard step names the run folder");
});

test("no script builds the shared state path except the reader that keeps it as a fallback", () => {
  const offenders = walk(join(ROOT, "plugin"), (n) => /\.(mjs|ts)$/.test(n))
    .filter((f) => !f.endsWith(join("scripts", "lib", "run-state.mjs")))
    .filter((f) => /local\/state\.json|"local",\s*"state\.json"/.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(offenders, []);
});
