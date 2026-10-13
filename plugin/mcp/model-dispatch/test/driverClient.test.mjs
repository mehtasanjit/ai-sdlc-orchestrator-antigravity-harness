/**
 * Live reachability test for the driver-side MCP client — spawns the REAL
 * built dist/server.js as a subprocess and calls real tools over the MCP
 * wire protocol. This is the dispatch fallback (plugin/agy/dispatch.mjs)
 * proven end to end without a model in the loop.
 *
 * Only load_policy and preflight_dispatch are exercised — both make zero
 * vendor API calls, so this stays offline and free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { connectBridge, DEFAULT_TOOL_TIMEOUT_MS, canSpawnChildProcess, diagnoseConnectFailure } from "../dist/driverClient.js";
import { DEFAULT_AGENT_SDK_TIMEOUT_SEC } from "../dist/adapters/ClaudeAgentSdkAdapter.js";
import { DEFAULT_WORKER_TIMEOUT_SEC } from "../dist/delegation/workerProcess.js";

const POLICY = "antigravity-flash38-plus-opus5";

test("load_policy reaches the real server and returns the official antigravity policy", async () => {
  const bridge = await connectBridge();
  try {
    const policy = await bridge.callTool("load_policy", { policy_name: POLICY });
    assert.equal(policy.name, POLICY);
    assert.equal(policy.version, 1);
    assert.ok(
      policy.models.some((m) => m.adapter === "claude-agent-sdk"),
      "policy names the claude-agent-sdk adapter — the judgment tier's transport since the Agent SDK port",
    );
  } finally {
    await bridge.close();
  }
});

test("preflight_dispatch reaches the real server and reports on every model without dispatching", async () => {
  const bridge = await connectBridge({ env: { ANTHROPIC_API_KEY: "sk-ant-test-dummy", GEMINI_API_KEY: "AIza-test-dummy" } });
  try {
    const result = await bridge.callTool("preflight_dispatch", { auth_mode: "vendor", policy_name: POLICY });
    assert.equal(typeof result.ok, "boolean");
    assert.ok(Array.isArray(result.models) && result.models.length > 0);
    assert.ok(result.models.some((m) => m.id === "opus"), "the judgment worker is assessed");
  } finally {
    await bridge.close();
  }
});

test("an unreachable server rejects connect() instead of hanging forever", async () => {
  await assert.rejects(() => connectBridge({ serverPath: "/nonexistent/path/to/server.js" }));
});

test("the client's per-call timeout exceeds every shipped policy's worker timeout", () => {
  const policyDir = new URL("../../../config/policies/", import.meta.url);
  const files = readdirSync(policyDir).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length > 0);
  let worst = 0;
  for (const file of files) {
    const text = readFileSync(new URL(file, policyDir), "utf8");
    for (const m of text.matchAll(/worker_timeout_sec:\s*(\d+)/g)) worst = Math.max(worst, Number(m[1]));
  }
  assert.ok(worst > 0, "at least one policy should set worker_timeout_sec");
  assert.ok(DEFAULT_TOOL_TIMEOUT_MS > worst * 1000, `client timeout ${DEFAULT_TOOL_TIMEOUT_MS}ms must exceed ${worst}s`);
});

test("the client's per-call timeout exceeds every adapter's built-in deadline", () => {
  for (const [name, sec] of Object.entries({
    DEFAULT_AGENT_SDK_TIMEOUT_SEC,
    DEFAULT_WORKER_TIMEOUT_SEC,
  })) {
    assert.ok(DEFAULT_TOOL_TIMEOUT_MS > sec * 1000, `client timeout ${DEFAULT_TOOL_TIMEOUT_MS}ms must exceed ${name}=${sec}s`);
  }
});

test("callTool passes an explicit timeout rather than inheriting the SDK default", () => {
  const src = readFileSync(new URL("../src/driverClient.ts", import.meta.url), "utf8");
  assert.match(src, /callTool\(\s*\{[^}]*\}\s*,\s*undefined\s*,\s*\{\s*timeout\s*\}/s);
});

test("the spawn probe uses piped stdio", () => {
  const calls = [];
  canSpawnChildProcess((cmd, args, opts) => { calls.push(opts); return {}; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdio, "pipe");
});

test("a connect failure on a machine that CAN pipe is passed through untouched", () => {
  assert.equal(diagnoseConnectFailure(new Error("boom"), () => ({ ok: true, code: null })), "boom");
});

test("a connect failure on a machine that cannot pipe names the cause and the headless way out", () => {
  const msg = diagnoseConnectFailure(new Error("MCP error -32000: Connection closed"), () => ({ ok: false, code: "EPERM" }));
  assert.match(msg, /MCP error -32000: Connection closed/);
  assert.match(msg, /EPERM/);
  assert.match(msg, /--sandbox/);
  assert.match(msg, /plugin\/agy\/run\.mjs/);
});
