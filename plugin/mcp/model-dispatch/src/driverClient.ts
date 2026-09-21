/**
 * A driver-side MCP client for this server's own tools.
 *
 * The agy conductor calls the bridge's tools directly when its session
 * binds them (docs/verification/p1-agy-runtime.md check 1). When it does
 * not, plugin/agy/dispatch.mjs uses this client to spawn the same server as
 * a stdio subprocess and speak MCP to it with no model in the loop. The
 * five tool names and their argument/result shapes are unchanged.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "server.js");

/**
 * Must exceed the largest `worker_timeout_sec` any shipped policy sets (540s
 * for the agent worker), or the client abandons a call the adapter is still
 * working on. The SDK default is 60s.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 900_000;

export interface BridgeClientOptions {
  /** Override the server entry point — tests point this at a fixture server. */
  serverPath?: string;
  /** Extra environment variables layered onto the spawned server's process.env. */
  env?: Record<string, string>;
  /** Per-call timeout in ms. See DEFAULT_TOOL_TIMEOUT_MS before lowering it. */
  toolTimeoutMs?: number;
}

export interface BridgeClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.[0];
  if (first?.type === "text" && typeof first.text === "string") return first.text;
  return JSON.stringify(result.content ?? null);
}

function parseToolResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // log_telemetry replies with the bare string "ok", not JSON.
    return text;
  }
}

/**
 * Can this process start a child it can TALK to? `stdio: "pipe"` is the
 * point: a sandbox that allows children but denies piped stdio kills the
 * transport at birth, and the SDK reports only `Connection closed`.
 */
export function canSpawnChildProcess(run = spawnSync): { ok: boolean; code: string | null } {
  const probe = run(process.execPath, ["-e", ""], { stdio: "pipe" });
  const code = (probe as { error?: NodeJS.ErrnoException }).error?.code ?? null;
  return { ok: !code, code };
}

export function diagnoseConnectFailure(
  err: unknown,
  probe: () => { ok: boolean; code: string | null } = canSpawnChildProcess,
): string {
  const original = err instanceof Error ? err.message : String(err);
  const spawnable = probe();
  if (spawnable.ok) return original;

  return (
    `${original}\n\n` +
    `This process cannot open pipes to a child process (${spawnable.code}), and the bridge is ` +
    `reached over exactly those pipes — so the server never started. It is not crashed, missing ` +
    `or unbuilt.\n\n` +
    `agy's terminal sandbox (\`--sandbox\`, or enableTerminalSandbox in its settings) is the usual ` +
    `cause. Start agy without --sandbox, or run the pipeline headlessly, where the launcher spawns ` +
    `agy outside any sandbox:\n` +
    `      node plugin/agy/run.mjs --brief=<file> --project-root="$(pwd)" --output-dir="$(pwd)/.sdlc"`
  );
}

export async function connectBridge(options: BridgeClientOptions = {}): Promise<BridgeClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverPath ?? DEFAULT_SERVER_ENTRY],
    env: options.env
      ? ({ ...(process.env as Record<string, string>), ...options.env })
      : (process.env as Record<string, string>),
  });

  const client = new Client({ name: "agy-driver", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(diagnoseConnectFailure(err));
  }

  const timeout = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return {
    async callTool(name: string, args: Record<string, unknown>) {
      let result;
      try {
        result = await client.callTool({ name, arguments: args }, undefined, { timeout });
      } catch (err) {
        throw new Error(diagnoseConnectFailure(err));
      }
      const text = extractText(result as any);
      if ((result as any).isError) {
        throw new Error(`bridge tool '${name}' returned an error: ${text}`);
      }
      return parseToolResult(text);
    },
    async close() {
      await client.close();
    },
  };
}
