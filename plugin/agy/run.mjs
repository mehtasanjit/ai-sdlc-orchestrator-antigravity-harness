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
 *   node run.mjs --brief=<path> --output-dir=<path> \
 *                [--project-root=<path>] [--policy=<name>] [--run-id=<id>] \
 *                [--code-dir=<path>] [--gates=prompt|auto-approve|auto-abort] \
 *                [--mode=greenfield|brownfield] [--intent=<id>] [--seed=<text>] \
 *                [--resume=<conversation-id>] [--max-turns=<n>] \
 *                [--agy-bin=<path>] [--prompt-file=<path>] [--print-timeout=6h] \
 *                [--inline-env] [--keep-run-root] [--allow-unverified-pin] [--dry-run]
 *
 * --seed without --intent on a brownfield run resolves the job type at launch
 * (scripts/infer-intent.mjs) and records it as inferred; an ambiguous seed
 * refuses to launch rather than leave the choice to the model.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync as spawnSyncFn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { conversationIdFrom, driverUsage, parseEventStream, parseInvocations } from "./telemetry/event-reader.mjs";
import { assertPinnedInvocation, driverSlug, findPinRejection, pendingPinChecks, readPin } from "./telemetry/fairnessPin.mjs";
import { defaultRunRoot, materialiseRunRoot, removeRunRoot } from "./runRoot.mjs";
import { buildHarnessManifest, agyVersion } from "./manifest.mjs";
import { inferIntent } from "../scripts/infer-intent.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";

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

export function renderHandover({ mode, intent, seed, intentSource } = {}) {
  const lines = [];
  if (mode) lines.push(`mode: ${mode}`);
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

export function runIsComplete(outputDir, exists = existsSync) {
  return exists(join(outputDir, "SUMMARY.md"));
}

export function spawnAgy(args, { spawnFn = spawn, cwd, agyBin = "agy", env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawnFn(agyBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => resolvePromise({ status: null, stdout, stderr: String(err?.message ?? err) }));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** `invocations`: one `{stdout, status, wall_ms}` per agy process, in launch order. `jsonl` alone is one process. */
export function buildRunArtifacts({ jsonl, invocations, pin, passId, policyName, now, resumeUsage }) {
  const runs = invocations ?? [{ stdout: jsonl, status: null, wall_ms: null }];
  const events = parseInvocations(runs.map((r) => r.stdout), now);
  const rejection = findPinRejection(events);
  const { modeled, summary } = driverUsage(
    events,
    { pass: passId, model: pin.model, pricing: pin.pricing, policyName, billingMode: pin.billing_mode, now },
    { invocations: runs, ...(resumeUsage ? { resumeUsage } : {}) },
  );
  summary.invocations.forEach((s, i) => {
    s.lines = streamLines(runs[i].stdout);
    if (runs[i].carried) s.carried_from_earlier_launch = true;
  });
  return { events, rejection, modeled, driverUsage: summary };
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
 * driver files. Boundaries come from the earlier driver-manifest.json; a
 * manifest without them yields the whole earlier stream as one invocation.
 */
export function priorInvocations(outputDir, conversationId, { read = readFileSync, exists = existsSync } = {}) {
  const manifestPath = join(outputDir, "driver-manifest.json");
  const eventsPath = join(outputDir, "driver-events.jsonl");
  if (!conversationId || !exists(manifestPath) || !exists(eventsPath)) return { invocations: [], started_at: null };
  let prior;
  try {
    prior = JSON.parse(read(manifestPath, "utf-8"));
  } catch {
    return { invocations: [], started_at: null };
  }
  if (prior?.conversation_id !== conversationId) return { invocations: [], started_at: null };
  const text = String(read(eventsPath, "utf-8"));
  const recorded = prior.driver_usage?.invocations;
  if (!Array.isArray(recorded) || !recorded.every((i) => Number.isInteger(i.lines))) {
    return { invocations: [{ stdout: text, status: prior.agy_exit_status ?? null, wall_ms: null, carried: true }], started_at: prior.started_at ?? null };
  }
  const lines = text.split("\n");
  let at = 0;
  const invocations = recorded.map((i) => {
    const stdout = lines.slice(at, at + i.lines).join("\n");
    at += i.lines;
    return { stdout, status: i.exit_status ?? null, wall_ms: i.wall_ms ?? null, carried: true };
  });
  return { invocations, started_at: prior.started_at ?? null };
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
  const outputDir = args["output-dir"] ? resolve(args["output-dir"]) : join(projectRoot, ".sdlc");
  const policyName = args.policy ?? DEFAULT_POLICY;
  const runId = args["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-");
  const promptPath = args["prompt-file"] ? resolve(args["prompt-file"]) : join(AGY_DIR, "prompts", "conductor.md");
  const codeDir = args["code-dir"] ? resolve(args["code-dir"]) : join(projectRoot, "src");
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
    HANDOVER: renderHandover({ mode, intent: resolvedIntent, seed: args.seed, intentSource }),
  };
  const promptText = renderPrompt(readFileSync(promptPath, "utf-8"), renderValues);

  const policy = loadPolicyFile(policyName);
  const pin = readPin(policy);
  const slug = driverSlug(pin);
  assertPinnedInvocation({ model: slug }, policy);

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
          pin: { ...pin, slug, verified: pinVerified, pending_checks: pending },
          run_id: runId,
          mode: mode ?? null,
          intent: resolvedIntent ? { resolved: resolvedIntent, source: intentSource } : null,
          output_dir: outputDir,
          cwd,
          inline_env: inlineEnv,
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
  copyFileSync(policyPath(policyName), join(outputDir, "policy_snapshot.yaml"));
  if (runRoot) materialiseRunRoot({ runRoot, pluginRoot: PLUGIN_ROOT });

  const agyBin = args["agy-bin"] ?? "agy";
  const resumeFrom = args.resume ?? null;
  const prior = priorInvocations(outputDir, resumeFrom);
  const started = prior.started_at ?? new Date().toISOString();
  const launches = [...prior.invocations];
  const launch = async (agyArgv) => {
    const t0 = Date.now();
    const r = await spawnAgy(agyArgv, { cwd, agyBin });
    launches.push({ stdout: r.stdout, status: r.status, wall_ms: Date.now() - t0 });
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

    let stderr = result.stderr;
    const conversationId = conversationIdFrom(parseEventStream(result.stdout)) ?? resumeFrom;
    let invocations = 1;

    while (invocations < maxTurns && result.status === 0 && conversationId && !runIsComplete(outputDir)) {
      console.log(`run ${runId}: session incomplete after invocation ${invocations} (no SUMMARY.md yet) — resuming ${conversationId}`);
      result = await launch(
        buildAgyArgs({ slug, promptText: RESUME_PROMPT, projectRoot, outputDir, printTimeout, resumeConversationId: conversationId }),
      );
      stderr += result.stderr;
      invocations += 1;
    }
    const stdout = launches.map((l) => terminated(l.stdout)).join("");

    if (!runIsComplete(outputDir)) {
      console.log(
        `run ${runId}: stopped after ${invocations} invocation(s) without SUMMARY.md — ` +
          (invocations >= maxTurns ? `hit --max-turns=${maxTurns}.` : `agy exited ${result.status}.`) +
          " Artifacts so far are in the output directory; re-run with --resume=<conversation-id> to continue.",
      );
    }

    const stderrPath = join(outputDir, "driver-stderr.log");
    const priorStderr = prior.invocations.length && existsSync(stderrPath) ? terminated(readFileSync(stderrPath, "utf-8")) : "";
    writeFileSync(join(outputDir, "driver-events.jsonl"), stdout, "utf-8");
    writeFileSync(stderrPath, priorStderr + stderr, "utf-8");

    const { events, rejection, modeled, driverUsage: usageSummary } = buildRunArtifacts({ invocations: launches, pin, passId: runId, policyName });
    writeFileSync(
      join(outputDir, "driver-cost-modeled.jsonl"),
      modeled.map((e) => JSON.stringify(e)).join("\n") + (modeled.length ? "\n" : ""),
      "utf-8",
    );
    if (usageSummary.invocations_without_usage.length) {
      console.error(
        `run ${runId}: agy invocation(s) ${usageSummary.invocations_without_usage.join(", ")} ended without a result event — ` +
          "their driver tokens are missing from the modeled driver line.",
      );
    }

    const manifest = {
      harness: "antigravity",
      run_id: runId,
      policy: policyName,
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
      completed: runIsComplete(outputDir),
      driver_cost_usd_modeled: usageSummary.cost_usd,
      driver_usage: usageSummary,
      pin_rejection: rejection,
      events_captured: events.length,
      inline_env: inlineEnv,
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
    console.log(`\n  Manifest:     node plugin/agy/manifest.mjs '${outputDir}'`);
    console.log(`  Cost report:  node tools/report.mjs '${outputDir}'`);
    return result.status === 0 ? 0 : 1;
  } finally {
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
