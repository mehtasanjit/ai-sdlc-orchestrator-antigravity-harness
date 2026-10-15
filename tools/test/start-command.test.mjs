/**
 * The command that starts an interactive run carries the policy's driver pin.
 * A chat started with plain `agy` conducts on agy's default model, while the
 * run prices the conductor at the pin and checks it, so the pin check fails.
 * The slug must be the one run.mjs passes as --model for the same project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chatStartCommand, isHarnessClone, projectStartCommand, whyThePin, yamlParser } from "../../plugin/agy/start-command.mjs";
import { DEFAULT_POLICY } from "../../plugin/agy/run.mjs";
import { registerProject } from "../setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(ROOT, "plugin");
const SHIPPED = readFileSync(join(PLUGIN, "config", "policies", `${DEFAULT_POLICY}.yaml`), "utf8");
const MEDIUM = SHIPPED.replace(`name: ${DEFAULT_POLICY}`, "name: team-medium").replace("reasoning: { effort: high }\n  # Gemini 3.8 Flash introductory", "reasoning: { effort: medium }\n  # Gemini 3.8 Flash introductory");

function project({ routing = null, defaultPolicy = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "start-command-"));
  writeFileSync(join(dir, "brief.md"), "# brief\n");
  if (routing) writeFileSync(join(dir, "routing-policy.yaml"), routing);
  if (defaultPolicy) {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ default_policy: defaultPolicy }));
  }
  return dir;
}

const dryRunSlug = (dir) => {
  const r = spawnSync(process.execPath, [join(PLUGIN, "agy", "run.mjs"), "--dry-run", `--project-root=${dir}`, "--run-id=t", "--gates=auto-approve"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).pin.slug;
};

test("the default policy starts the chat with agy --model gemini-3.8-flash-high", () => {
  assert.notEqual(MEDIUM, SHIPPED, "the fixture changes the driver effort");
  const dir = project();
  try {
    const start = projectStartCommand({ projectRoot: dir });
    assert.deepEqual(start, { command: "agy --model gemini-3.8-flash-high", slug: "gemini-3.8-flash-high", model: "gemini-3.8-flash", policy: DEFAULT_POLICY, source: "default" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a different policy prints its own slug, the one run.mjs passes as --model", () => {
  const dir = project({ routing: MEDIUM });
  try {
    const start = projectStartCommand({ projectRoot: dir });
    assert.equal(start.command, "agy --model gemini-3.8-flash-medium");
    assert.equal(start.source, "routing-policy.yaml");
    assert.equal(start.slug, dryRunSlug(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setup's project.json choice decides the slug, as it does for run.mjs", () => {
  const plugin = mkdtempSync(join(tmpdir(), "start-command-plugin-"));
  const dir = project({ defaultPolicy: "team-medium" });
  try {
    mkdirSync(join(plugin, "config", "policies"), { recursive: true });
    writeFileSync(join(plugin, "config", "policies", "team-medium.yaml"), MEDIUM);
    copyFileSync(join(PLUGIN, "config", "policies", `${DEFAULT_POLICY}.yaml`), join(plugin, "config", "policies", `${DEFAULT_POLICY}.yaml`));
    const start = projectStartCommand({ projectRoot: dir, pluginRoot: plugin });
    assert.deepEqual([start.command, start.policy, start.source], ["agy --model gemini-3.8-flash-medium", "team-medium", ".sdlc/project.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plugin, { recursive: true, force: true });
  }
});

test("a policy with no driver pin yields no command and says why", () => {
  const noDriver = SHIPPED.replace(`name: ${DEFAULT_POLICY}`, "name: no-driver").replace(/\ndriver:\n(?: .*\n|\n)*?(?=models:)/, "\n");
  const dir = project({ routing: noDriver });
  try {
    const start = projectStartCommand({ projectRoot: dir });
    assert.equal(start.command, null);
    assert.match(start.error, /no top-level driver: block/);
    assert.deepEqual([start.policy, start.source], ["no-driver", "routing-policy.yaml"], "the policy that failed is still named");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the policy is read with the bridge's yaml when the clone's root install is absent", () => {
  const bare = mkdtempSync(join(tmpdir(), "start-command-bare-"));
  try {
    const fromBare = pathToFileURL(join(bare, "x.mjs")).href;
    const parse = yamlParser(PLUGIN, [fromBare, join(PLUGIN, "mcp", "model-dispatch", "package.json")]);
    assert.equal(parse("a: 1").a, 1);
    assert.throws(() => yamlParser(PLUGIN, [fromBare]), /npm run build/);
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test("the reason names the model the run checks, not the slug: agy's local record carries no effort", async () => {
  const { offPinModels } = await import("../../plugin/agy/telemetry/event-reader.mjs");
  const { driverSlug } = await import("../../plugin/agy/telemetry/fairnessPin.mjs");
  assert.equal(chatStartCommand({ model: "gemini-3.8-flash", effort: "low" }), "agy --model gemini-3.8-flash-low");
  const pin = { model: "gemini-3.8-flash", effort: "medium" };
  assert.deepEqual(offPinModels(["gemini-3.8-flash"], pin, driverSlug(pin)), [], "a chat at another effort still passes");
  const why = whyThePin(pin.model);
  assert.match(why, /^Without --model the chat runs on agy's default model, .*checks the model it ran on against gemini-3\.8-flash, so the model check fails\.$/);
  assert.doesNotMatch(why, /-medium|-high|-low/);
});

test("only the harness clone itself counts as the clone, whatever the path's spelling", () => {
  assert.equal(isHarnessClone(ROOT), true);
  assert.equal(isHarnessClone(join(ROOT, "plugin", "..")), true);
  assert.equal(isHarnessClone(join(PLUGIN, "skills")), false);
  const dir = project();
  try {
    assert.equal(isHarnessClone(dir), false);
    symlinkSync(ROOT, join(dir, "clone"));
    assert.equal(isHarnessClone(join(dir, "clone")), true, "a link to the clone is the clone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(isHarnessClone("/p", "/p"), true, "a path that does not exist compares as resolved");
});

test("the CLI prints the command, through the project's plugin mount too", () => {
  const dir = project({ routing: MEDIUM });
  try {
    const { path: mount } = registerProject(dir, ROOT);
    for (const script of [join(PLUGIN, "agy", "start-command.mjs"), join(mount, "agy", "start-command.mjs")]) {
      for (const argv of [[`--project-root=${dir}`], ["--project-root", dir]]) {
        const r = spawnSync(process.execPath, [script, ...argv], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, "agy --model gemini-3.8-flash-medium\n");
      }
    }
    writeFileSync(join(dir, "routing-policy.yaml"), "version: 1\n");
    const bad = spawnSync(process.execPath, [join(PLUGIN, "agy", "start-command.mjs"), `--project-root=${dir}`], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^start-command: .*no name: field/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
