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
