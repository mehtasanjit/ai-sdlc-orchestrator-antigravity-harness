#!/usr/bin/env node
/**
 * Brownfield write-contract PreToolUse hook — agy edition.
 *
 * Refuses file writes outside the confirmed allowlist, to an artifact a gate
 * approved, and to a conditional file Gate 0 has not opened, while a
 * brownfield run's contract binds (plugin/scripts/lib/contract-state.mjs: the
 * contract at the target's git root, its run not ended, its bytes still those
 * Gate 0 froze); with none binding, only the always-off-limits list is refused.
 * docs/brownfield-write-contract.md states the rules in order.
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

import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { resolve, relative, sep, dirname, isAbsolute, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { HARDCODED_OFF_LIMITS } from "../../scripts/lib/off-limits.mjs";
import { CONTRACT_REL_PATH, GUARD_DECISIONS_REL_PATH, contractState, endRelPath, gitRoot, lockRelPath } from "../../scripts/lib/contract-state.mjs";
import { testRecordRelPath } from "../../scripts/lib/test-record.mjs";
import { approvalState, conditionalApprovals, gatesRelPath, readGateLines } from "../../scripts/lib/gate-record.mjs";
import { log, redactText } from "../../scripts/lib/log.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";
import { scan } from "../../scripts/dispatch-sanitize.mjs";

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
 * Minimal glob matcher. Supports:
 *   `**` — any characters including `/`
 *   `*`  — any characters except `/`
 *   `?`  — any single character except `/`
 *   Literal `/` and other characters.
 * No brace expansion, no character classes, no negation. That's enough for
 * repo scope patterns like `src/**`, `docs/*.md`, `apps/api/**`, `.env`.
 */
/**
 * Off-limits patterns match in any letter case: on macOS's default disk
 * `.ENV` is the same file as `.env`. The allowlist matches exactly, the
 * stricter way for a list that grants.
 */
export function matchGlob(path, pattern, { anyCase = false } = {}) {
  if (path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`, anyCase ? "i" : "").test(path);
}

function matchesAtAnyDepth(target, pattern) {
  if (matchGlob(target, pattern, { anyCase: true })) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern, { anyCase: true });
}

function firstMatch(path, patterns, opts) {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) {
    if (typeof p === "string" && matchGlob(path, p, opts)) return p;
  }
  return null;
}

const toPosix = (p) => (sep === "/" ? p : p.split(sep).join("/"));

/** `rel` of `abs` under `root`, or null when it lies outside. */
function relUnder(root, abs) {
  const rel = toPosix(relative(root, abs));
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? null : rel;
}

/**
 * Where a path leads once links are followed: the real path of its nearest
 * existing ancestor, with the rest of the path appended.
 */
export function realTarget(abs) {
  let head = abs;
  const rest = [];
  for (let i = 0; i < 256; i++) {
    try {
      return join(realpathSync(head), ...rest.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      rest.push(basename(head));
      head = parent;
    }
  }
  return abs;
}

function realRoot(root) {
  try { return realpathSync(root); } catch { return root; }
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
  targets.push(...scriptWriteTargets(command).targets);
  return targets;
}

const Q = "['\"`]";
const LIT = `\\\\?(${Q})([^'"\`$\\\\]+)\\\\?\\1`;
const FS = "(?:fs|fsp|promises)\\.";
const SCRIPT_WRITES = [
  new RegExp(`\\b(?:writeFileSync|appendFileSync|createWriteStream|${FS}(?:writeFile|appendFile))\\(\\s*${LIT}`, "g"),
  new RegExp(`\\b(?:copyFileSync|renameSync|cpSync|${FS}(?:copyFile|rename|cp))\\(\\s*\\\\?${Q}[^'"\`]*\\\\?${Q}\\s*,\\s*${LIT}`, "g"),
  new RegExp(`\\bopen\\(\\s*${LIT}\\s*,\\s*['"][rb]*[wax]`, "g"),
  new RegExp(`\\bPath\\(\\s*${LIT}\\s*\\)\\.write_(?:text|bytes)\\(`, "g"),
];
const SCRIPT_WRITE_CALLS = new RegExp(
  `\\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|cpSync|${FS}(?:writeFile|appendFile|copyFile|rename|cp))\\(` +
    `|\\bopen\\([^)]*,\\s*['"][rb]*[wax]|\\.write_(?:text|bytes)\\(`,
  "g",
);

/**
 * The literal paths an inline script (`node -e`, `python -c`) writes through
 * node's fs or python's open() and Path. `unresolved` counts the write calls
 * whose target is not a literal, which no hook can judge.
 */
export function scriptWriteTargets(command) {
  if (typeof command !== "string") return { targets: [], unresolved: 0 };
  const targets = [];
  for (const re of SCRIPT_WRITES) for (const m of command.matchAll(re)) targets.push(m[m.length - 1]);
  const calls = (command.match(SCRIPT_WRITE_CALLS) ?? []).length;
  return { targets, unresolved: Math.max(0, calls - targets.length) };
}

export const INSTALL_OUTPUT = "node_modules/.package-lock.json";
const INSTALL_RE = /(?:^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(install|i|ci|add|update|up|upgrade|remove|rm|uninstall|un)\b/g;
// `2>&1` and `&>log` are redirects, not the end of the command.
const COMMAND_END = /;|\n|\|\|?|&&|(?<![>&])&(?!>)|[()]/;
const REDIRECT = /(?:\d*|&)(?:>>?|<)&?\s*\S+/g;
const LOCKFILES = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: "bun.lockb" };
const INSTALL_LOCKFILES = new Set(Object.values(LOCKFILES));
const KEEPS_LOCKFILE = /^(?:--no-package-lock|--package-lock=false|--frozen-lockfile|--immutable)$/;

/** The words of one package-manager command after its subcommand, redirects aside. */
function installWords(command, match) {
  const rest = command.slice(match.index + match[0].length);
  const end = rest.search(COMMAND_END);
  return (end === -1 ? rest : rest.slice(0, end)).replace(REDIRECT, " ").trim().split(/\s+/).filter(Boolean);
}

/**
 * What a package manager writes, relative to the project it runs in.
 * `output` is the install's own: node_modules/, and the lockfile unless the
 * command keeps it as it is. `manifest` is package.json, for every command
 * except the project's own install (`ci`, or `install` naming no package).
 */
export function packageInstallTargets(command) {
  const output = new Set();
  const manifest = new Set();
  if (typeof command !== "string") return { output: [], manifest: [] };
  for (const match of command.matchAll(INSTALL_RE)) {
    const [, tool, sub] = match;
    const words = installWords(command, match);
    output.add(INSTALL_OUTPUT);
    if (sub !== "ci" && !words.some((w) => KEEPS_LOCKFILE.test(w))) output.add(LOCKFILES[tool]);
    const own = sub === "ci" || ((sub === "install" || sub === "i") && words.every((w) => w.startsWith("-")));
    if (!own) manifest.add("package.json");
  }
  return { output: [...output], manifest: [...manifest] };
}

const PROSE_FLAG = /--(?:reason|needs|reply|condition)(?:=|\s+)(?=['"])/y;

/** Index of the quote that closes the one at `open`, or -1. */
function closingQuote(s, open) {
  for (let j = open + 1; j < s.length; j++) {
    if (s[open] === '"' && s[j] === "\\") j++;
    else if (s[j] === s[open]) return j;
  }
  return -1;
}

/**
 * The command line with the quoted values of --reason, --needs, --reply and
 * --condition emptied: a stop record's prose names commands (npm install
 * express) it never runs, and a gate reply quotes the person. A
 * double-quoted value the shell expands ($, `, \) is kept, and so is a flag
 * inside another quoted string.
 */
export function withoutProse(command) {
  if (typeof command !== "string") return command;
  let out = "";
  for (let i = 0; i < command.length; ) {
    PROSE_FLAG.lastIndex = i;
    const flag = (i === 0 || /\s/.test(command[i - 1])) && PROSE_FLAG.exec(command);
    if (flag) {
      const open = i + flag[0].length;
      const close = closingQuote(command, open);
      const inert = close !== -1 && (command[open] === "'" || !/[$`\\]/.test(command.slice(open + 1, close)));
      if (inert && /^[\s;&|)]?$/.test(command[close + 1] ?? "")) {
        out += flag[0] + command[open] + command[open];
        i = close + 1;
        continue;
      }
    }
    const c = command[i];
    const last = c === "'" || c === '"' ? closingQuote(command, i) : c === "\\" ? i + 1 : i;
    if (last === -1) return out + command.slice(i);
    out += command.slice(i, last + 1);
    i = last + 1;
  }
  return out;
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
  if (name === "run_command") return extractBashRedirectTargets(withoutProse(args.CommandLine ?? args.command));
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

/** The git projects of the call's workspace whose contract binds, with that state. */
function bindingRoots(call) {
  const roots = new Set([callCwd(call), ...(Array.isArray(call?.workspacePaths) ? call.workspacePaths : [])].map((p) => (typeof p === "string" ? gitRoot(p) : null)).filter(Boolean));
  return [...roots].map((root) => ({ root, state: contractState(root) })).filter(({ state }) => state.binding);
}

function callCwd(call) {
  const ws = Array.isArray(call?.workspacePaths) ? call.workspacePaths[0] : undefined;
  if (typeof ws === "string" && ws) return ws;
  if (typeof call?.cwd === "string") return call.cwd;
  return process.cwd();
}

// ── D3: guard-decisions sidecar — the only record a denial leaves ──

async function recordDecision(repoRoot, decision, fallbackRoot) {
  try {
    const sidecarPath = join(repoRoot ?? fallbackRoot ?? process.cwd(), GUARD_DECISIONS_REL_PATH);
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
  await recordDecision(ctx.root, { decision: "allow", reason: msg, path: ctx.path, ...(ctx.paths ? { paths: ctx.paths } : {}), run_id: ctx.runId, matched_rule: ctx.matchedRule });
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
  await recordDecision(ctx.root, {
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
  const targets = [...extractTargets(call)];
  const installTargets = [];

  const credential = findCredentialLiteral(call);
  if (credential) {
    const cwd = callCwd(call);
    const root = gitRoot(cwd);
    const state = root ? contractState(root) : { binding: false };
    // A path argument could itself hold the secret; the reason must never echo it.
    const path = targets.length ? redactText(targets.join(", ")) : undefined;
    const where = path ?? (toolName === "run_command" ? "its command line" : "its target");
    return deny(
      `${toolName ?? "this tool call"} would write a ${credential.name} credential literal (${credential.kind}) into ${where}. ` +
        `A key is never written into a file or a command line: read it from the environment the session ` +
        `was launched with (process.env.GEMINI_API_KEY, $GEMINI_API_KEY) and re-issue the call without the value.`,
      {
        root,
        recordRoot: cwd,
        path,
        matchedRule: credential.name,
        runId: state.binding ? state.runId : undefined,
        toolName,
      },
    );
  }

  if (toolName === "run_command") {
    const line = withoutProse(call?.toolCall?.args?.CommandLine ?? call?.tool_input?.command);
    const roots = bindingRoots(call);
    if (roots.length && scriptWriteTargets(line).unresolved) {
      const { root, state } = roots[0];
      return deny(
        `this command's inline script writes a file whose path is not a literal, so the write contract of run ${state.runId} cannot judge it. ` +
          "Write the file with write_to_file, or name its path as a literal string.",
        { root, runId: state.runId, matchedRule: "unresolved-script-write", toolName },
      );
    }
    // agy names no working folder for a command: a package manager is judged in every project whose contract binds.
    const pkg = packageInstallTargets(line);
    for (const { root } of roots) {
      for (const rel of pkg.manifest) targets.push(join(root, rel));
      for (const rel of pkg.output) installTargets.push(join(root, rel));
    }
  }

  if (targets.length + installTargets.length === 0) return allow("no write target extracted from this tool call");

  // A redirect or file tool naming an install's output path is judged as itself, never as the install.
  let judgedBy = null;
  for (const [target, installOutput] of [...targets.map((t) => [t, false]), ...installTargets.map((t) => [t, true])]) {
    const verdict = await checkOneTarget(target, call, { installOutput });
    if (verdict.deny) return deny(verdict.msg, { ...verdict.ctx, toolName });
    judgedBy ??= verdict.judgedBy?.[0] ?? null;
  }
  // Logged where a refusal under the same contract would be, with its run id: a
  // headless run counts these to show the hook judged its writes (writeGuard.mjs).
  const paths = [...targets, ...installTargets].map((t) => toPosix(isAbsolute(t) ? t : resolve(callCwd(call), t)));
  return allow(`all ${paths.length} target(s) cleared`, judgedBy ? { root: judgedBy.root, runId: judgedBy.runId, paths } : { root: gitRoot(callCwd(call)), paths });
}

const NOT_YOURS = "A wider scope is the person's decision, for a new run with its own Gate 0: stop and tell the person which path is needed and why.";

const RECORD_GATE = fileURLToPath(new URL("../../scripts/record-gate.mjs", import.meta.url));
const recordGateCommand = (runId, gate, decision, artifact) =>
  `node "${RECORD_GATE}" --run-id=${runId} --gate=${gate} --decision=${decision} --artifact=${artifact} --reply="<their reply, verbatim>"`;

/** The always-off-limits pattern a path hits, in any letter case, at any depth. */
function hardcodedHit(path) {
  return HARDCODED_OFF_LIMITS.find((p) => matchesAtAnyDepth(path, p)) ?? null;
}

/** The contract's conditional entry `{ path, condition }` a path falls under, in any letter case, or null. */
export function conditionalEntry(rel, contract) {
  const entries = Array.isArray(contract?.conditional) ? contract.conditional : [];
  return entries.find((e) => typeof e?.path === "string" && matchGlob(rel, e.path, { anyCase: true })) ?? null;
}

/** Whether a Gate 0 approved-conditional record opens the path; it grants, so it matches exactly. */
export function conditionApproved(rel, approvals) {
  return approvals.some((a) => a === rel || matchGlob(rel, a));
}

/**
 * The decision for one repo-relative path under a live contract, or null to
 * allow. Rules in order: the run's own control files and gate record, the
 * always-off-limits list, an artifact a gate approved, the run's own folder,
 * an install's node_modules/, the contract's off_limits, an install's
 * lockfile, a conditional file, the allowlist.
 */
function judgeUnderContract(rel, state, { installOutput = false, gates = [] } = {}) {
  const { contract, runId } = state;
  const strict = contract?.strict !== false;
  const control = [CONTRACT_REL_PATH, lockRelPath(runId), endRelPath(runId), testRecordRelPath(runId)];
  if (control.some((p) => matchGlob(rel, p, { anyCase: true }))) {
    return { rule: "contract-control", msg: `${rel} is the write contract of live run ${runId}, or its freeze, end or test record. A live run never changes its own contract, records its own end or writes its own test result; only plugin/scripts/write-contract.mjs and plugin/scripts/test-run.mjs write them. ${NOT_YOURS}` };
  }
  if (matchGlob(rel, gatesRelPath(runId), { anyCase: true })) {
    return { rule: "gate-record", msg: `${rel} is the gate record of live run ${runId}. Only plugin/scripts/record-gate.mjs writes it, one line per answer the person gave at a gate: ${recordGateCommand(runId, "<N>", "<decision>", "<artifact>")}.` };
  }
  const hard = hardcodedHit(rel);
  if (hard) return { rule: hard, msg: `${rel} matches always-off-limits pattern "${hard}" (run ${runId}); no contract can open it. ${NOT_YOURS}` };
  const locked = [...approvalState(gates).approved.values()].find((l) => l.artifact.toLowerCase() === rel.toLowerCase());
  if (locked) {
    return {
      rule: "approved-artifact",
      msg: `${rel} is an approved artifact of run ${runId}: Gate ${locked.gate} recorded it ${locked.decision} (gates.jsonl, sha256 ${String(locked.sha256).slice(0, 12)}…). ` +
        `Changing an approved artifact is the person's decision. Stop and ask them, saying what would change and why; never write an approval, resolution or escalation note yourself. ` +
        `On a "revise: ..." answer, record it first: ${recordGateCommand(runId, locked.gate, "revise", locked.artifact)}. That re-opens ${locked.artifact} until its gate approves it again.`,
    };
  }
  if (matchGlob(rel, `.sdlc/runs/${runId}/**`)) return null;
  // node_modules/** in off_limits keeps the run's own edits out of installed code; it is no bar to installing it.
  if (installOutput && rel.startsWith("node_modules/")) return null;
  const off = firstMatch(rel, contract?.off_limits, { anyCase: true });
  if (off) {
    if (!strict) {
      console.error(`[mmo-brownfield write-contract] WARN: ${rel} matches off-limits pattern "${off}". Allowed because contract.strict = false.`);
      return null;
    }
    return { rule: off, msg: `${rel} matches off-limits pattern "${off}" (run ${runId}). ${NOT_YOURS}` };
  }
  if (installOutput && INSTALL_LOCKFILES.has(rel)) return null;
  const conditional = conditionalEntry(rel, contract);
  if (conditional) {
    if (conditionApproved(rel, conditionalApprovals(gates))) return null;
    const msg = `${rel} is in scope for run ${runId} only on the condition Gate 0 froze: "${conditional.condition}". Whether it holds is the person's decision: ` +
      `stop and ask them, quoting the condition and saying why this write needs it. On their yes, record it: ${recordGateCommand(runId, 0, "approved-conditional", rel)}; then write the file.`;
    if (!strict) {
      console.error(`[mmo-brownfield write-contract] WARN: ${msg} Allowed because contract.strict = false.`);
      return null;
    }
    return { rule: "conditional", msg };
  }
  if (firstMatch(rel, contract?.allowlist)) return null;
  if (!strict) {
    console.error(`[mmo-brownfield write-contract] WARN: ${rel} is not in the confirmed allowlist. Allowed because contract.strict = false.`);
    return null;
  }
  return { rule: null, msg: `${rel} is not in the confirmed allowlist for run ${runId}. ${NOT_YOURS}` };
}

/** Returns { deny: boolean, msg?, ctx? } for a single candidate path. */
async function checkOneTarget(target, call, { installOutput = false } = {}) {
  const cwd = callCwd(call);
  const absTarget = isAbsolute(target) ? target : resolve(cwd, target);
  const realAbs = realTarget(absTarget);

  // The session's own project. Inside means inside once links are followed: the
  // real form alone decides, so /tmp and /private/tmp spellings agree.
  const sessionRoot = gitRoot(cwd);
  const sessionState = sessionRoot ? contractState(sessionRoot) : { binding: false };
  if (sessionState.binding && relUnder(realRoot(sessionRoot), realAbs) === null) {
    return {
      deny: true,
      msg: `${absTarget} resolves OUTSIDE the project whose contract this session holds (${sessionRoot}), as written or through a link. ` +
        `Cross-project writes are refused: a brownfield run writes only inside its own project.`,
      ctx: { root: sessionRoot, path: absTarget, runId: sessionState.runId },
    };
  }

  // Every binding contract on the path judges the write: the session's, and the
  // contract at the root of the git project holding the target when that is a
  // different project (a submodule or a nested repo inside the session's).
  const targetRoot = gitRoot(dirname(realAbs)) ?? gitRoot(dirname(absTarget)) ?? sessionRoot;
  const judges = [];
  if (sessionState.binding) judges.push({ root: sessionRoot, state: sessionState });
  if (targetRoot && targetRoot !== sessionRoot) {
    const own = contractState(targetRoot);
    if (own.binding) judges.push({ root: targetRoot, state: own });
  }

  if (!judges.length) {
    // The greenfield test fixture: creating a missing `.env` from the run's
    // own `.env.test` before `npm test`. An existing `.env` is never touched,
    // `.env.*` stays refused, and a binding contract never reaches here.
    if (basename(absTarget) === ".env" && !existsSync(absTarget)) return { deny: false };
    const forms = targetRoot ? [relUnder(targetRoot, absTarget), relUnder(realRoot(targetRoot), realAbs)].filter(Boolean) : [];
    for (const p of [...forms, toPosix(absTarget), toPosix(realAbs)]) {
      const hit = hardcodedHit(p);
      if (hit) {
        return {
          deny: true,
          msg: `${target} matches always-off-limits pattern "${hit}" (no brownfield contract binds here; this net covers credentials, MCP config, ` +
            `other AI tools' rules and git's own store, in any letter case).`,
          ctx: { root: targetRoot, path: toPosix(absTarget), matchedRule: hit },
        };
      }
    }
    return { deny: false };
  }

  for (const { root, state } of judges) {
    if (state.tampered) {
      return {
        deny: true,
        msg: `every write is refused: ${state.tampered}. Ending run ${state.runId} is the person's decision: ` +
          `node plugin/scripts/write-contract.mjs --abandon --run-id ${state.runId} --reason "<why>".`,
        ctx: { root, path: toPosix(absTarget), runId: state.runId, matchedRule: "tampered" },
      };
    }
    const real = relUnder(realRoot(root), realAbs);
    if (real === null) {
      return {
        deny: true,
        msg: `${absTarget} leads outside the project of live run ${state.runId} (${root}) through a link; a write there is a write outside the project.`,
        ctx: { root, path: toPosix(absTarget), runId: state.runId },
      };
    }
    const gates = readGateLines(join(root, ".sdlc", "runs", state.runId)) ?? [];
    // Judged as written too, when the written form lies under the root: an
    // off-limits name reached through a link is refused either way.
    for (const rel of new Set([real, relUnder(root, absTarget)].filter((x) => x !== null))) {
      const verdict = judgeUnderContract(rel, state, { installOutput, gates });
      if (verdict) return { deny: true, msg: verdict.msg, ctx: { root, path: rel, runId: state.runId, matchedRule: verdict.rule, strict: state.contract?.strict } };
    }
  }
  return { deny: false, judgedBy: judges.map(({ root, state }) => ({ root, runId: state.runId })) };
}

if (isMain(import.meta.url)) {
  main().catch(async (e) => {
    if (process.env.MMO_DEBUG === "1") console.error(`[mmo-brownfield write-contract] unhandled: ${e?.message ?? e}`);
    reply("allow");
    process.exit(0);
  });
}
