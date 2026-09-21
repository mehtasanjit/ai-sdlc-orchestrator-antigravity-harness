#!/usr/bin/env node
/**
 * PostToolUse heartbeat for bridge calls. The bridge writes the full
 * telemetry itself; this records that an MCP tool ran, for cross-checking,
 * in `<workspace>/.hook-logs/hook.jsonl`. Always replies `{}`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  try {
    let workspace = process.cwd();
    let error = null;
    try {
      const payload = JSON.parse(buf);
      if (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) workspace = payload.workspacePaths[0];
      error = payload.error ?? null;
    } catch {
      /* unparseable payload still gets a heartbeat */
    }
    const dir = join(workspace, ".hook-logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "hook.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), event: "mcp_tool_postuse", payload_bytes: Buffer.byteLength(buf), error }) + "\n",
    );
  } catch {
    /* best-effort */
  }
  process.stdout.write("{}");
});
setTimeout(() => { process.stdout.write("{}"); process.exit(0); }, 1500).unref();
