/**
 * `npm run verify` end to end, on stub `agy` and `claude` binaries and a
 * temp HOME, so nothing real is probed. npm runs the script from the clone,
 * so without --project-root it checks the clone, not a project.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "plugin", "agy", "verify-setup.mjs");
const DEFAULT = "antigravity-flash38-plus-opus5";
const SHIPPED = readFileSync(join(ROOT, "plugin", "config", "policies", `${DEFAULT}.yaml`), "utf8");
const MEDIUM = SHIPPED.replace(`name: ${DEFAULT}`, "name: team-medium").replace("reasoning: { effort: high }\n  # Gemini 3.8 Flash introductory", "reasoning: { effort: medium }\n  # Gemini 3.8 Flash introductory");
const NO_DRIVER = SHIPPED.replace(`name: ${DEFAULT}`, "name: no-driver").replace(/\ndriver:\n(?: .*\n|\n)*?(?=models:)/, "\n");

let scratch;
let env;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), "verify-cli-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  mkdirSync(join(scratch, "home"));
  for (const [name, out] of [["agy", "agy 1.3.5"], ["claude", "2.1.89 (Claude Code)"]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${out}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  env = { PATH: `${bin}:/usr/bin:/bin`, HOME: join(scratch, "home"), ANTHROPIC_API_KEY: "sk-ant-dummy", GEMINI_API_KEY: "AIza-dummy" };
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function project(routing) {
  const dir = mkdtempSync(join(scratch, "project-"));
  writeFileSync(join(dir, "routing-policy.yaml"), routing);
  return dir;
}

const verify = (argv, cwd = ROOT) => spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, env, encoding: "utf8", timeout: 60_000 });

test("the fixtures change the driver effort and drop the driver block", () => {
  assert.notEqual(MEDIUM, SHIPPED);
  assert.doesNotMatch(NO_DRIVER, /^driver:/m);
});

test("run in the clone with no --project-root, verify gives no start command for the clone", () => {
  const r = verify([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /agy --model/);
  assert.ok(!r.stdout.includes(`cd "${ROOT}"`), r.stdout);
  assert.match(r.stdout, /The harness clone is ready/);
  assert.match(r.stdout, /npm run verify -- --project-root=\/path\/to\/your\/project/);
});

test("with --project-root, verify prints the project's own start command and policy", () => {
  const dir = project(MEDIUM);
  const r = verify([`--project-root=${dir}`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`cd "${dir}" && agy --model gemini-3.8-flash-medium\n`), r.stdout);
  assert.match(r.stdout, /Current policy: team-medium, from the project's routing-policy\.yaml/);
  assert.doesNotMatch(r.stdout, /No policy set yet/);
});

test("a project whose policy has no driver pin fails verify, as it fails setup", () => {
  const dir = project(NO_DRIVER);
  const r = verify(["--project-root", dir]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ No command to start a chat on the driver pin: fairness pin: policy 'no-driver' has no top-level driver: block/);
  assert.doesNotMatch(r.stdout, /Setup is complete|Setup complete for this project|agy --model/);
});
