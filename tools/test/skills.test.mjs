/**
 * Every shipped skill is discoverable by agy: a SKILL.md whose frontmatter
 * names the directory (skills.md in the CLI's bundled docs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = join(ROOT, "plugin", "skills");

const ENTRY_POINTS = [
  "brownfield", "bugfix", "deps", "docs", "feature-extend", "feature-new", "greenfield",
  "pass", "policy", "refactor", "revert", "setup", "test",
];

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "SKILL.md must start with a frontmatter block");
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2];
  }
  return fields;
}

test("every skill directory carries a SKILL.md whose name matches the directory", () => {
  const dirs = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const dir of dirs) {
    const file = join(SKILLS, dir, "SKILL.md");
    assert.ok(existsSync(file), `${dir}/SKILL.md missing`);
    const fm = frontmatter(readFileSync(file, "utf8"));
    assert.equal(fm.name, dir, `${dir}: frontmatter name`);
    assert.ok(fm.description && fm.description.length > 20, `${dir}: description`);
  }
});

test("the 13 entry points converted from the Claude Code commands are all present", () => {
  for (const name of ENTRY_POINTS) {
    assert.ok(existsSync(join(SKILLS, name, "SKILL.md")), `${name} missing`);
  }
  assert.ok(existsSync(join(SKILLS, "pipeline", "SKILL.md")));
  assert.ok(existsSync(join(SKILLS, "brownfield-guide", "SKILL.md")));
});

test("no plugin/commands directory remains: agy has skills, not commands", () => {
  assert.ok(!existsSync(join(ROOT, "plugin", "commands")));
  assert.ok(!existsSync(join(ROOT, "plugin", ".claude-plugin")));
  assert.ok(!existsSync(join(ROOT, "plugin", ".codex-plugin")));
});

/**
 * The role prompts port as content, not mechanism (port plan section 3): the
 * conductor authors nothing, so architect / senior-reviewer / security-reviewer
 * are the `instruction` body of a bridge dispatch, and discovery is the
 * conductor's own local read. Nothing in the playbooks may still describe the
 * Claude Code shape — a subagent, a direct tier, or a plugin/agents directory.
 */
const ROLES = ["architect", "senior-reviewer", "security-reviewer"];
const PLAYBOOKS = ["pipeline/SKILL.md", "brownfield-guide/SKILL.md", "brownfield-guide/discovery.md", ...ROLES.map((r) => `pipeline/roles/${r}.md`)];

test("the role prompts live under the pipeline skill and the pipeline dispatches each one verbatim", () => {
  const pipeline = readFileSync(join(SKILLS, "pipeline", "SKILL.md"), "utf8");
  for (const role of ROLES) {
    const file = join(SKILLS, "pipeline", "roles", `${role}.md`);
    assert.ok(existsSync(file), `${role}.md missing`);
    assert.match(readFileSync(file, "utf8"), /`instruction`/, `${role}.md must say it is the packet instruction`);
    assert.ok(pipeline.includes(`roles/${role}.md`), `pipeline does not reference roles/${role}.md`);
  }
  assert.ok(existsSync(join(SKILLS, "brownfield-guide", "discovery.md")));
  assert.ok(!existsSync(join(ROOT, "plugin", "agents")), "plugin/agents is the Claude Code layout; roles live under skills/");
});

test("the playbooks describe the conductor shape, never a subagent or a direct tier", () => {
  for (const rel of PLAYBOOKS) {
    const text = readFileSync(join(SKILLS, rel), "utf8");
    for (const banned of ["subagent", "direct tier", "direct-tier", "Claude Code", "${CLAUDE_PLUGIN_ROOT}", "plugin/agents", "$mmo-codex", "codex/dispatch.mjs", "{{"]) {
      assert.ok(!text.includes(banned), `${rel} still says '${banned}'`);
    }
  }
  const pipeline = readFileSync(join(SKILLS, "pipeline", "SKILL.md"), "utf8");
  assert.match(pipeline, /agy\/dispatch\.mjs/, "the headless dispatch route");
  assert.match(pipeline, /call_mcp_tool/, "the interactive dispatch route");
  assert.match(pipeline, /agy\/manifest\.mjs/, "manifest.json is written by code");
});
