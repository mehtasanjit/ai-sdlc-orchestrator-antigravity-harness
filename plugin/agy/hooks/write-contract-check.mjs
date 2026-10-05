#!/usr/bin/env node
/**
 * Brownfield write-contract PreToolUse hook — agy edition.
 *
 * Refuses file writes outside the confirmed allowlist when brownfield mode is
 * active; silent allow when no active contract exists. Contract file:
 * <repo-root>/.sdlc/local/write-contract.json.
 *
 * agy's hook contract (docs/verification/p1-agy-runtime.md check 13): stdin is
 * `{ toolCall: { name, args }, workspacePaths, ... }` in camelCase, and the
 * reply is `{ "decision": "allow" | "deny", "reason" }` on stdout. Exit code
 * is not the wire protocol. Which step type carries a file write in the CLI
 * is a live check, so every path-shaped argument is inspected and
 * `run_command` gets the shell-redirect heuristics.
 *
 * Before any path check, the content a call would write is scanned for
 * credential literals; a hit is denied with or without a contract, and
 * regardless of `strict`.
 *
 * Fail-open: any bug here must not block user work. Denials are recorded to
 * `.sdlc/local/guard-decisions.jsonl` because the stream-json output does not
 * show them.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, sep, dirname, isAbsolute, join, basename } from "node:path";
import { HARDCODED_OFF_LIMITS } from "../../scripts/lib/off-limits.mjs";
import { log, redactText } from "../../scripts/lib/log.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";
import { scan } from "../../scripts/dispatch-sanitize.mjs";

const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";
const GUARD_DECISIONS_REL_PATH = ".sdlc/local/guard-decisions.jsonl";

async function readStdinJson() {
  return await new Promise((resolveP) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => {
      try {
        resolveP(JSON.parse(buf));
      } catch {
        resolveP(null);
      }
    });
    // Some environments never close stdin; give up after a short beat and allow.
    setTimeout(() => resolveP(null), 1500).unref();
  });
}

/**
 * Walk from `start` up the filesystem until we find a directory containing
 * the given relative path. Returns the absolute contract path if found, else null.
 * Bounded to avoid pathological loops on unusual filesystems.
 */
function findContractPath(start) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    const candidate = resolve(dir, CONTRACT_REL_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Repo-relative path resolution + escape detection. Returns `{ rel, escapes }`
 * where `escapes: true` means the target resolves OUTSIDE the contract's repo
 * root. An escape is a category error — the run is trying to write outside
 * its own project — and gets a distinct deny message.
 */
function toRepoRelative(target, contractPath) {
  const repoRoot = resolve(contractPath, "..", "..", ".."); // .sdlc/local/write-contract.json → repo root
  const abs = resolve(repoRoot, target);
  let rel = relative(repoRoot, abs);
  if (sep !== "/") rel = rel.split(sep).join("/");
  return { rel, escapes: rel.startsWith("../") || rel === ".." };
}

/**
 * Minimal glob matcher. Supports:
 *   `**` — any characters including `/`
 *   `*`  — any characters except `/`
 *   `?`  — any single character except `/`
 *   Literal `/` and other characters.
 * No brace expansion, no character classes, no negation. That's enough for
 * repo scope patterns like `src/**`, `docs/*.md`, `apps/api/**`, `.env`.
 */
function matchGlob(path, pattern) {
  if (path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

function matchesAtAnyDepth(target, pattern) {
  if (matchGlob(target, pattern)) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern);
}

function firstMatch(path, patterns) {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) {
    if (typeof p === "string" && matchGlob(path, p)) return p;
  }
  return null;
}

function readContractSafe(path) {
  try {
    const st = statSync(path);
    if (st.size > 128 * 1024) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * `run_command`'s `CommandLine` is a shell command line. Full shell parsing
 * is out of scope (same tradeoff the source's own glob matcher documents for
 * itself); this catches the common, unambiguous write shapes — redirects,
 * `tee`, `touch`, `cp`, and `mv` (destination only) — which cover the
 * overwhelming majority of file-creating shell commands. A command this
 * misses fails open (allowed), consistent with the fail-safe philosophy:
 * this heuristic is a real backstop, not a claim of exhaustive shell
 * parsing.
 */
function extractBashRedirectTargets(command) {
  if (typeof command !== "string") return [];
  const targets = [];
  // `>` / `>>`, optionally preceded by a file-descriptor number, not
  // preceded by `<`, `2`, or another `>` (so `2>&1` and `>>` are not double-
  // matched as two separate single-`>` redirects).
  const redirectRe = /(?:^|[\s;&|(])\d*>{1,2}\s*([^\s;&|()<>]+)/g;
  let m;
  while ((m = redirectRe.exec(command)) !== null) {
    const target = m[1].trim();
    // `&1`, `&2` etc. are fd duplications, not file targets.
    if (target && !/^&\d+$/.test(target)) targets.push(target);
  }
  const teeRe = /\btee\b\s+(?:-a\s+)?([^\s;&|()<>-][^\s;&|()<>]*)/g;
  while ((m = teeRe.exec(command)) !== null) {
    if (m[1]) targets.push(m[1].trim());
  }
  // `touch a b c` — every argument is a file it creates or updates.
  const touchRe = /\btouch\s+((?:-[a-zA-Z]+\s+)*(?:[^\s;&|()<>-][^\s;&|()<>]*\s*)+)/g;
  while ((m = touchRe.exec(command)) !== null) {
    for (const arg of m[1].trim().split(/\s+/)) if (arg) targets.push(arg);
  }
  // `cp [-flags] src... dest` / `mv [-flags] src dest` — only the last
  // (non-flag) argument is a write target; earlier ones are read, not
  // written. A trailing `/` dest (copy-into-directory) is intentionally
  // excluded — the actual created file's name isn't determined here, and
  // the directory itself is the more useful thing to gate at that point.
  const cpMvRe = /\b(?:cp|mv)\s+((?:-[a-zA-Z]+\s+)*(?:[^\s;&|()<>-][^\s;&|()<>]*\s*)+)/g;
  while ((m = cpMvRe.exec(command)) !== null) {
    const args = m[1].trim().split(/\s+/).filter(Boolean);
    const dest = args[args.length - 1];
    if (dest && !dest.endsWith("/")) targets.push(dest);
  }
  return targets;
}

// ── agy-specific: target extraction ─────────────────────────────────────

/** Argument keys agy's file tools are known or expected to carry a path under. */
export const PATH_ARG_KEYS = [
  "AbsolutePath", "TargetFile", "FilePath", "Path", "File",
  "absolute_path", "target_file", "file_path", "path", "file",
];

export function extractPathArgs(args) {
  if (!args || typeof args !== "object") return [];
  const targets = [];
  for (const key of PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) targets.push(v.trim());
    else if (Array.isArray(v)) for (const item of v) if (typeof item === "string" && item.trim()) targets.push(item.trim());
  }
  return targets;
}

/** Step types that only read. A path argument on these is never a write target. */
export const READ_ONLY_TOOLS = new Set([
  "view_file", "view_code_item", "grep_search", "find_by_name", "list_directory",
  "read_url_content", "search_web", "view_file_outline",
]);

export function extractTargets(call) {
  const name = call?.toolCall?.name ?? call?.tool_name;
  const args = call?.toolCall?.args ?? call?.tool_input ?? {};
  if (name === "run_command") return extractBashRedirectTargets(args.CommandLine ?? args.command);
  if (READ_ONLY_TOOLS.has(name)) return [];
  return extractPathArgs(args);
}

// ── credential literals in what a call would write ──────────────────────

/**
 * Keys holding text a replace expects to find already on disk. Scanning them
 * would refuse the very edit that removes a committed key.
 */
export const EXISTING_TEXT_ARG_KEYS = new Set(["TargetContent", "target_content", "old_string"]);

/**
 * `KEY=value` with any value also matches `process.env.X`, `$X` and a config
 * schema line like `DATABASE_URL: z.string()`, which written code must carry.
 */
const PROMPT_ONLY_PATTERNS = new Set(["sensitive-env-assignment"]);

/**
 * Every string argument except the text being replaced: which key carries
 * the new content on `code_action` / `propose_code` / `file_change` /
 * `write_blob` is unverified (check 13), so none is assumed.
 */
export function extractWrittenText(call) {
  const name = call?.toolCall?.name ?? call?.tool_name;
  const args = call?.toolCall?.args ?? call?.tool_input ?? {};
  if (name === "run_command") {
    const line = args.CommandLine ?? args.command;
    return typeof line === "string" ? [line] : [];
  }
  if (READ_ONLY_TOOLS.has(name)) return [];
  const out = [];
  const walk = (v, depth) => {
    if (depth > 8) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
    else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) if (!EXISTING_TEXT_ARG_KEYS.has(k)) walk(item, depth + 1);
    }
  };
  walk(args, 0);
  return out;
}

/** The first credential finding as `{ name, kind }` — never the matched text. */
export function findCredentialLiteral(call) {
  for (const text of extractWrittenText(call)) {
    const hit = scan(text).find((f) => !PROMPT_ONLY_PATTERNS.has(f.name));
    if (hit) return { name: hit.name, kind: hit.kind };
  }
  return null;
}

function callCwd(call) {
  const ws = Array.isArray(call?.workspacePaths) ? call.workspacePaths[0] : undefined;
  if (typeof ws === "string" && ws) return ws;
  if (typeof call?.cwd === "string") return call.cwd;
  return process.cwd();
}

// ── D3: guard-decisions sidecar — the only record a denial leaves ──

async function recordDecision(contractPath, decision, fallbackRoot) {
  try {
    const repoRoot = contractPath ? resolve(contractPath, "..", "..", "..") : (fallbackRoot ?? process.cwd());
    const sidecarPath = join(repoRoot, GUARD_DECISIONS_REL_PATH);
    await mkdir(dirname(sidecarPath), { recursive: true });
    await appendFile(sidecarPath, JSON.stringify({ ts: new Date().toISOString(), ...decision }) + "\n");
  } catch {
    // Sidecar writes are best-effort — never let a logging failure affect
    // the actual allow/deny decision or hang the hook.
  }
}

function reply(decision, reason) {
  const out = { decision };
  if (reason) out.reason = reason;
  process.stdout.write(JSON.stringify(out));
}

async function allow(msg, ctx = {}) {
  if (msg && process.env.MMO_DEBUG === "1") {
    console.error(`[mmo-brownfield write-contract] ALLOW: ${msg}`);
  }
  log("debug", "write.allow", { run_id: ctx.runId, path: ctx.path, matched_rule: ctx.matchedRule });
  await recordDecision(ctx.contractPath, { decision: "allow", reason: msg, path: ctx.path, run_id: ctx.runId, matched_rule: ctx.matchedRule });
  reply("allow");
  process.exit(0);
}

async function deny(msg, ctx = {}) {
  console.error(`[mmo-brownfield write-contract] DENY: ${msg}`);
  log("warn", "write.deny", {
    run_id: ctx.runId,
    path: ctx.path,
    matched_off_limits_rule: ctx.matchedRule,
    strict: ctx.strict,
  });
  await recordDecision(ctx.contractPath, {
    decision: "deny",
    reason: msg,
    path: ctx.path,
    run_id: ctx.runId,
    matched_rule: ctx.matchedRule,
    tool_name: ctx.toolName,
  }, ctx.recordRoot);
  reply("deny", msg);
  process.exit(0);
}

async function main() {
  const call = await readStdinJson();
  if (!call || typeof call !== "object") return allow("no parseable tool call on stdin");

  const toolName = call?.toolCall?.name ?? call?.tool_name;
  const targets = extractTargets(call);

  const credential = findCredentialLiteral(call);
  if (credential) {
    const cwd = callCwd(call);
    const contractPath = findContractPath(cwd);
    // A path argument could itself hold the secret; the reason must never echo it.
    const path = targets.length ? redactText(targets.join(", ")) : undefined;
    const where = path ?? (toolName === "run_command" ? "its command line" : "its target");
    return deny(
      `${toolName ?? "this tool call"} would write a ${credential.name} credential literal (${credential.kind}) into ${where}. ` +
        `A key is never written into a file or a command line: read it from the environment the session ` +
        `was launched with (process.env.GEMINI_API_KEY, $GEMINI_API_KEY) and re-issue the call without the value.`,
      {
        contractPath,
        recordRoot: cwd,
        path,
        matchedRule: credential.name,
        runId: contractPath ? readContractSafe(contractPath)?.run_id : undefined,
        toolName,
      },
    );
  }

  if (targets.length === 0) return allow("no write target extracted from this tool call");

  for (const target of targets) {
    const verdict = await checkOneTarget(target, call);
    if (verdict.deny) return deny(verdict.msg, { ...verdict.ctx, toolName });
  }
  return allow(`all ${targets.length} target(s) cleared`, { contractPath: findContractPath(callCwd(call)) });
}

/** Returns { deny: boolean, msg?, ctx? } for a single candidate path. */
async function checkOneTarget(target, call) {
  const cwd = callCwd(call);
  const absTarget = isAbsolute(target) ? target : resolve(cwd, target);
  const targetNorm = absTarget.split(sep).join("/");

  const cwdContractPath = findContractPath(cwd);
  const cwdContract = cwdContractPath ? readContractSafe(cwdContractPath) : null;

  if (cwdContract && cwdContract.active === true) {
    const cwdRepoRoot = resolve(cwdContractPath, "..", "..", "..");
    const cwdRel = relative(cwdRepoRoot, absTarget).split(sep).join("/");
    if (cwdRel.startsWith("../") || cwdRel === "..") {
      const targetContract = findContractPath(dirname(absTarget));
      return {
        deny: true,
        msg:
          `${absTarget} resolves OUTSIDE the calling session's contracted repo ` +
          `(${cwdRepoRoot}). Cross-project writes are refused — a brownfield ` +
          `run can only write inside the repo whose contract it holds.` +
          (targetContract ? ` (Target has its own contract at ${targetContract}; ` +
            `run against that project explicitly if you meant to edit it.)` : ""),
        ctx: { contractPath: cwdContractPath, path: absTarget, runId: cwdContract.run_id },
      };
    }
  }

  const contractPath = findContractPath(dirname(absTarget)) ?? cwdContractPath;

  if (!contractPath) {
    // The greenfield test fixture, and only that.
    //
    // The pipeline's test phase must bootstrap an `.env` before `npm test`,
    // for an app whose codegen produced a validating config module — it
    // copies the run's own `.env.test` across. The blanket `.env` rule
    // refused it, so the Workforce Ops reference run silently skipped build,
    // E2E and startup verification and said so in its final report. The
    // harness was forbidding a write it also instructs.
    //
    // Narrow on purpose. Everything the `.env` rule exists to protect still
    // holds:
    //   - an EXISTING .env is never touched, so real secrets cannot be
    //     overwritten — this only permits creating one that is not there;
    //   - brownfield is unaffected, because that path has a contract and
    //     never reaches this pre-contract branch at all (and its own test
    //     phase refuses the copy outright);
    //   - `.env.*` variants stay blocked, so `.env.production` and friends
    //     are still refused.
    // The residue is a greenfield run creating a throwaway fixture inside
    // the tree it just generated, which belongs to nobody else.
    if (basename(targetNorm) === ".env" && !existsSync(absTarget)) {
      return { deny: false };
    }

    const preHit = HARDCODED_OFF_LIMITS.find((p) => matchesAtAnyDepth(targetNorm, p));
    if (preHit) {
      return {
        deny: true,
        msg:
          `${target} matches always-off-limits pattern "${preHit}" (no active brownfield contract; ` +
          `this is the pre-contract safety net for credentials, MCP config, other-AI-tool state, ` +
          `and plugin bookkeeping). If this write is legitimate, establish an explicit contract ` +
          `first, then re-issue.`,
        ctx: { contractPath: null, path: targetNorm, matchedRule: preHit },
      };
    }
    return { deny: false };
  }

  try {
    const st = statSync(contractPath);
    if (st.size > 128 * 1024) return { deny: false };
  } catch {
    return { deny: false };
  }

  let contract;
  try {
    contract = JSON.parse(await readFile(contractPath, "utf8"));
  } catch {
    return { deny: false };
  }

  if (!contract || contract.active !== true) return { deny: false };

  const { rel } = toRepoRelative(target, contractPath);

  const offHit = firstMatch(rel, contract.off_limits);
  if (offHit) {
    if (contract.strict === false) {
      console.error(
        `[mmo-brownfield write-contract] WARN: ${rel} matches off-limits pattern "${offHit}". Allowed because contract.strict = false.`
      );
      return { deny: false };
    }
    return {
      deny: true,
      msg:
        `${rel} matches off-limits pattern "${offHit}" (run ${contract.run_id ?? "?"}). ` +
        `Re-open Gate 0 to move this path out of off-limits, or set contract.strict = false ` +
        `(equivalent to --strict-write=off) to bypass.`,
      ctx: { contractPath, path: rel, matchedRule: offHit, runId: contract.run_id, strict: contract.strict },
    };
  }

  const allowHit = firstMatch(rel, contract.allowlist);
  if (allowHit) return { deny: false };

  if (contract.strict === false) {
    console.error(
      `[mmo-brownfield write-contract] WARN: ${rel} is not in the confirmed allowlist. Allowed because contract.strict = false.`
    );
    return { deny: false };
  }
  return {
    deny: true,
    msg:
      `${rel} is not in the confirmed allowlist for run ${contract.run_id ?? "?"}. ` +
      `Re-open Gate 0 to expand scope to include this path, or set contract.strict = false ` +
      `(equivalent to --strict-write=off) to bypass.`,
    ctx: { contractPath, path: rel, runId: contract.run_id, strict: contract.strict },
  };
}

if (isMain(import.meta.url)) {
  main().catch(async (e) => {
    if (process.env.MMO_DEBUG === "1") console.error(`[mmo-brownfield write-contract] unhandled: ${e?.message ?? e}`);
    reply("allow");
    process.exit(0);
  });
}
