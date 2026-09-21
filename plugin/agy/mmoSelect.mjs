/**
 * Project-local MMO_SELECT persistence.
 *
 * File: <projectRoot>/.sdlc/local/mmo-select.json — the same directory as
 * write-contract.json (per-run, gitignored local state). The dispatch
 * fallback folds its value into the env it hands `connectBridge()`; the
 * MCP path reads MMO_SELECT from the shell that launched agy instead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

function selectFilePath(projectRoot) {
  return join(projectRoot, ".sdlc", "local", "mmo-select.json");
}

/**
 * Returns the stored MMO_SELECT spec string, or undefined if no file
 * exists, the file doesn't parse, or it carries no usable value. Fails
 * open like every other check in this harness — a corrupt file must not
 * block a run, only lose the selection it would have carried.
 */
export function readMmoSelectFile(projectRoot) {
  const path = selectFilePath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const spec = parsed?.mmo_select;
    return typeof spec === "string" && spec.trim() ? spec.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the spec, or deletes the file entirely when `spec` is falsy/empty
 * — "empty and absent must behave identically" (the same invariant the
 * source's settings-file version of this enforces). Returns the path
 * written to (even when deleting), for the caller's confirmation message.
 */
export function writeMmoSelectFile(projectRoot, spec) {
  const path = selectFilePath(projectRoot);
  if (!spec || !spec.trim()) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort — an unwritable .sdlc/local/ shouldn't crash the caller;
      // the caller already validated pairs upstream in enableAgentPath.
    }
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mmo_select: spec }, null, 2) + "\n", "utf-8");
  return path;
}
