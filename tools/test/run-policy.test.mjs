/**
 * run.mjs resolves its policy the way the bridge does, so the driver pin,
 * the driver's price and the cost cap come from the file the bridge routes
 * by: routing-policy.yaml, then --policy, then setup's project.json choice,
 * then the shipped default. A custom policy saved in the console used to be
 * silently ignored by headless runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePolicy, DEFAULT_POLICY } from "../../plugin/agy/run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN = join(ROOT, "plugin", "agy", "run.mjs");
const SHIPPED = readFileSync(join(ROOT, "plugin", "config", "policies", `${DEFAULT_POLICY}.yaml`), "utf8");

function project({ routing = null, defaultPolicy = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "run-policy-"));
  writeFileSync(join(dir, "brief.md"), "# brief\n");
  if (routing) writeFileSync(join(dir, "routing-policy.yaml"), routing);
  if (defaultPolicy) {
    mkdirSync(join(dir, ".sdlc"), { recursive: true });
    writeFileSync(join(dir, ".sdlc", "project.json"), JSON.stringify({ default_policy: defaultPolicy }));
  }
  return dir;
}

const dryRun = (dir, ...flags) => spawnSync(process.execPath, [RUN, "--dry-run", `--project-root=${dir}`, "--run-id=t", ...flags], { encoding: "utf8" });

test("with nothing set, the shipped default is used", () => {
  const dir = project();
  try {
    const r = resolvePolicy({ projectRoot: dir });
    assert.deepEqual([r.name, r.source], [DEFAULT_POLICY, "default"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setup's project.json default_policy is used when no flag is passed, and a .yaml suffix is dropped", () => {
  const dir = project({ defaultPolicy: `${DEFAULT_POLICY}.yaml` });
  try {
    const r = resolvePolicy({ projectRoot: dir });
    assert.deepEqual([r.name, r.source], [DEFAULT_POLICY, ".sdlc/project.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a project default naming a policy that does not exist refuses to launch", () => {
  const dir = project({ defaultPolicy: "saved-in-console-then-deleted" });
  try {
    const r = dryRun(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /policy 'saved-in-console-then-deleted' not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--policy beats the project default", () => {
  const dir = project({ defaultPolicy: "something-else" });
  try {
    const r = resolvePolicy({ projectRoot: dir, flag: DEFAULT_POLICY });
    assert.deepEqual([r.name, r.source], [DEFAULT_POLICY, "--policy"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("routing-policy.yaml wins over --policy, as it does in the bridge, and the launcher says so", () => {
  const custom = SHIPPED.replace(`name: ${DEFAULT_POLICY}`, "name: team-custom").replace("hard_cost_cap_usd: 50", "hard_cost_cap_usd: 7");
  const dir = project({ routing: custom });
  try {
    const r = resolvePolicy({ projectRoot: dir, flag: DEFAULT_POLICY });
    assert.deepEqual([r.name, r.source, r.ignoredFlag], ["team-custom", "routing-policy.yaml", DEFAULT_POLICY]);
    assert.equal(r.policy.hard_cost_cap_usd, 7);
    const dry = dryRun(dir, `--policy=${DEFAULT_POLICY}`);
    assert.equal(dry.status, 0, dry.stderr);
    const out = JSON.parse(dry.stdout);
    assert.deepEqual([out.policy, out.policy_source], ["team-custom", "routing-policy.yaml"]);
    assert.match(dry.stderr, /routing-policy\.yaml \(policy 'team-custom'\) is in force/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a policy with no driver pin cannot start headless", () => {
  const noDriver = SHIPPED.replace(`name: ${DEFAULT_POLICY}`, "name: no-driver").replace(/\ndriver:\n(?: .*\n|\n)*?(?=models:)/, "\n");
  assert.doesNotMatch(noDriver, /^driver:/m);
  const dir = project({ routing: noDriver });
  try {
    const r = dryRun(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no top-level driver: block/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an adapter id the bridge does not know is refused at launch, not at the first paid dispatch", () => {
  const bad = SHIPPED.replace(`name: ${DEFAULT_POLICY}`, "name: bad-adapter").replace("adapter: claude-agent-sdk", "adapter: claude-agent-skd");
  const dir = project({ routing: bad });
  try {
    const r = dryRun(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /policy .*routing-policy\.yaml is not valid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
