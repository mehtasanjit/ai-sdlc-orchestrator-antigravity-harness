/**
 * tools/setup.mjs — the script prompt 1 drives. The pure pieces (argv,
 * project registration) are unit-tested; the whole wizard runs once
 * non-interactively against an empty project with dummy credentials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, readFileSync, existsSync, writeFileSync, mkdirSync, lstatSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, mountPlan, registerProject, handoverLines, recheckCommand, MOUNT_FILES, MOUNT_DIRS } from "../setup.mjs";
import { projectStartCommand } from "../../plugin/agy/start-command.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("parseArgs takes --key=value, --key value for the two path flags, and bare flags", () => {
  assert.deepEqual(parseArgs(["--project-root", "/p", "--policy=x", "--yes", "--no-agent"]), { "project-root": "/p", policy: "x", yes: true, "no-agent": true });
});

test("a project outside the clone gets absolute links into the clone's plugin/; the clone itself is left to its committed mount", () => {
  const plan = mountPlan("/some/project", "/h");
  assert.equal(plan.mount, "/some/project/.agents/plugins/mmo");
  assert.equal(plan.inside, false);
  assert.equal(plan.links.find((l) => l.name === "skills").target, "/h/plugin/skills");
  assert.deepEqual(plan.links.map((l) => l.name), [...MOUNT_FILES, ...MOUNT_DIRS]);
  assert.equal(mountPlan(ROOT, ROOT).inside, true);
  const committed = join(ROOT, ".agents", "plugins", "mmo");
  for (const { name, target } of mountPlan(ROOT, ROOT).links) assert.equal(readlinkSync(join(committed, name)), target, name);
});

test("registerProject creates the mount once, reports no change the second time, and repairs a wrong link", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-setup-"));
  try {
    const first = registerProject(dir, ROOT);
    assert.equal(first.changed, true);
    const skills = join(dir, ".agents", "plugins", "mmo", "skills");
    assert.ok(lstatSync(skills).isSymbolicLink());
    assert.equal(readlinkSync(skills), join(ROOT, "plugin", "skills"));
    assert.ok(existsSync(join(skills, "greenfield", "SKILL.md")), "the link resolves into the clone");
    assert.equal(registerProject(dir, ROOT).changed, false);
    unlinkSync(skills); writeFileSync(skills, "not a link");
    assert.equal(registerProject(dir, ROOT).changed, true);
    assert.ok(lstatSync(skills).isSymbolicLink());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the wizard runs non-interactively against an empty project and leaves it registered with a policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-setup-run-"));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "tools", "setup.mjs"), `--project-root=${dir}`, "--yes", "--no-agent", "--policy=antigravity-flash38-plus-opus5"], {
      encoding: "utf8", timeout: 120_000,
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-dummy", GEMINI_API_KEY: "AIza-dummy" },
    });
    const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(existsSync(join(dir, ".agents", "plugins", "mmo", "plugin.json")), out);
    assert.equal(JSON.parse(readFileSync(join(dir, ".sdlc", "project.json"), "utf8")).default_policy, "antigravity-flash38-plus-opus5");
    assert.match(out, /Mount the plugin in this project/);
    assert.match(out, /Arm A: ANTHROPIC_API_KEY is set/);
    assert.match(out, /Start a NEW agy session|Setup incomplete/);
    assert.match(out, /The run session starts with: agy --model gemini-3\.8-flash-high/);
    if (/Setup complete/.test(out)) assert.ok(out.includes(`cd "${dir}" && agy --model gemini-3.8-flash-high\n`), out);
    assert.ok(out.includes(`verify-setup.mjs" --project-root="${dir}"`), "the re-check names the project, not the clone npm run verify checks");
    assert.doesNotMatch(out, /npm run verify/);
    assert.ok(!/plugin install/.test(out.replace(/Do not run `agy plugin install`/g, "")), "never tells anyone to install globally");
    assert.ok(!out.includes("sk-ant-dummy"), "never prints a key");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hand-over gives the exact start command with the project's own driver pin, and why", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-setup-handover-"));
  try {
    const lines = handoverLines({ projectRoot: dir, start: projectStartCommand({ projectRoot: dir }) });
    assert.match(lines[0], /^Start a NEW agy session in /);
    assert.equal(lines[1], `  cd "${dir}" && agy --model gemini-3.8-flash-high`);
    assert.match(lines[2], /^Without --model the chat runs on agy's default model, and the run refuses to start on it: .*checks the model it ran on against gemini-3\.8-flash\.$/);
    assert.ok(lines.some((l) => l.includes("/mmo:greenfield")));
    assert.ok(lines.some((l) => /run\.mjs" --brief=.*--dry-run$/.test(l)));

    const policy = readFileSync(join(ROOT, "plugin", "config", "policies", "antigravity-flash38-plus-opus5.yaml"), "utf8")
      .replace("name: antigravity-flash38-plus-opus5", "name: team-low")
      .replace("reasoning: { effort: high }\n  # Gemini 3.8 Flash introductory", "reasoning: { effort: low }\n  # Gemini 3.8 Flash introductory");
    writeFileSync(join(dir, "routing-policy.yaml"), policy);
    const other = handoverLines({ projectRoot: dir, start: projectStartCommand({ projectRoot: dir }) });
    assert.equal(other[1], `  cd "${dir}" && agy --model gemini-3.8-flash-low`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run against the harness clone, the hand-over gives no start command and points at a project", () => {
  const lines = handoverLines({ projectRoot: ROOT, start: projectStartCommand({ projectRoot: ROOT }) });
  assert.ok(!lines.some((l) => l.includes("agy --model")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes(`cd "${ROOT}"`)), lines.join("\n"));
  assert.equal(lines[1], `  node "${join(ROOT, "tools", "setup.mjs")}" --project-root=/path/to/your/project`);
});

test("the re-check runs from any folder and checks the project it names", () => {
  assert.equal(recheckCommand("/some/project", "/h"), 'node "/h/plugin/agy/verify-setup.mjs" --project-root="/some/project"');
});
