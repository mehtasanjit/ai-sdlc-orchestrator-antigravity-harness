/**
 * Every CLI and hook must run when invoked through a project's
 * .agents/plugins/mmo/ mount, whose entries are symlinks into plugin/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMain } from "../../plugin/scripts/lib/is-main.mjs";
import { registerProject } from "../setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function mountedProject() {
  const dir = mkdtempSync(join(tmpdir(), "cli-entry-"));
  const { path: mount } = registerProject(dir, ROOT);
  return { dir, mount };
}

test("isMain matches a module run through a symlink and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "is-main-"));
  try {
    const real = join(dir, "real.mjs");
    const link = join(dir, "link.mjs");
    writeFileSync(real, "");
    writeFileSync(join(dir, "other.mjs"), "");
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    assert.equal(isMain(url, real), true);
    assert.equal(isMain(url, link), true);
    assert.equal(isMain(url, join(dir, "other.mjs")), false);
    assert.equal(isMain(url, join(dir, "missing.mjs")), false);
    assert.equal(isMain(url, undefined), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("manifest.mjs, run.mjs and infer-intent.mjs report their usage errors through the mount", () => {
  const { dir, mount } = mountedProject();
  try {
    const node = (...argv) => spawnSync(process.execPath, argv, { cwd: dir, encoding: "utf8" });

    const manifest = node(join(mount, "agy", "manifest.mjs"));
    assert.equal(manifest.status, 2, manifest.stderr);
    assert.match(manifest.stderr, /Usage: node plugin\/agy\/manifest\.mjs/);

    const run = node(join(mount, "agy", "run.mjs"), `--project-root=${dir}`);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /no brief at/);

    const intent = node(join(mount, "scripts", "infer-intent.mjs"));
    assert.equal(intent.status, 1, intent.stderr);
    assert.match(intent.stderr, /Usage: node infer-intent\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the write-contract hook denies through the mount, run the way hooks.json runs it", () => {
  const { dir, mount } = mountedProject();
  try {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: "t1", strict: true, allowlist: ["src/**"], off_limits: [".env"] }));
    const { command } = JSON.parse(readFileSync(join(mount, "hooks.json"), "utf8"))["mmo-write-contract"].PreToolUse[0].hooks[0];
    const [bin, ...argv] = command.split(" ");
    assert.equal(bin, "node");
    const payload = { toolCall: { name: "code_action", args: { AbsolutePath: join(dir, "README.md") } }, workspacePaths: [dir] };
    const r = spawnSync(process.execPath, argv, { cwd: mount, input: JSON.stringify(payload), encoding: "utf8" });
    assert.notEqual(r.stdout, "", "the hook printed no decision");
    assert.equal(JSON.parse(r.stdout).decision, "deny");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no tracked script compares import.meta.url with argv[1] directly", () => {
  const files = execFileSync("git", ["ls-files", "--", "plugin", "tools"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(mjs|js|cjs)$/.test(f) && !f.includes("/dist/") && !f.includes("node_modules"));
  const raw = /import\.meta\.url[^\n]*process\.argv\[1\]|process\.argv\[1\][^\n]*import\.meta\.url/;
  const offenders = files.filter((f) => f !== "tools/test/cli-entry.test.mjs" && raw.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, [], "use isMain(import.meta.url) from plugin/scripts/lib/is-main.mjs");
});
