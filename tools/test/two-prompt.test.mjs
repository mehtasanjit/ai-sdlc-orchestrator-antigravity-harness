/**
 * The two-prompt user surface (README "Setup — the two-prompt flow") and the
 * agy vocabulary of the entry-point skills. Regressions here are silent:
 * a `${CLAUDE_PLUGIN_ROOT}` left in a skill is a path the model cannot
 * resolve, and a `/mmo:` reference names a command this runtime does not
 * register.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_POLICY, loadPolicyFile } from "../../plugin/agy/run.mjs";
import { driverSlug, readPin } from "../../plugin/agy/telemetry/fairnessPin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("README carries prompt 1 (the repo URL, verbatim) and prompt 2 (a new session, then the skills)", () => {
  const readme = read("README.md");
  assert.match(readme, /## Setup — the two-prompt flow/);
  assert.match(readme, /Set up this plugin from this repo - https:\/\/github\.com\/tl-ai-labs\/ai-sdlc-orchestrator-antigravity-harness/);
  assert.match(readme, /\*\*Prompt 2 — run\.\*\* Start a \*\*new `agy` session in the same folder\*\*/);
  assert.match(readme, /\ncd ~\/my-first-app && agy --model gemini-3\.8-flash-high\n/, "prompt 2 starts the chat on the driver pin");
  assert.match(readme, /\/mmo:greenfield/);
  assert.match(readme, /\/mmo:brownfield/);
  assert.match(readme, /node tools\/setup\.mjs --project-root/);
  assert.ok(!/agy plugin install/.test(readme.replace(/Do not run `agy plugin install`/g, "")), "never a global install");
});

test("README's skills table names every shipped skill under its live /mmo: name", () => {
  const readme = read("README.md");
  const skills = readdirSync(join(ROOT, "plugin", "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const s of skills) assert.match(readme, new RegExp(`\`/mmo:${s}\`|\`${s}\``), s);
});

test("INSTALL.md and SETUP.md describe the project-folder flow: clone beside, register, new session", () => {
  const install = read("INSTALL.md");
  assert.match(install, /tools\/setup\.mjs --project-root/);
  assert.match(install, /\.agents\/plugins\/mmo/);
  assert.match(install, /new\*\* `agy` session/);
  const setup = read("SETUP.md");
  assert.match(setup, /Arm A/); assert.match(setup, /Arm B/);
  assert.match(setup, /antigravity-flash38-plus-opus5/);
  assert.match(setup, /Before any paid run/);
});

test("entry-point skills use ${MMO_PLUGIN_ROOT} and never Claude Code's variable or settings paths", () => {
  const skills = readdirSync(join(ROOT, "plugin", "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const s of skills) {
    const text = read(join("plugin", "skills", s, "SKILL.md"));
    assert.ok(!text.includes("${CLAUDE_PLUGIN_ROOT}"), `${s}: \${CLAUDE_PLUGIN_ROOT}`);
    assert.ok(!/~\/\.claude|\.claude\/settings/.test(text), `${s}: Claude Code settings path`);
  }
  const rules = read("plugin/rules/AGENTS.md");
  assert.match(rules, /MMO_PLUGIN_ROOT/, "the rules say how to resolve it");
  assert.match(rules, /\.agents\/plugins\/mmo/);
  assert.match(rules, /call_mcp_tool/, "the rules name how MCP tools are invoked interactively (check 1)");
});

test("the pass skill accepts only --auth=vendor on this runtime", () => {
  const pass = read("plugin/skills/pass/SKILL.md");
  assert.match(pass, /`--auth=vendor` — \*\*required\*\*, and `vendor` is the only value/);
  assert.ok(!/CLAUDE_CODE_SUBAGENT_MODEL` must be set/.test(pass));
});

const RUN_START_DOCS = ["README.md", "docs/running.md", "docs/tutorial-first-run.md", "INSTALL.md", "SETUP.md", "docs/setup.md", "plugin/skills/setup/SKILL.md"];

test("every place that starts the run session gives agy --model with the default policy's slug, and says why", () => {
  const command = `agy --model ${driverSlug(readPin(loadPolicyFile(DEFAULT_POLICY)))}`;
  for (const p of RUN_START_DOCS) {
    const text = read(p);
    assert.ok(text.includes(command), `${p}: ${command}`);
    assert.match(text, /without `--model` the (chat|app) runs on (agy's|its own) default model/i, `${p}: why the pin`);
  }
  assert.doesNotMatch(read("docs/tutorial-first-run.md"), /cd \.\.\/first-run && agy\n/, "the run session starts on the pin");
  assert.doesNotMatch(read("README.md"), /open it again with `agy` in the same folder/);
  assert.doesNotMatch(read("docs/running.md"), /Then open `agy` in the project/);
});

test("interactive is how the harness is used; headless is the cost check", () => {
  const running = read("docs/running.md");
  assert.match(running, /Interactive is how you use the harness/);
  assert.match(running, /Headless is the cost check/);
  for (const p of [...RUN_START_DOCS, "docs/repo-overview.md"]) {
    assert.doesNotMatch(read(p), /build and debug the plugin|run of record|An interactive run has no driver line|The measured runs go through it/, p);
  }
});

test("the start command's reason claims only the model check agy's record supports", () => {
  for (const p of [...RUN_START_DOCS, "docs/troubleshooting.md"]) {
    const text = read(p);
    assert.doesNotMatch(text, /checks it against (the pin|`?gemini-3\.8-flash-high`?)/, `${p}: the record names the model, not the slug`);
    assert.doesNotMatch(text, /the command (the wizard|setup) printed last/, `${p}: the wizard prints the headless line and the re-check after it`);
  }
  const running = read("docs/running.md");
  assert.match(running, /checks the model it ran on against the pin's model/);
  assert.match(running, /A chat started at another effort passes/);
  assert.doesNotMatch(running, /or in the repo root, where the committed mount already applies/);
  assert.match(running, /\[check 19\]\(verification\/p1-agy-runtime\.md\), 2026-10-15/);
  assert.doesNotMatch(running, /\[check 19\]\(verification\/p1-agy-runtime\.md\), pending/);
  const row = read("docs/verification/p1-agy-runtime.md").split("\n").find((l) => l.startsWith("| 19 |"));
  assert.match(row, /\*\*PASS/, "check 19 passed on an interactive --model chat read back from agy's record");
  assert.match(row, /f70d8c75-df7e-49ab-8da8-7d558a6159b5/, "the row names the conversation that proved it");
  assert.match(row, /never the\s+effort/, "the row keeps the effort caveat");
});

test("re-checking a project names it, and a policy change hands over the new start command", () => {
  assert.doesNotMatch(read("INSTALL.md"), /^npm run verify\s+#/m, "npm run verify in the clone checks the clone");
  assert.match(read("INSTALL.md"), /verify-setup\.mjs --project-root "\$\(pwd\)"/);
  for (const p of ["plugin/skills/policy/SKILL.md", "plugin/rules/AGENTS.md"]) {
    assert.ok(read(p).includes('node "${MMO_PLUGIN_ROOT}/agy/start-command.mjs" --project-root "$(pwd)"'), p);
  }
});

test("no doc still calls the headless run unmeasured or the interactive driver free", () => {
  assert.doesNotMatch(read("README.md"), /Has a headless run been done for real\? \| Not yet/);
  assert.match(read("README.md"), /headless-proof-runs-2026-10-14\.md/);
  assert.doesNotMatch(read("docs/understanding-output.md"), /\$0 on an interactive run|`false` on an interactive run/);
  assert.doesNotMatch(read("plugin/skills/setup/SKILL.md"), /for CI or replays/);
  assert.doesNotMatch(read("plugin/skills/pipeline/SKILL.md"), /the measured runs/);
});
