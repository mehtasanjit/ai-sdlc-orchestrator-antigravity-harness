#!/usr/bin/env node
/**
 * Driver entry — the measured, headless run on the Antigravity CLI.
 *
 * Builds the `agy --print` invocation with every pin, captures the
 * stream-json output, and turns it into run artifacts: the driver's own
 * modeled cost, the pin-rejection check, the trajectory and the driver
 * manifest. The conductor prompt decides pipeline order inside agy; this
 * script is the harness around the conductor, never the conductor.
 *
 * Pins and their checks (docs/verification/p1-agy-runtime.md):
 *   --model <slug>                 driver block, effort baked into the slug (14)
 *   --dangerously-skip-permissions print mode soft-denies every tool otherwise (6)
 *   no --sandbox                   the bridge is a piped subprocess (2)
 *   --print-timeout 6h             the default is 5 minutes; a pass runs hours
 *   cwd = repo root                where the .agents/plugins/mmo mount lives (10); print mode loads it
 *                                  anyway only in name — dispatch goes through dispatch.mjs (1, 2)
 *
 * Usage:
 *   node run.mjs --brief=<path> [--output-dir=<path>] \
 *                [--project-root=<path>] [--policy=<name>] [--run-id=<id>] \
 *                [--code-dir=<path>] [--gates=prompt|auto-approve|auto-abort] \
 *                [--mode=greenfield|brownfield] [--intent=<id>] [--seed=<text>] \
 *                [--resume=<conversation-id>] [--max-turns=<n>] \
 *                [--agy-bin=<path>] [--prompt-file=<path>] [--print-timeout=6h] \
 *                [--inline-env] [--keep-run-root] [--allow-unverified-pin] [--dry-run]
 *
 * Defaults: --output-dir is <project-root>/.sdlc/runs/<run-id>/, one folder per
 * run; --code-dir is <project-root>/src for greenfield and the project root
 * for brownfield, whose edits land across the existing tree.
 *
 * --seed without --intent on a brownfield run resolves the job type at launch
 * (scripts/infer-intent.mjs) and records it as inferred; an ambiguous seed
 * refuses to launch rather than leave the choice to the model.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync as spawnSyncFn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { conversationIdFrom, driverUsage, offPinModels, parseEventStream, parseInvocations, reportedModels } from "./telemetry/event-reader.mjs";
import { driverPrice, unpricedDriverRefusal } from "./telemetry/driverPrice.mjs";
import { assertPinnedInvocation, driverSlug, findPinRejection, pendingPinChecks, readPin } from "./telemetry/fairnessPin.mjs";
import { defaultRunRoot, materialiseRunRoot, removeRunRoot } from "./runRoot.mjs";
import { buildHarnessManifest, agyVersion } from "./manifest.mjs";
import { driverRangeNotes } from "./telemetry/driverRange.mjs";
import { inferIntent } from "../scripts/infer-intent.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { staleBuild, staleBuildWarning } from "../scripts/lib/stale-build.mjs";
import { finishWriteGuard, gitStatus } from "./writeGuard.mjs";
import { agyHome, readConversationRecord } from "./telemetry/conversationUsage.mjs";

const AGY_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(AGY_DIR);
export const HARNESS_ROOT = dirname(PLUGIN_ROOT);
export const DEFAULT_POLICY = "antigravity-flash38-plus-opus5";
export const DEFAULT_PRINT_TIMEOUT = "6h";
export const DEFAULT_MAX_TURNS = 12;

/** Variables the launcher reports as set/unset in a dry run. Values are never printed. */
export const REPORTED_ENV = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "SDLC_SELECT",
  "MMO_SELECT",
];

export const GATE_MODES = {
  prompt:
    "Stop and ask the user at each gate. Print what was produced, where it is, and what you " +
    "propose to do next, then wait for their answer before continuing.",
  "auto-approve":
    "You are running UNATTENDED — there is no user to answer, and stdin is closed. At each " +
    "gate, print what was produced and where it is, record the decision as `auto-approved`, " +
    "and continue without waiting. Do not ask a question you cannot receive an answer to. " +
    "If an artifact looks wrong enough that a reviewer would have rejected it, say so plainly " +
    "in the gate record and in your final report rather than passing it silently.",
  "auto-abort":
    "You are running UNATTENDED with gates set to abort. At each gate, print what was " +
    "produced, record the decision as `aborted`, and stop the run there. Use this to produce " +
    "one phase's artifact for inspection without proceeding.",
};

export const RESUME_PROMPT =
  "Continue the run from where you stopped. Re-read your own artifacts in the output directory " +
  "to see what is already done — do not redo completed phases, and do not re-dispatch a packet " +
  "whose result file already exists. Pick up at the first incomplete phase and carry on through " +
  "the remaining gates. The rules you were given still apply: you author no shipped content, " +
  "every artifact comes back from a dispatch. Finish with the final report and SUMMARY.md.";

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
}

export function validIntents(pluginRoot = PLUGIN_ROOT) {
  const raw = JSON.parse(readFileSync(join(pluginRoot, "config", "intents.json"), "utf-8"));
  return (Array.isArray(raw) ? raw : (raw.intents ?? [])).map((i) => i.id);
}

export function renderHandover({ mode, intent, seed, intentSource, runId, outputDir, codeDir } = {}) {
  const lines = [];
  if (mode) lines.push(`mode: ${mode}`);
  if (mode === "brownfield") {
    if (runId) lines.push(`run_id: ${runId}`);
    if (outputDir) lines.push(`output_dir: ${outputDir}`);
    if (codeDir) lines.push(`code_dir: ${codeDir}`);
  }
  if (intent) lines.push(`intent: ${intent}`);
  if (intent && intentSource === "inferred") lines.push("intent_source: inferred");
  if (seed) lines.push(`seed_description: ${String(seed).replace(/\s+/g, " ").trim()}`);
  if (lines.length === 0) return "";
  return [
    "## Handover",
    "",
    "This run was started with the job already chosen. Treat the block below as the handover",
    "the brownfield guide's step 4 reads, and do not ask the questions it already answers.",
    "",
    "```",
    ...lines,
    "```",
    "",
  ].join("\n");
}

/**
 * `{{KEY}}` markers are the conductor prompt's own; `${CLAUDE_PLUGIN_ROOT}`
 * is what the copied skills still say, and both resolve to the same path.
 */
export function renderPrompt(template, values) {
  const rendered = template
    .replace(/\$\{(?:CLAUDE|MMO)_PLUGIN_ROOT\}/g, () => String(values.PLUGIN_ROOT ?? "${MMO_PLUGIN_ROOT}"))
    .replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
    );
  const leftover = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`run: conductor prompt has unrendered placeholder(s): ${[...new Set(leftover)].join(", ")}`);
  }
  return rendered;
}

export const RENDERED_SKILLS = [
  ["pipeline", join("pipeline", "SKILL.md")],
  ["brownfield-guide", join("brownfield-guide", "SKILL.md")],
];

export function renderSkills(outputDir, values, pluginRoot = PLUGIN_ROOT) {
  const written = [];
  for (const [name, rel] of RENDERED_SKILLS) {
    const source = join(pluginRoot, "skills", rel);
    if (!existsSync(source)) continue;
    const target = join(outputDir, "skills", `${name}.md`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPrompt(readFileSync(source, "utf-8"), values), "utf-8");
    written.push(target);
  }
  return written;
}

export function policyPath(policyName, pluginRoot = PLUGIN_ROOT) {
  return join(pluginRoot, "config", "policies", `${policyName}.yaml`);
}

export function loadPolicyFile(policyName, pluginRoot = PLUGIN_ROOT) {
  const path = policyPath(policyName, pluginRoot);
  if (!existsSync(path)) throw new Error(`run: policy '${policyName}' not found at ${path}.`);
  return parseYaml(readFileSync(path, "utf-8"));
}

/**
 * The policy this run uses, resolved the way the bridge resolves it, so the
 * launcher's pin, rates and cap come from the file the bridge routes by:
 *   1. <project-root>/routing-policy.yaml — the bridge always takes it when present
 *   2. --policy=<name>
 *   3. <project-root>/.sdlc/project.json default_policy (setup's console choice)
 *   4. the shipped default
 * Returns `{ name, path, source, policy, ignoredFlag }`.
 */
export function resolvePolicy({ projectRoot, flag = null, pluginRoot = PLUGIN_ROOT, read = readFileSync, exists = existsSync }) {
  const override = join(projectRoot, "routing-policy.yaml");
  if (exists(override)) {
    const policy = parseYaml(read(override, "utf-8"));
    if (!policy?.name) throw new Error(`run: ${override} has no name: field.`);
    return { name: policy.name, path: override, source: "routing-policy.yaml", policy, ignoredFlag: flag && flag !== policy.name ? flag : null };
  }
  if (flag) return { name: flag, path: policyPath(flag, pluginRoot), source: "--policy", policy: loadPolicyFile(flag, pluginRoot), ignoredFlag: null };
  const projectFile = join(projectRoot, ".sdlc", "project.json");
  if (exists(projectFile)) {
    let project = null;
    try { project = JSON.parse(read(projectFile, "utf-8")); } catch { throw new Error(`run: ${projectFile} is not valid JSON.`); }
    const name = typeof project?.default_policy === "string" ? project.default_policy.replace(/\.ya?ml$/, "") : null;
    if (name) return { name, path: policyPath(name, pluginRoot), source: ".sdlc/project.json", policy: loadPolicyFile(name, pluginRoot), ignoredFlag: null };
  }
  return { name: DEFAULT_POLICY, path: policyPath(DEFAULT_POLICY, pluginRoot), source: "default", policy: loadPolicyFile(DEFAULT_POLICY, pluginRoot), ignoredFlag: null };
}

/** The bridge's own validation (adapter ids, rules, the cost cap), run at launch instead of at the first dispatch. */
export async function validatePolicyFile(path) {
  const { loadPolicyFromPath } = await import("../mcp/model-dispatch/dist/policy.js");
  try {
    loadPolicyFromPath(path);
  } catch (err) {
    throw new Error(`run: policy ${path} is not valid: ${err?.message ?? err}`);
  }
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
}

/**
 * The full `agy` argv. A pure function so the pins are assertable without
 * spawning anything.
 */
export function buildAgyArgs({
  slug,
  promptText,
  projectRoot,
  outputDir,
  printTimeout = DEFAULT_PRINT_TIMEOUT,
  resumeConversationId = null,
}) {
  const addDirs = [projectRoot];
  if (outputDir && !isInside(outputDir, projectRoot)) addDirs.push(outputDir);
  return [
    "--print",
    promptText,
    "--output-format",
    "stream-json",
    "--model",
    slug,
    "--dangerously-skip-permissions",
    "--print-timeout",
    printTimeout,
    ...addDirs.flatMap((d) => ["--add-dir", d]),
    ...(resumeConversationId ? ["--conversation", resumeConversationId] : []),
  ];
}

/** The run's output directory: its own folder under the project's `.sdlc/runs/`. */
export function defaultOutputDir(projectRoot, runId) {
  return join(projectRoot, ".sdlc", "runs", runId);
}

/** Greenfield code goes to `src/`; a brownfield run edits the existing tree, so its code dir is the project root. */
export function defaultCodeDir(projectRoot, mode) {
  return mode === "brownfield" ? projectRoot : join(projectRoot, "src");
}

/**
 * `SUMMARY.md` written by this run. One left in the directory by an earlier
 * run (an `--output-dir` reused across runs) is older than this run's start
 * and does not mark this run complete.
 */
export function runIsComplete(outputDir, since = null, { exists = existsSync, stat = statSync } = {}) {
  const path = join(outputDir, "SUMMARY.md");
  if (!exists(path)) return false;
  if (!since) return true;
  // A second's slack for filesystems that store whole-second mtimes.
  return stat(path).mtimeMs >= Date.parse(since) - 1000;
}

/**
 * `onStdout` / `onStderr` receive each chunk as it arrives, so the launcher
 * can write the stream to disk before the process ends: a run killed
 * mid-invocation keeps every event agy had printed. `onChild` receives the
 * process, so an interrupt can stop it.
 */
export function spawnAgy(args, { spawnFn = spawn, cwd, agyBin = "agy", env = process.env, onStdout, onStderr, onChild } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawnFn(agyBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { const t = c.toString(); stdout += t; onStdout?.(t); });
    child.stderr?.on("data", (c) => { const t = c.toString(); stderr += t; onStderr?.(t); });
    child.on("error", (err) => resolvePromise({ status: null, stdout, stderr: String(err?.message ?? err) }));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** `invocations`: one `{stdout, status, wall_ms}` per agy process, in launch order. `jsonl` alone is one process. */
/**
 * `invocations`: one `{stdout, status, wall_ms}` per agy process, in launch order; `jsonl` alone is one
 * process. A pin rejection is read from this launch's processes only: a carried one was already
 * reported by the launch that ran it. `resumedFirst`: this launch's first process resumed a
 * conversation whose earlier record was not carried.
 */
/**
 * `driver`: the policy's driver block, priced through the dated list on the
 * day each agy process started (`invocations[i].started_at`, else `runStartedAt`);
 * without it the pin's flat card prices every turn.
 */
export function buildRunArtifacts({ jsonl, invocations, pin, passId, policyName, now, resumeUsage, resumedFirst = false, driver = null, runStartedAt = null }) {
  const runs = invocations ?? [{ stdout: jsonl, status: null, wall_ms: null }];
  const events = parseInvocations(runs.map((r) => r.stdout), now);
  const rejection = findPinRejection(events.filter((e) => !runs[(e.invocation ?? 1) - 1]?.carried));
  const priceWarnings = new Set();
  const priceFor = driver
    ? (invocation) => {
        const day = runs[(invocation ?? 1) - 1]?.started_at ?? runStartedAt ?? new Date().toISOString();
        const price = driverPrice(driver, day);
        for (const w of price.warnings ?? []) priceWarnings.add(w);
        if (price.unpriced) throw new Error(unpricedDriverRefusal(driver.model_name, day.slice(0, 10), price.reason));
        return price;
      }
    : null;
  const { modeled, summary } = driverUsage(
    events,
    { pass: passId, model: pin.model, pricing: pin.pricing, priceFor, policyName, billingMode: pin.billing_mode, now },
    { invocations: runs, resumedFirst, ...(resumeUsage ? { resumeUsage } : {}) },
  );
  summary.invocations.forEach((s, i) => {
    s.lines = streamLines(runs[i].stdout);
    if (runs[i].carried) s.carried_from_earlier_launch = true;
  });
  if (priceWarnings.size) summary.price_warnings = [...priceWarnings];
  const reported = reportedModels(events);
  const offPin = offPinModels(reported, pin, driverSlug(pin));
  return { events, rejection, modeled, driverUsage: summary, reportedModels: reported, offPinModels: offPin };
}

/**
 * The same conversation's usage as agy's local record holds it (check 18),
 * beside the stream reading the driver line booked: one record, two readers.
 * Null when the record is absent or unreadable; never changes the driver line.
 */
export async function crossCheckLocalRecord({ conversationId, since, modeled, home = agyHome() }) {
  if (!conversationId) return null;
  const path = join(home, "conversations", `${conversationId}.db`);
  if (!existsSync(path)) return { found: false };
  let calls;
  try { calls = await readConversationRecord(path); } catch (err) { return { found: true, unreadable: String(err?.message ?? err) }; }
  const inRun = calls.filter((c) => c.at && Date.parse(c.at) >= Date.parse(since) - 60_000);
  const sum = (xs, k) => xs.reduce((s, x) => s + (x[k] ?? 0), 0);
  const record = { input: sum(inRun, "fresh") + sum(inRun, "cached"), input_cached: sum(inRun, "cached"), output: sum(inRun, "output"), thinking: sum(inRun, "thinking") };
  const stream = { input: sum(modeled, "input_tokens") + sum(modeled, "input_tokens_cached"), input_cached: sum(modeled, "input_tokens_cached"), output: sum(modeled, "output_tokens"), thinking: sum(modeled, "output_tokens_reasoning") };
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.01 * Math.max(a, b), 1);
  return { found: true, calls: inRun.length, record, stream, agrees: Object.keys(record).every((k) => close(record[k], stream[k])) };
}

/** A stream with a guaranteed trailing newline, so concatenated invocations never share a line. */
export function terminated(text) {
  const s = String(text ?? "");
  return s && !s.endsWith("\n") ? `${s}\n` : s;
}

function streamLines(text) {
  return (terminated(text).match(/\n/g) ?? []).length;
}

/**
 * The earlier invocations of the conversation a `--resume` launch continues,
 * read back from the same output directory before this launch overwrites its
 * driver files, with the pin and policy they ran under. Boundaries come from
 * the earlier driver-manifest.json; a manifest written before it recorded
 * them is split at each `init` event, which every agy process emits first.
 */
export function priorInvocations(outputDir, conversationId, { read = readFileSync, exists = existsSync } = {}) {
  const none = { invocations: [], started_at: null, pin: null, policy: null };
  const manifestPath = join(outputDir, "driver-manifest.json");
  const eventsPath = join(outputDir, "driver-events.jsonl");
  if (!conversationId || !exists(manifestPath) || !exists(eventsPath)) return none;
  let prior;
  try {
    prior = JSON.parse(read(manifestPath, "utf-8"));
  } catch {
    return none;
  }
  if (prior?.conversation_id !== conversationId) return none;
  const lines = String(read(eventsPath, "utf-8")).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const recorded = prior.driver_usage?.invocations;
  const carried = (chunks) => ({ invocations: chunks, started_at: prior.started_at ?? null, pin: prior.pin ?? null, policy: prior.policy ?? null });
  if (!Array.isArray(recorded) || !recorded.every((i) => Number.isInteger(i.lines))) {
    return carried(splitAtInit(lines).map((chunk) => ({ stdout: chunk.join("\n"), status: null, wall_ms: null, carried: true })));
  }
  let at = 0;
  return carried(recorded.map((i) => {
    const stdout = lines.slice(at, at + i.lines).join("\n");
    at += i.lines;
    return { stdout, status: i.exit_status ?? null, wall_ms: i.wall_ms ?? null, carried: true, ...(i.started_at ? { started_at: i.started_at } : {}) };
  }));
}

function splitAtInit(lines) {
  const chunks = [];
  for (const line of lines) {
    let isInit = false;
    try { isInit = JSON.parse(line)?.event === "init"; } catch { /* not an event line */ }
    if (isInit || chunks.length === 0) chunks.push([]);
    chunks.at(-1).push(line);
  }
  if (chunks.length > 1 && chunks[0].every((l) => !l.trim())) chunks.shift();
  return chunks;
}

/** A carried record must have run under the pin and policy this launch asserts, or its turns would be re-priced as this pin's. */
export function assertResumable(prior, { slug, policyName }) {
  if (!prior.invocations.length) return;
  if (prior.pin?.slug && prior.pin.slug !== slug) {
    throw new Error(`run: the conversation being resumed ran on '${prior.pin.slug}', and this launch pins '${slug}'. Resume with the policy it ran under${prior.policy ? ` (--policy=${prior.policy})` : ""}, or start a new run.`);
  }
  if (prior.policy && prior.policy !== policyName) {
    throw new Error(`run: the conversation being resumed ran under policy '${prior.policy}', and this launch uses '${policyName}'. Resume with --policy=${prior.policy}, or start a new run.`);
  }
}

/** Which reported variables are set. Never their values. */
export function envPresence(env = process.env) {
  const out = {};
  for (const k of REPORTED_ENV) out[k] = Boolean(env[k] && String(env[k]).trim());
  return out;
}

export function redactPrompt(argv, maxChars = 120) {
  const i = argv.indexOf("--print");
  if (i === -1) return argv;
  const prompt = String(argv[i + 1]);
  const shown = prompt.length > maxChars ? `${prompt.slice(0, maxChars)}… (${prompt.length} chars)` : prompt;
  return [...argv.slice(0, i + 1), shown, ...argv.slice(i + 2)];
}

/** The refusal p1-agy-runtime.md "Pins chosen" asks for while its live checks are pending. */
export function pinGateMessage(pending) {
  return (
    `run: the driver pin is not live-verified — checks ${pending.join(", ")} in ` +
    `docs/verification/p1-agy-runtime.md are still pending, and nothing may be pinned on a pending check. ` +
    `Run the checks in a signed-in agy session and record them, or pass --allow-unverified-pin to run anyway ` +
    `with pin_verified: false stamped in the manifest.`
  );
}

async function main(args) {
  const projectRoot = args["project-root"] ? resolve(args["project-root"]) : process.cwd();
  const resolvedPolicy = resolvePolicy({ projectRoot, flag: typeof args.policy === "string" ? args.policy : null });
  const policyName = resolvedPolicy.name;
  if (resolvedPolicy.ignoredFlag) {
    console.error(`run: warning — ${join(projectRoot, "routing-policy.yaml")} (policy '${policyName}') is in force; the bridge routes by it whatever --policy says, so --policy=${resolvedPolicy.ignoredFlag} is not used.`);
  }
  await validatePolicyFile(resolvedPolicy.path);
  const runId = args["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`run: --run-id=${runId} must be letters, digits, '.', '_' or '-': it names the run's folder.`);
  }
  const outputDir = args["output-dir"] ? resolve(args["output-dir"]) : defaultOutputDir(projectRoot, runId);
  const promptPath = args["prompt-file"] ? resolve(args["prompt-file"]) : join(AGY_DIR, "prompts", "conductor.md");
  const codeDir = args["code-dir"] ? resolve(args["code-dir"]) : defaultCodeDir(projectRoot, args.mode);
  const briefPath = args.brief ? resolve(args.brief) : join(projectRoot, "brief.md");
  if (!args["prompt-file"] && !existsSync(briefPath)) {
    throw new Error(`run: no brief at ${briefPath}. Pass --brief=<path>, or put brief.md at the project root.`);
  }
  const gateMode = args.gates ?? "prompt";
  if (!(gateMode in GATE_MODES)) {
    throw new Error(`run: --gates=${gateMode} is not one of ${Object.keys(GATE_MODES).join(", ")}.`);
  }
  const mode = args.mode;
  if (mode && mode !== "greenfield" && mode !== "brownfield") {
    throw new Error(`run: --mode=${mode} is not one of greenfield, brownfield.`);
  }
  const intent = args.intent;
  if (intent) {
    const allowed = validIntents();
    if (!allowed.includes(intent)) throw new Error(`run: --intent=${intent} is not one of ${allowed.join(", ")}.`);
    if (mode === "greenfield") throw new Error("run: --intent applies to brownfield runs; --mode=greenfield takes none.");
  }
  let resolvedIntent = intent ?? null;
  let intentSource = intent ? "flag" : null;
  if (!intent && args.seed && mode === "brownfield") {
    const inferred = inferIntent(String(args.seed));
    if (!inferred.intent) {
      const why = inferred.candidates.length ? `candidates: ${inferred.candidates.map((c) => c.id).join(", ")}` : "no cue matched";
      throw new Error(`run: --seed did not resolve to one job type (${why}); pass --intent=<${validIntents().join("|")}>.`);
    }
    resolvedIntent = inferred.intent;
    intentSource = "inferred";
  }
  const maxTurns = Number(args["max-turns"] ?? DEFAULT_MAX_TURNS);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(`run: --max-turns=${args["max-turns"]} must be a positive integer.`);
  }
  const printTimeout = args["print-timeout"] ?? DEFAULT_PRINT_TIMEOUT;

  const renderValues = {
    PLUGIN_ROOT,
    PROJECT_ROOT: projectRoot,
    OUTPUT_DIR: outputDir,
    CODE_DIR: codeDir,
    BRIEF_PATH: briefPath,
    POLICY: policyName,
    RUN_ID: runId,
    GATE_INSTRUCTION: GATE_MODES[gateMode],
    HANDOVER: renderHandover({ mode, intent: resolvedIntent, seed: args.seed, intentSource, runId, outputDir, codeDir }),
  };
  const promptText = renderPrompt(readFileSync(promptPath, "utf-8"), renderValues);

  const policy = resolvedPolicy.policy;
  const pin = readPin(policy);
  const slug = driverSlug(pin);
  assertPinnedInvocation({ model: slug }, policy);

  const build = staleBuild(join(PLUGIN_ROOT, "mcp", "model-dispatch"));
  const buildWarning = staleBuildWarning(build);
  if (buildWarning) console.error(`run: warning — ${buildWarning}`);

  const launchPrice = driverPrice(policy.driver, new Date());
  if (launchPrice.unpriced) throw new Error(unpricedDriverRefusal(pin.model, new Date().toISOString().slice(0, 10), launchPrice.reason));
  for (const w of launchPrice.warnings) console.error(`run: warning — driver price: ${w}`);

  const pending = pendingPinChecks();
  const pinVerified = pending.length === 0;
  const inlineEnv = Boolean(args["inline-env"]);
  const runRoot = inlineEnv ? defaultRunRoot(runId) : null;
  const cwd = runRoot ?? HARNESS_ROOT;
  const agyArgs = buildAgyArgs({ slug, promptText, projectRoot, outputDir, printTimeout });

  if (args["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          policy: policyName,
          policy_source: resolvedPolicy.source,
          policy_path: resolvedPolicy.path,
          pin: { ...pin, slug, verified: pinVerified, pending_checks: pending },
          driver_price: { basis: launchPrice.basis, period: launchPrice.period, pricing: launchPrice.pricing },
          run_id: runId,
          mode: mode ?? null,
          intent: resolvedIntent ? { resolved: resolvedIntent, source: intentSource } : null,
          output_dir: outputDir,
          code_dir: codeDir,
          cwd,
          inline_env: inlineEnv,
          bridge_build: { stale: build.stale, files: build.files },
          env_present: envPresence(),
          argv: redactPrompt(agyArgs),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!pinVerified && !args["allow-unverified-pin"]) throw new Error(pinGateMessage(pending));

  mkdirSync(outputDir, { recursive: true });
  renderSkills(outputDir, renderValues);
  copyFileSync(resolvedPolicy.path, join(outputDir, "policy_snapshot.yaml"));
  if (runRoot) materialiseRunRoot({ runRoot, pluginRoot: PLUGIN_ROOT });

  const agyBin = args["agy-bin"] ?? "agy";
  const resumeFrom = args.resume ?? null;
  const prior = priorInvocations(outputDir, resumeFrom);
  assertResumable(prior, { slug, policyName });
  const started = prior.started_at ?? new Date().toISOString();
  const launches = [...prior.invocations];
  const statusBefore = gitStatus(projectRoot);

  // The streams go to disk as they arrive: the carried invocations first,
  // exactly as an end-of-run write would put them, then each process's
  // chunks. A run killed mid-invocation keeps every event agy printed, and
  // --resume reads them back.
  const eventsPath = join(outputDir, "driver-events.jsonl");
  const stderrPath = join(outputDir, "driver-stderr.log");
  const priorStderr = prior.invocations.length && existsSync(stderrPath) ? terminated(readFileSync(stderrPath, "utf-8")) : "";
  writeFileSync(eventsPath, prior.invocations.map((l) => terminated(l.stdout)).join(""), "utf-8");
  writeFileSync(stderrPath, priorStderr, "utf-8");

  let child = null;
  let interrupted = null;
  const onSignal = (sig) => {
    interrupted = sig;
    console.error(`run ${runId}: ${sig} — stopping agy and writing the run record`);
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const launch = async (agyArgv) => {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    let tail = "";
    const r = await spawnAgy(agyArgv, {
      cwd, agyBin,
      onChild: (c) => { child = c; },
      onStdout: (t) => { tail = t; appendFileSync(eventsPath, t); },
      onStderr: (t) => appendFileSync(stderrPath, t),
    });
    child = null;
    if (tail && !tail.endsWith("\n")) appendFileSync(eventsPath, "\n");
    launches.push({ stdout: r.stdout, status: r.status, wall_ms: Date.now() - t0, started_at: startedAt });
    return r;
  };

  try {
    let result = await launch(
      resumeFrom
        ? buildAgyArgs({ slug, promptText: RESUME_PROMPT, projectRoot, outputDir, printTimeout, resumeConversationId: resumeFrom })
        : agyArgs,
    );
    if (result.status === null && /ENOENT/.test(result.stderr ?? "")) {
      throw new Error(
        `run: could not launch '${agyBin}'. Install it (curl -fsSL https://antigravity.google/cli/install.sh | bash), ` +
          `or point at it explicitly with --agy-bin=<path>.`,
      );
    }

    const conversationId = conversationIdFrom(parseEventStream(result.stdout)) ?? resumeFrom;
    let invocations = 1;

    while (!interrupted && invocations < maxTurns && result.status === 0 && conversationId && !runIsComplete(outputDir, started)) {
      console.log(`run ${runId}: session incomplete after invocation ${invocations} (no SUMMARY.md yet) — resuming ${conversationId}`);
      result = await launch(
        buildAgyArgs({ slug, promptText: RESUME_PROMPT, projectRoot, outputDir, printTimeout, resumeConversationId: conversationId }),
      );
      invocations += 1;
    }
    const completed = runIsComplete(outputDir, started);
    if (!completed) {
      console.log(
        `run ${runId}: stopped after ${invocations} invocation(s) without this run's SUMMARY.md — ` +
          (interrupted ? `interrupted (${interrupted}).` : invocations >= maxTurns ? `hit --max-turns=${maxTurns}.` : `agy exited ${result.status}.`) +
          ` Artifacts so far are in the output directory; re-run with --resume=${conversationId ?? "<conversation-id>"} --run-id=${runId} to continue.`,
      );
    }

    const writeGuard = finishWriteGuard({ projectRoot, runId, statusBefore, outcome: completed ? "completed" : "stopped" });
    if (writeGuard.after_run_check?.outside_contract.length) {
      console.error(
        `run ${runId}: no write guard ran (headless), and the run changed ${writeGuard.after_run_check.outside_contract.length} file(s) its contract does not allow: ` +
          `${writeGuard.after_run_check.outside_contract.slice(0, 5).join(", ")}${writeGuard.after_run_check.outside_contract.length > 5 ? ", …" : ""}. Review them before keeping the change.`,
      );
    }

    const { events, rejection, modeled, driverUsage: usageSummary, reportedModels: driverModels, offPinModels: offPin } = buildRunArtifacts({
      invocations: launches, pin, passId: runId, policyName, driver: policy.driver, runStartedAt: started,
      resumedFirst: Boolean(resumeFrom) && prior.invocations.length === 0,
    });
    writeFileSync(
      join(outputDir, "driver-cost-modeled.jsonl"),
      modeled.map((e) => JSON.stringify(e)).join("\n") + (modeled.length ? "\n" : ""),
      "utf-8",
    );
    const localRecord = await crossCheckLocalRecord({ conversationId, since: started, modeled });
    if (localRecord?.found && localRecord.agrees === false) {
      console.error(
        `run ${runId}: agy's local conversation record and the stream disagree on the driver's tokens ` +
          `(record ${JSON.stringify(localRecord.record)}, stream ${JSON.stringify(localRecord.stream)}); see driver_usage.local_record.`,
      );
    }
    if (localRecord) usageSummary.local_record = localRecord;
    if (offPin.length) {
      console.error(`run ${runId}: agy reported driver model(s) ${offPin.join(", ")}, not the pinned ${slug} — the run is not on the pinned driver.`);
    }
    if (usageSummary.results_with_unproven_reading) {
      console.error(
        `run ${runId}: ${usageSummary.results_with_unproven_reading} driver result(s) reported counters that no token reading adds up to ` +
          "unambiguously; they are booked at the dearest reading (driver_usage.token_readings).",
      );
    }
    if (usageSummary.invocations_without_usage.length) {
      console.error(
        `run ${runId}: agy invocation(s) ${usageSummary.invocations_without_usage.join(", ")} reported no usage ` +
          "(no result event, or only an all-zero error result) — the modeled driver line may be missing their tokens.",
      );
    }

    const manifest = {
      harness: "antigravity",
      run_id: runId,
      policy: policyName,
      policy_source: resolvedPolicy.source,
      gates: gateMode,
      mode: mode ?? null,
      intent: resolvedIntent ? { resolved: resolvedIntent, source: intentSource } : null,
      pin: { model: pin.model, effort: pin.effort, slug, billing_mode: pin.billing_mode, verified: pinVerified, pending_checks: pending },
      conversation_id: conversationId,
      started_at: started,
      ended_at: new Date().toISOString(),
      agy_exit_status: result.status,
      driver_turns: modeled.length,
      agy_invocations: launches.length,
      completed,
      ...(interrupted ? { interrupted } : {}),
      output_dir: outputDir,
      code_dir: codeDir,
      write_guard: writeGuard,
      driver_cost_usd_modeled: usageSummary.cost_usd,
      driver_reported_models: driverModels,
      ...(offPin.length ? { driver_model_mismatch: offPin } : {}),
      driver_usage: usageSummary,
      pin_rejection: rejection,
      events_captured: events.length,
      inline_env: inlineEnv,
      bridge_build: { stale: build.stale, files: build.files },
      agy_version: agyVersion((cmd, a, o) => spawnSyncFn(agyBin, a, o)),
    };
    writeFileSync(join(outputDir, "driver-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    // manifest.json is written by code, never by the model. Failing here must
    // not lose the run: the driver files above are enough to rebuild it later.
    try {
      const { probeClaudeLogin } = await import("./verify-setup.mjs");
      const full = buildHarnessManifest({ runDir: outputDir, policyName, runId, version: manifest.agy_version, login: probeClaudeLogin() });
      writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(full, null, 2) + "\n", "utf-8");
    } catch (err) {
      console.error(`run: manifest.json not written (${err?.message ?? err}); rebuild with node plugin/agy/manifest.mjs '${outputDir}'`);
    }

    if (rejection) {
      console.error(`run: agy rejected the pinned model — ${rejection}`);
      return 1;
    }
    console.log(
      `run ${runId} finished: exit=${result.status} turns=${modeled.length} ` +
        `driver_cost_usd(modeled)=${manifest.driver_cost_usd_modeled} artifacts=${outputDir}`,
    );
    for (const note of driverRangeNotes(usageSummary)) console.log(`  driver: ${note}`);
    console.log(`\n  Manifest:     node plugin/agy/manifest.mjs '${outputDir}'`);
    console.log(`  Cost report:  node tools/report.mjs '${outputDir}'`);
    return result.status === 0 && !interrupted ? 0 : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (runRoot && !args["keep-run-root"]) removeRunRoot(runRoot);
  }
}

if (isMain(import.meta.url)) {
  try {
    process.exit(await main(parseArgs(process.argv.slice(2))));
  } catch (err) {
    console.error(`run failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
