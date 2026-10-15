/**
 * The brownfield write contract's lifecycle, driven through the real
 * plugin/scripts/write-contract.mjs and the agy hook over stdin:
 *   - Gate 0 freezes by code, and the run's own .sdlc/runs/<run-id>/ is writable;
 *   - the contract stops binding once the run has ended;
 *   - an edited contract refuses every write while its run is live;
 *   - off-limits names match in any letter case;
 *   - a link out of the project is a write outside it;
 *   - only the contract at the git project's root counts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contractState } from "../../plugin/scripts/lib/contract-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(ROOT, "plugin", "agy", "hooks", "write-contract-check.mjs");
const WRITE_CONTRACT = join(ROOT, "plugin", "scripts", "write-contract.mjs");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "wc-life-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}
const wc = (dir, ...args) => spawnSync(process.execPath, [WRITE_CONTRACT, ...args, `--project-root=${dir}`], { encoding: "utf8" });
const freeze = (dir, runId = "r1", extra = []) =>
  wc(dir, "--freeze", `--run-id=${runId}`, `--allowlist=${JSON.stringify(["src/**"])}`, `--off-limits=${JSON.stringify([".env", ".sdlc/**", "secrets/**"])}`, ...extra);
const passingTests = (dir, runId) => {
  const r = spawnSync(process.execPath, [join(ROOT, "plugin", "scripts", "test-run.mjs"), `--run-id=${runId}`, `--output-dir=${join(dir, ".sdlc", "runs", runId)}`, `--cwd=${dir}`, `--command=node -e 0`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
};
const write = (dir, path, cwd = dir) => {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: path } }, workspacePaths: [cwd] }), encoding: "utf8", cwd });
  return JSON.parse(r.stdout);
};

test("Gate 0 freezes by code and the run's own folder is writable while the contract binds", () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    assert.ok(existsSync(join(dir, ".sdlc", "runs", "r1", "contract.lock.json")));
    assert.equal(write(dir, join(dir, ".sdlc", "runs", "r1", "requirements.md")).decision, "allow", "the run's own record, though .sdlc/** is off-limits");
    assert.equal(write(dir, join(dir, ".sdlc", "runs", "r1", "packets", "p1.json")).decision, "allow");
    assert.equal(write(dir, join(dir, ".sdlc", "runs", "r0", "requirements.md")).decision, "deny", "another run's folder is not this run's");
    assert.equal(write(dir, join(dir, ".sdlc", "ledger.md")).decision, "deny");
    assert.equal(write(dir, join(dir, "src", "a.ts")).decision, "allow");
    assert.equal(write(dir, join(dir, "README.md")).decision, "deny");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a live run cannot write its own contract or its freeze, end and test records", () => {
  const dir = repo();
  try {
    freeze(dir, "r1", ["--strict-write=off"]);
    for (const rel of [".sdlc/local/write-contract.json", ".sdlc/runs/r1/contract.lock.json", ".sdlc/runs/r1/run-end.json", ".sdlc/runs/r1/test-run.json"]) {
      const reply = write(dir, join(dir, rel));
      assert.equal(reply.decision, "deny", rel);
      assert.match(reply.reason, /only plugin\/scripts\/write-contract\.mjs and plugin\/scripts\/test-run\.mjs write them/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the contract stops binding once the run has ended, and the close-out records go through", () => {
  const dir = repo();
  try {
    freeze(dir);
    assert.equal(write(dir, join(dir, "README.md")).decision, "deny");
    passingTests(dir, "r1");
    const closed = wc(dir, "--close", "--run-id=r1");
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, ".sdlc", "runs", "r1", "run-end.json"), "utf8")).outcome, "completed");
    assert.equal(JSON.parse(readFileSync(join(dir, ".sdlc", "local", "write-contract.json"), "utf8")).active, false);
    assert.equal(write(dir, join(dir, "README.md")).decision, "allow", "an ended run binds nothing");
    assert.equal(write(dir, join(dir, ".sdlc", "ledger.md")).decision, "allow");
    assert.equal(write(dir, join(dir, ".env.local")).decision, "deny", "the always-off-limits net still holds");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an active contract whose run has an end record binds nothing, even if nothing switched it off", () => {
  const dir = repo();
  try {
    freeze(dir);
    mkdirSync(join(dir, ".sdlc", "runs", "r1"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "runs", "r1", "run-end.json"), JSON.stringify({ run_id: "r1", outcome: "completed" }));
    assert.equal(contractState(dir).binding, false);
    assert.equal(write(dir, join(dir, "README.md")).decision, "allow");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a contract edited after Gate 0 refuses every write until the person abandons the run", () => {
  const dir = repo();
  try {
    freeze(dir);
    const path = join(dir, ".sdlc", "local", "write-contract.json");
    const c = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...c, allowlist: ["**"] }));
    const reply = write(dir, join(dir, "src", "a.ts"));
    assert.equal(reply.decision, "deny", "even a path the original allowlist held");
    assert.match(reply.reason, /changed after Gate 0 froze it.*--abandon --run-id r1/);

    writeFileSync(path, JSON.stringify({ ...c, active: false }));
    assert.equal(write(dir, join(dir, "src", "a.ts")).decision, "deny", "switching it off by hand is a change too");
    rmSync(path);
    assert.match(write(dir, join(dir, "src", "a.ts")).reason, /write contract of live run r1 is missing/);

    assert.equal(wc(dir, "--abandon", "--run-id=r1", "--reason=edited by hand").status, 0);
    assert.equal(write(dir, join(dir, "README.md")).decision, "allow");
    assert.equal(JSON.parse(readFileSync(join(dir, ".sdlc", "runs", "r1", "run-end.json"), "utf8")).outcome, "aborted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("off-limits names match in any letter case, with or without a contract", () => {
  const dir = repo();
  try {
    for (const name of [".ENV", ".Env.Production", ".MCP.json", ".GIT/config"]) {
      assert.equal(write(dir, join(dir, name)).decision, "deny", `${name} with no contract`);
    }
    freeze(dir);
    assert.equal(write(dir, join(dir, "src", ".ENV")).decision, "deny", "at any depth");
    assert.equal(write(dir, join(dir, "SECRETS", "k.txt")).decision, "deny", "the contract's own off_limits too");
    assert.equal(write(dir, join(dir, "SRC", "a.ts")).decision, "deny", "the allowlist grants exactly, not in any case");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a write through a link that leads out of the project is a write outside it", () => {
  const dir = repo();
  const outside = mkdtempSync(join(tmpdir(), "wc-outside-"));
  try {
    mkdirSync(join(dir, "src"));
    symlinkSync(outside, join(dir, "src", "linked"));
    freeze(dir);
    const reply = write(dir, join(dir, "src", "linked", "x.ts"));
    assert.equal(reply.decision, "deny", "src/** is allowed as written, but the link leads outside");
    assert.match(reply.reason, /OUTSIDE|outside the project/);
    symlinkSync(join(dir, ".git"), join(dir, "src", "gitlink"));
    assert.equal(write(dir, join(dir, "src", "gitlink", "config")).decision, "deny", "a link into .git is judged as .git");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("only the contract at the git project's root counts", () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, "pkg", ".sdlc", "local"), { recursive: true });
    writeFileSync(join(dir, "pkg", ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, run_id: "nested", strict: true, allowlist: [], off_limits: [] }));
    assert.equal(write(dir, join(dir, "pkg", "a.ts")).decision, "allow", "a contract in a subfolder binds nothing");
    const r = wc(join(dir, "pkg"), "--freeze", "--run-id=r2", "--allowlist=[]");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not the root of a git project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("freeze refuses a second freeze, a run that ended, and a project another live run holds", () => {
  const dir = repo();
  try {
    assert.equal(freeze(dir).status, 0);
    assert.match(freeze(dir).stderr, /already frozen/);
    assert.match(freeze(dir, "r2").stderr, /run r1 is live and holds this project's contract/);
    wc(dir, "--close", "--run-id=r1", "--outcome=aborted");
    assert.match(freeze(dir, "r1").stderr, /already frozen|has ended/);
    assert.equal(freeze(dir, "r2").status, 0, "a new run freezes after the last one ended");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a nested git project inside a live contract's project is still judged by that contract", () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, "vendor", "lib"), { recursive: true });
    writeFileSync(join(dir, "vendor", "lib", ".git"), "gitdir: ../../.git/modules/lib\n");
    freeze(dir);
    assert.equal(write(dir, join(dir, "vendor", "lib", "src", "evil.js")).decision, "deny", "not in the session contract's allowlist");
    assert.equal(write(dir, join(dir, "src", "a.ts")).decision, "allow");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a workspace and a target that spell the same folder differently through a link are one project", () => {
  const real = mkdtempSync(join(tmpdir(), "wc-real-"));
  const linkParent = mkdtempSync(join(tmpdir(), "wc-link-"));
  const linked = join(linkParent, "proj");
  try {
    mkdirSync(join(real, ".git"));
    symlinkSync(real, linked);
    freeze(real);
    // workspace spelled through the link, target spelled as the real path, and the reverse
    assert.equal(write(linked, join(real, "src", "a.ts"), linked).decision, "allow");
    assert.equal(write(real, join(linked, "src", "a.ts"), real).decision, "allow");
    assert.equal(write(linked, join(real, "README.md"), linked).decision, "deny");
  } finally { rmSync(real, { recursive: true, force: true }); rmSync(linkParent, { recursive: true, force: true }); }
});
