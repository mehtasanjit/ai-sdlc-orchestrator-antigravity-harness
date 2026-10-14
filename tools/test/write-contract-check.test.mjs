/**
 * The agy-edition write-contract hook, driven end to end through stdin with
 * agy-shaped payloads (camelCase, toolCall.name/args) and read back through
 * its stdout reply, which is the wire protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractTargets, extractPathArgs, READ_ONLY_TOOLS, findCredentialLiteral } from "../../plugin/agy/hooks/write-contract-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(ROOT, "plugin", "agy", "hooks", "write-contract-check.mjs");

function repoWithContract(contract) {
  const dir = mkdtempSync(join(tmpdir(), "wc-hook-"));
  mkdirSync(join(dir, ".sdlc", "local"), { recursive: true });
  mkdirSync(join(dir, ".git"));
  if (contract) writeFileSync(join(dir, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  return dir;
}
const CONTRACT = { schema_version: 1, active: true, mode: "brownfield", run_id: "t1", strict: true, allowlist: ["src/**"], off_limits: [".env", ".git/**"] };

function runHook(payload, cwd) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8", cwd });
  return { reply: JSON.parse(r.stdout), stderr: r.stderr, status: r.status };
}

test("extractTargets reads the path-shaped argument of a file tool and the redirect of run_command", () => {
  assert.deepEqual(extractTargets({ toolCall: { name: "code_action", args: { AbsolutePath: "/r/src/a.ts" } } }), ["/r/src/a.ts"]);
  assert.deepEqual(extractTargets({ toolCall: { name: "write_blob", args: { TargetFile: "/r/x", Other: 1 } } }), ["/r/x"]);
  assert.deepEqual(extractTargets({ toolCall: { name: "run_command", args: { CommandLine: "echo hi > out.txt && touch a b" } } }), ["out.txt", "a", "b"]);
  assert.deepEqual(extractTargets({ toolCall: { name: "run_command", args: { CommandLine: "npm test 2>&1" } } }), []);
});

test("read-only step types never yield a write target", () => {
  for (const name of READ_ONLY_TOOLS) {
    assert.deepEqual(extractTargets({ toolCall: { name, args: { AbsolutePath: "/r/.env" } } }), [], name);
  }
  assert.deepEqual(extractPathArgs({ Files: ["a", "b"] }), [], "unknown array keys are not guessed");
});

test("a write inside the allowlist is allowed and recorded", () => {
  const dir = repoWithContract(CONTRACT);
  try {
    const { reply } = runHook({ toolCall: { name: "code_action", args: { AbsolutePath: join(dir, "src", "a.ts") } }, workspacePaths: [dir] }, dir);
    assert.deepEqual(reply, { decision: "allow" });
    const decisions = readFileSync(join(dir, ".sdlc", "local", "guard-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(decisions.at(-1).decision, "allow");
    assert.equal(decisions.at(-1).run_id, "t1", "an allow under a contract names its run, as a refusal does");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a write outside the allowlist is denied with the reason in the reply, and recorded", () => {
  const dir = repoWithContract(CONTRACT);
  try {
    const { reply } = runHook({ toolCall: { name: "propose_code", args: { AbsolutePath: join(dir, "README.md") } }, workspacePaths: [dir] }, dir);
    assert.equal(reply.decision, "deny");
    assert.match(reply.reason, /README\.md is not in the confirmed allowlist for run t1/);
    const decisions = readFileSync(join(dir, ".sdlc", "local", "guard-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(decisions.at(-1).decision, "deny");
    assert.equal(decisions.at(-1).tool_name, "propose_code");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a shell redirect onto an off-limits path is denied", () => {
  const dir = repoWithContract(CONTRACT);
  try {
    const { reply } = runHook({ toolCall: { name: "run_command", args: { CommandLine: "echo KEY=1 > .env" } }, workspacePaths: [dir] }, dir);
    assert.equal(reply.decision, "deny");
    assert.match(reply.reason, /\.env matches always-off-limits/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("strict:false downgrades a denial to an allow with a warning on stderr", () => {
  const dir = repoWithContract({ ...CONTRACT, strict: false });
  try {
    const { reply, stderr } = runHook({ toolCall: { name: "code_action", args: { AbsolutePath: join(dir, "README.md") } }, workspacePaths: [dir] }, dir);
    assert.equal(reply.decision, "allow");
    assert.match(stderr, /WARN/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with no contract, only the hardcoded off-limits net applies to paths", () => {
  const dir = repoWithContract(null);
  try {
    assert.equal(runHook({ toolCall: { name: "code_action", args: { AbsolutePath: join(dir, "anything.md") } }, workspacePaths: [dir] }, dir).reply.decision, "allow");
    const denied = runHook({ toolCall: { name: "code_action", args: { AbsolutePath: join(dir, ".env.production") } }, workspacePaths: [dir] }, dir).reply;
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /always-off-limits/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a cross-repo write is refused as a category error", () => {
  const dir = repoWithContract(CONTRACT);
  const other = mkdtempSync(join(tmpdir(), "wc-other-"));
  try {
    const { reply } = runHook({ toolCall: { name: "code_action", args: { AbsolutePath: join(other, "src", "x.ts") } }, workspacePaths: [dir] }, dir);
    assert.equal(reply.decision, "deny");
    assert.match(reply.reason, /resolves OUTSIDE the project whose contract this session holds/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("garbage on stdin, or a call with no target, fails open", () => {
  const dir = repoWithContract(CONTRACT);
  try {
    const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8", cwd: dir });
    assert.deepEqual(JSON.parse(r.stdout), { decision: "allow" });
    assert.equal(runHook({ toolCall: { name: "finish", args: {} }, workspacePaths: [dir] }, dir).reply.decision, "allow");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Built at runtime so the repo never holds a literal shaped like a real key.
const GOOGLE_KEY = "AIza" + "x".repeat(35);

function decisionsText(dir) {
  return readFileSync(join(dir, ".sdlc", "local", "guard-decisions.jsonl"), "utf8");
}

test("findCredentialLiteral reads new content under any argument key, never the text being replaced", () => {
  const call = (name, args) => ({ toolCall: { name, args } });
  assert.deepEqual(findCredentialLiteral(call("write_to_file", { TargetFile: "/r/a.cjs", CodeContent: `const k = "${GOOGLE_KEY}";` })), { name: "google-api-key", kind: "google" });
  assert.deepEqual(findCredentialLiteral(call("code_action", { AbsolutePath: "/r/a.cjs", Unverified: { Body: GOOGLE_KEY } })), { name: "google-api-key", kind: "google" });
  assert.equal(findCredentialLiteral(call("multi_replace_file_content", {
    TargetFile: "/r/a.cjs",
    ReplacementChunks: [{ TargetContent: `const k = "${GOOGLE_KEY}";`, ReplacementContent: "const k = process.env.GEMINI_API_KEY;" }],
  })), null, "an edit that removes a committed key is not refused");
  assert.equal(findCredentialLiteral(call("view_file", { AbsolutePath: GOOGLE_KEY })), null);
});

test("a write whose content holds a credential literal is denied with or without a contract, and strict:false does not lift it", () => {
  for (const contract of [CONTRACT, { ...CONTRACT, strict: false }, null]) {
    const dir = repoWithContract(contract);
    const pluginDir = mkdtempSync(join(tmpdir(), "wc-plugin-"));
    try {
      const target = join(dir, "src", "dispatch.cjs");
      const payload = { toolCall: { name: "write_to_file", args: { TargetFile: target, CodeContent: `process.env.GEMINI_API_KEY = "${GOOGLE_KEY}";\n` } }, workspacePaths: [dir] };
      const { reply, stderr } = runHook(payload, pluginDir);
      const label = contract ? `strict:${contract.strict}` : "no contract";
      assert.equal(reply.decision, "deny", label);
      assert.match(reply.reason, /google-api-key credential literal \(google\)/, label);
      assert.ok(reply.reason.includes(target), `${label}: the reason names the target`);
      assert.ok(!reply.reason.includes(GOOGLE_KEY) && !stderr.includes(GOOGLE_KEY), `${label}: the key is never echoed`);
      const text = decisionsText(dir);
      assert.ok(!text.includes(GOOGLE_KEY), `${label}: the record never holds the key`);
      const last = text.trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      assert.equal(last.decision, "deny");
      assert.equal(last.matched_rule, "google-api-key");
      assert.equal(last.tool_name, "write_to_file");
      assert.ok(!existsSync(join(pluginDir, ".sdlc")), `${label}: recorded under the workspace, not the hook's cwd`);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(pluginDir, { recursive: true, force: true }); }
  }
});

test("a run_command that echoes or exports a key is denied without echoing it", () => {
  const dir = repoWithContract(null);
  try {
    const echo = runHook({ toolCall: { name: "run_command", args: { CommandLine: `echo GEMINI_API_KEY=${GOOGLE_KEY} > x.cjs` } }, workspacePaths: [dir] }, dir).reply;
    assert.equal(echo.decision, "deny");
    assert.match(echo.reason, /google-api-key credential literal \(google\) into x\.cjs/);
    assert.ok(!echo.reason.includes(GOOGLE_KEY));

    const exported = runHook({ toolCall: { name: "run_command", args: { CommandLine: `export GEMINI_API_KEY=${GOOGLE_KEY} && node dispatch.mjs` } }, workspacePaths: [dir] }, dir).reply;
    assert.equal(exported.decision, "deny");
    assert.match(exported.reason, /into its command line/);
    assert.ok(!exported.reason.includes(GOOGLE_KEY));
    assert.ok(!decisionsText(dir).includes(GOOGLE_KEY));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("content that reads keys from the environment keeps the existing decisions", () => {
  const dir = repoWithContract(CONTRACT);
  try {
    const code = [
      "const apiKey = process.env.GEMINI_API_KEY;",
      "export const env = z.object({ GEMINI_API_KEY: z.string(), DATABASE_URL: z.string().url() });",
    ].join("\n");
    const inScope = runHook({ toolCall: { name: "write_to_file", args: { TargetFile: join(dir, "src", "config.ts"), CodeContent: code } }, workspacePaths: [dir] }, dir).reply;
    assert.deepEqual(inScope, { decision: "allow" });

    const outOfScope = runHook({ toolCall: { name: "write_to_file", args: { TargetFile: join(dir, "README.md"), CodeContent: code } }, workspacePaths: [dir] }, dir).reply;
    assert.equal(outOfScope.decision, "deny");
    assert.match(outOfScope.reason, /README\.md is not in the confirmed allowlist/);

    const shell = runHook({ toolCall: { name: "run_command", args: { CommandLine: 'GEMINI_API_KEY="$GEMINI_API_KEY" node src/dispatch.cjs > src/out.json' } }, workspacePaths: [dir] }, dir).reply;
    assert.deepEqual(shell, { decision: "allow" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the heartbeat hook replies {} and appends a line under the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "plugin", "agy", "hooks", "heartbeat.mjs")], { input: JSON.stringify({ stepIdx: 1, workspacePaths: [dir] }), encoding: "utf8" });
    assert.equal(r.stdout, "{}");
    const line = JSON.parse(readFileSync(join(dir, ".hook-logs", "hook.jsonl"), "utf8").trim());
    assert.equal(line.event, "mcp_tool_postuse");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
