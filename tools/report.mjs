#!/usr/bin/env node
/**
 * Post-run cost report for an AI-SDLC pass.
 *
 * The cost lines come from buildHarnessManifest (plugin/agy/manifest.mjs),
 * the code that writes manifest.json, so the report and the manifest cannot
 * book a dollar differently. Each line keeps its kind: cash (a vendor
 * invoices it), modeled (tokens priced at a card with no invoice: the driver
 * on a Google seat, Opus on a claude.ai seat) or NOT MEASURED. Only cash
 * lines make up the cash figure. A total that mixed the kinds would be
 * neither the bill nor the usage, so the report prints none.
 *
 * Usage: node tools/report.mjs <path-to-run-directory> [--markdown]
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parse as parseYaml } from "yaml";

import { ACTOR, ACTOR_LEGEND, gutter } from "./logfmt.mjs";
import { driverRange } from "../plugin/agy/telemetry/driverRange.mjs";

// ─── input ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const asMarkdown = argv.includes("--markdown");
const runDir = resolve(argv.filter((a) => !a.startsWith("--"))[0] ?? "");

if (!runDir || !existsSync(runDir)) {
  console.error("Usage: node tools/report.mjs <path-to-run-directory> [--markdown]");
  console.error("Example: node tools/report.mjs ./.sdlc");
  process.exit(2);
}

let harness;
try {
  harness = await import("../plugin/agy/manifest.mjs");
} catch (err) {
  console.error(`report: cannot load plugin/agy/manifest.mjs (${err?.message ?? err}).`);
  console.error("The cost lines are computed by the bridge's compiled code. Run: npm install && npm run build");
  process.exit(2);
}
const { buildHarnessManifest, claudeWallet, workerLineOf, readJsonl } = harness;

const telemetryPath = join(runDir, "telemetry.jsonl");
const modeledPath = join(runDir, "driver-cost-modeled.jsonl");
const manifestPath = join(runDir, "manifest.json");
const driverManifestPath = join(runDir, "driver-manifest.json");
const snapshotPath = join(runDir, "policy_snapshot.yaml");

function readJson(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

const telemetry = readJsonl(telemetryPath);
// The same partition buildManifest applies: orchestrator-tier lines are the
// conductor's, priced on the driver line, never dispatched work.
const events = telemetry.filter((e) => e.tier !== "orchestrator");
const orchestratorEvents = telemetry.length - events.length;
const modeledEvents = readJsonl(modeledPath);
const manifest = readJson(manifestPath);
const driverManifest = readJson(driverManifestPath);
let policy = null;
try { policy = existsSync(snapshotPath) ? parseYaml(readFileSync(snapshotPath, "utf8")) : null; } catch { policy = null; }

if (telemetry.length === 0 && modeledEvents.length === 0) {
  console.error(`No telemetry found in ${runDir}.`);
  console.error("Expected telemetry.jsonl (dispatched calls) and/or driver-cost-modeled.jsonl (driver turns).");
  console.error("Confirm the run actually started — a run halted at preflight produces neither.");
  process.exit(2);
}

// ─── the Claude wallet ────────────────────────────────────────────────

const CODE_WRITTEN = "plugin/agy/manifest.mjs";

/**
 * The wallet a code-written manifest.json recorded when the run ended. It
 * beats this shell's: the report may run later, elsewhere, with other keys.
 */
function recordedWallet(m) {
  if (m.harness?.written_by !== CODE_WRITTEN) return null;
  const line = m.cost?.lines?.find((l) => l.line === "claude_worker");
  if (!line?.wallet) return null;
  return {
    arm: line.arm ?? m.harness.arm ?? null,
    wallet: line.wallet,
    provider_source: m.harness.provider_source?.claude ?? null,
    project: null,
    region: null,
    subscription: /claude\.ai (\S+) seat/.exec(line.basis ?? "")?.[1] ?? null,
  };
}

let wallet = recordedWallet(manifest);
const walletSource = wallet ? "recorded in manifest.json" : "read from this shell; no manifest.json recorded one";
if (!wallet) {
  const { probeClaudeLogin } = await import("../plugin/agy/verify-setup.mjs");
  wallet = claudeWallet(process.env, probeClaudeLogin());
}

// ─── cost lines — the manifest's own computation ──────────────────────

const runId = manifest.pass ?? driverManifest.run_id ?? basename(runDir);
const policyName = manifest.policy_name ?? driverManifest.policy ?? policy?.name
  ?? events.find((e) => e.routing?.policy_name)?.routing.policy_name ?? "—";
const built = buildHarnessManifest({ runDir, runId, policyName, wallet });
const lines = built.cost.lines;
const lineByName = Object.fromEntries(lines.map((l) => [l.line, l]));
const workersFirst = [...lines.filter((l) => l.line !== "driver"), lineByName.driver];
const cashUsd = built.cost.dispatched_cash_usd;

const recordedLines = manifest.harness?.written_by === CODE_WRITTEN ? manifest.cost?.lines ?? null : null;
const manifestStale = recordedLines != null && (
  recordedLines.length !== lines.length
  || recordedLines.some((r) => {
    const now = lineByName[r.line];
    return !now || now.kind !== r.kind || now.cost_usd !== r.cost_usd || now.calls !== r.calls;
  })
);

// ─── per-phase aggregation ────────────────────────────────────────────

const kindOf = (e) => lineByName[workerLineOf(e, policy)]?.kind ?? "cash";

const phaseAgg = new Map();
const provCount = { vendor: 0, estimated: 0, modeled: 0, none: 0, unknown: 0 };
const packetAgg = new Map();
const totals = { calls: 0, tokIn: 0, tokOut: 0, cash: 0, modeled: 0 };

for (const e of events) {
  const phase = e.phase ?? "unknown";
  const tokIn = e.input_tokens ?? 0;
  const tokOut = e.output_tokens ?? 0;
  const cost = e.cost_usd ?? 0;
  const prov = e.provenance ?? "unknown";
  const bucket = kindOf(e) === "modeled" ? "modeled" : "cash";

  provCount[prov in provCount ? prov : "unknown"] += 1;

  const rec = phaseAgg.get(phase) ?? {
    calls: 0, tokIn: 0, tokOut: 0, cash: 0, modeled: 0,
    prov: { vendor: 0, estimated: 0, modeled: 0, none: 0, unknown: 0 },
  };
  for (const agg of [rec, totals]) {
    agg.calls += 1;
    agg.tokIn += tokIn;
    agg.tokOut += tokOut;
    agg[bucket] += cost;
  }
  rec.prov[prov in rec.prov ? prov : "unknown"] += 1;
  phaseAgg.set(phase, rec);

  // Collapse output-cap doubling attempts into one record per packet.
  const tid = e.task_id;
  if (tid && (e.attempt_number != null || e.ceiling_used != null)) {
    const pkt = packetAgg.get(tid) ?? {
      task_id: tid, phase, model: e.model ?? "?", attempts: 0,
      finalCeiling: e.ceiling_used ?? null, cash: 0, modeled: 0,
    };
    pkt.attempts += 1;
    if (e.ceiling_used != null) pkt.finalCeiling = e.ceiling_used;
    pkt[bucket] += cost;
    packetAgg.set(tid, pkt);
  }
}

const retried = [...packetAgg.values()].filter((p) => p.attempts > 1).sort((a, b) => b.attempts - a.attempts);
const showModeled = lines.some((l) => l.line !== "driver" && l.kind === "modeled" && l.calls > 0);

const driverCost = modeledEvents.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
const driverIn = modeledEvents.reduce((s, e) => s + (e.input_tokens ?? 0), 0);
const driverOut = modeledEvents.reduce((s, e) => s + (e.output_tokens ?? 0), 0);
const driverBounds = driverRange(driverManifest.driver_usage);
const driverUnmeasured = lineByName.driver.kind === "unmeasured";

/** Per-phase provenance tag. */
function provTag(rec) {
  const kinds = Object.entries(rec.prov).filter(([, n]) => n > 0).map(([k]) => k);
  if (kinds.length > 1) return "~";
  // `none` is not a missing label — it is a phase that made no model call, so
  // its zeros are facts. Shown as `–` so a reader can tell "ran, cost nothing
  // here" from "?" (unlabelled, provenance genuinely unknown).
  return { vendor: "V", estimated: "E", modeled: "M", none: "–", unknown: "?" }[kinds[0]] ?? "?";
}

// ─── formatting ───────────────────────────────────────────────────────

const fmtUSD = (n) => `$${n.toFixed(4)}`;
const fmtCompact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtDuration = (sec) => {
  if (!sec) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
};
const lineName = (l) => l.line.replace("_", " ");
const wrap = (text, width = 76) => {
  const wrapped = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && `${cur} ${word}`.length > width) { wrapped.push(cur); cur = word; }
    else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) wrapped.push(cur);
  return wrapped;
};
const kindLabel = (l) => (l.kind === "unmeasured" ? "NOT MEASURED" : l.kind);

const started = manifest.started_at ?? driverManifest.started_at ?? "—";
const duration = fmtDuration(manifest.duration_sec ?? 0);
const pin = driverManifest.pin ?? {};

const out = [];
const p = (s = "") => out.push(s);

// ─── header ───────────────────────────────────────────────────────────

if (asMarkdown) {
  p(`# Run report — ${runId}`);
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| Policy | \`${policyName}\` |`);
  if (pin.model) p(`| Model pin | \`${pin.model}\`, effort \`${pin.effort}\` |`);
  p(`| Started | ${started} |`);
  if (duration !== "—") p(`| Duration | ${duration} |`);
  p();
} else {
  const line = "─".repeat(66);
  p();
  p(`┌${line}┐`);
  p(`│ ${`Run report — ${runId}`.padEnd(64)} │`);
  p(`└${line}┘`);
  p();
  p(`  Policy:    ${policyName}`);
  if (pin.model) p(`  Model pin: ${pin.model}  ·  effort ${pin.effort}`);
  if (pin.sandbox) p(`  Sandbox:   ${pin.sandbox}  ·  approval ${pin.approval_policy}`);
  p(`  Started:   ${started}`);
  if (duration !== "—") p(`  Duration:  ${duration}`);
  p();
}

// ─── cost lines ───────────────────────────────────────────────────────

const lineNotes = [];
const claudeLine = lineByName.claude_worker;
lineNotes.push(`Claude wallet: ${wallet.wallet ?? "unknown"}${wallet.arm ? ` (arm ${wallet.arm})` : ""}, ${walletSource}.`);
if (claudeLine.kind === "modeled" && claudeLine.calls > 0) {
  lineNotes.push("The claude worker ran on a claude.ai seat: tokens priced at the Anthropic card, no invoice, so its dollars stay out of the cash figure.");
} else if (!wallet.arm && claudeLine.calls > 0) {
  lineNotes.push("No wallet is known for the claude worker, so its line is booked as cash, as manifest.mjs books it.");
}
if (driverUnmeasured) lineNotes.push("The driver is NOT MEASURED: no headless launcher record, so the conductor's tokens are in no figure. Unmeasured, never free.");
if (lineByName.unclassified) lineNotes.push("unclassified: events with no known worker adapter or model prefix. Counted as cash, on neither worker's line.");
if (orchestratorEvents > 0) lineNotes.push(`${orchestratorEvents} tier:"orchestrator" event(s) in telemetry.jsonl are left out of every figure, as manifest.json leaves them out.`);
const rebuild = manifestStale ? `node plugin/agy/manifest.mjs '${runDir}'` : null;
if (rebuild) lineNotes.push("! manifest.json books these lines differently. Rebuild it from the harness clone:");

const lineCells = (l) => {
  if (l.kind === "unmeasured") return { calls: "—", tok: "—", cost: "—" };
  const range = l.cost_usd_low !== undefined ? ` (${fmtUSD(l.cost_usd_low)} – ${fmtUSD(l.cost_usd)})` : "";
  return { calls: String(l.calls), tok: `${fmtCompact(l.input_tokens)} / ${fmtCompact(l.output_tokens)}`, cost: fmtUSD(l.cost_usd), range };
};

if (asMarkdown) {
  p(`## Cost lines — never summed`);
  p();
  p(`| Line | Kind | Calls | Tokens (in / out) | Cost |`);
  p(`|---|---|---:|---|---:|`);
  for (const l of workersFirst) {
    const c = lineCells(l);
    const kind = l.kind === "cash" ? "cash" : `**${kindLabel(l)}**`;
    p(`| ${lineName(l)} | ${kind} | ${c.calls} | ${c.tok} | ${c.cost}${c.range ?? ""} |`);
  }
  p(`| **Cash** | | | | **${fmtUSD(cashUsd)}** |`);
  p();
  for (const n of lineNotes) p(`- ${n}${n.startsWith("!") ? ` \`${rebuild}\`` : ""}`);
  p();
} else {
  p(`  Cost lines — never summed`);
  p();
  p(`  ${"Line".padEnd(18)}${"Kind".padEnd(14)}${"Calls".padStart(6)}${"Tokens (in / out)".padStart(21)}${"Cost".padStart(11)}`);
  p(`  ${"─".repeat(70)}`);
  for (const l of workersFirst) {
    const c = lineCells(l);
    p(`  ${lineName(l).padEnd(18)}${kindLabel(l).padEnd(14)}${c.calls.padStart(6)}${c.tok.padStart(21)}${c.cost.padStart(11)}${c.range ?? ""}`);
  }
  p(`  ${"─".repeat(70)}`);
  p(`  ${"Cash".padEnd(59)}${fmtUSD(cashUsd).padStart(11)}`);
  p();
  for (const n of lineNotes) wrap(n).forEach((l, i) => p(`${i ? "    " : "  "}${l}`));
  if (rebuild) p(`    ${rebuild}`);
  p();
}

// ─── dispatched work by phase ─────────────────────────────────────────

const PREFERRED = [
  "discovery", "requirements_analysis", "architecture_design", "change_plan", "plan_task_packets",
  "codegen", "tests", "flow_tests", "docs", "debug", "refactor", "test_run",
  "senior_code_review", "security_review",
];
const rows = [
  ...PREFERRED.filter((ph) => phaseAgg.has(ph)).map((ph) => [ph, phaseAgg.get(ph)]),
  ...[...phaseAgg].filter(([ph]) => !PREFERRED.includes(ph)),
];

if (events.length > 0) {
  if (asMarkdown) {
    p(`## Dispatched work — by phase`);
    p();
    if (showModeled) {
      p(`| Phase | Prov | Calls | Tokens (in / out) | Cash | Modeled |`);
      p(`|---|:---:|---:|---|---:|---:|`);
    } else {
      p(`| Phase | Prov | Calls | Tokens (in / out) | Cash |`);
      p(`|---|:---:|---:|---|---:|`);
    }
    const row = (label, prov, r) => p(`| ${label} | ${prov} | ${r.calls} | ${fmtCompact(r.tokIn)} / ${fmtCompact(r.tokOut)} | ${fmtUSD(r.cash)} |${showModeled ? ` ${fmtUSD(r.modeled)} |` : ""}`);
    for (const [phase, rec] of rows) row(`\`${phase}\``, provTag(rec), rec);
    row("**All phases**", "", totals);
    p();
  } else {
    p(`  Dispatched work — by phase`);
    p();
    const header = `  ${"Phase".padEnd(22)}${"Prov".padStart(5)}${"Calls".padStart(7)}${"Tokens (in / out)".padStart(20)}${"Cash".padStart(11)}${showModeled ? "Modeled".padStart(11) : ""}`;
    const rule = `  ${"─".repeat(header.length - 2)}`;
    const row = (label, prov, r) => p(`  ${label.padEnd(22)}${prov.padStart(5)}${String(r.calls).padStart(7)}${`${fmtCompact(r.tokIn)} / ${fmtCompact(r.tokOut)}`.padStart(20)}${fmtUSD(r.cash).padStart(11)}${showModeled ? fmtUSD(r.modeled).padStart(11) : ""}`);
    p(header);
    p(rule);
    for (const [phase, rec] of rows) row(phase, provTag(rec), rec);
    p(rule);
    row("All phases", "", totals);
    p();
  }
} else {
  p(asMarkdown ? `## Dispatched work\n\n_No dispatched calls recorded._\n` : `  No dispatched calls recorded.\n`);
}

// ─── modeled driver cost — deliberately its own section ───────────────

if (asMarkdown) {
  p(`## Driver loop — modeled, not measured`);
  p();
  if (modeledEvents.length === 0 && driverUnmeasured) {
    p(`**Not measured.** No headless launcher record (\`driver-manifest.json\`): an interactive agy session gives the plugin no`);
    p(`usage counters, so the conductor's own tokens are in no figure. Unmeasured, never free.`);
  } else if (modeledEvents.length === 0) {
    p(`_No driver turns recorded._`);
  } else {
    p(`| Turns | Tokens (in / out) | Modeled cost |`);
    p(`|---:|---|---:|`);
    p(`| ${modeledEvents.length} | ${fmtCompact(driverIn)} / ${fmtCompact(driverOut)} | ${fmtUSD(driverCost)} |`);
    p();
    if (driverBounds.cost_usd_low !== undefined) {
      p(`> **Range ${fmtUSD(driverBounds.cost_usd_low)} – ${fmtUSD(driverBounds.cost_usd_high)}.** agy was resumed, and whether its usage`);
      p(`> counters restart in a resumed process is p1 check ${driverBounds.resume_check.check}, still pending. The figure above is the upper bound.`);
      p();
    }
    if (driverBounds.invocations_without_usage) {
      p(`> **Incomplete:** agy invocation(s) ${driverBounds.invocations_without_usage.join(", ")} ended without a result event, so their driver tokens are missing.`);
      p();
    }
    p(`> agy reports token counts and no wallet figure, so this is derived from the`);
    p(`> stream's usage counters at the policy's driver card. It is **not** an amount`);
    p(`> anyone was billed — a driver on a Google seat may have cost nothing in money at`);
    p(`> all. It is reported separately, and excluded from the cash figure above.`);
  }
  p();
} else {
  p(`  Driver loop — modeled, not measured`);
  p();
  if (modeledEvents.length === 0 && driverUnmeasured) {
    p(`  NOT MEASURED. No headless launcher record (driver-manifest.json): an interactive`);
    p(`  agy session gives the plugin no usage counters, so the conductor's own tokens`);
    p(`  are in no figure. Unmeasured, never free.`);
  } else if (modeledEvents.length === 0) {
    p(`  No driver turns recorded.`);
  } else {
    p(`  ${"Turns".padEnd(24)}${String(modeledEvents.length).padStart(13)}`);
    p(`  ${"Tokens (in / out)".padEnd(24)}${`${fmtCompact(driverIn)} / ${fmtCompact(driverOut)}`.padStart(13)}`);
    p(`  ${"Modeled cost".padEnd(24)}${fmtUSD(driverCost).padStart(13)}`);
    if (driverBounds.cost_usd_low !== undefined) {
      p(`  ${"Range".padEnd(24)}${`${fmtUSD(driverBounds.cost_usd_low)} – ${fmtUSD(driverBounds.cost_usd_high)}`.padStart(13)}`);
      p(`  agy was resumed; whether its usage counters restart in a resumed process is`);
      p(`  p1 check ${driverBounds.resume_check.check}, still pending. The modeled cost is the upper bound.`);
    }
    if (driverBounds.invocations_without_usage) {
      p(`  ! agy invocation(s) ${driverBounds.invocations_without_usage.join(", ")} ended without a result event; their driver tokens are missing.`);
    }
    p();
    p(`  agy reports token counts and no wallet figure, so this is derived from the`);
    p(`  stream's usage at the driver card. It is NOT an amount anyone was billed — a`);
    p(`  driver on a Google seat may have cost nothing in money. Kept out of the cash figure.`);
  }
  p();
}

// ─── retries ──────────────────────────────────────────────────────────

if (retried.length > 0) {
  if (asMarkdown) {
    p(`## Packets that hit the output cap`);
    p();
    p(`| Packet | Phase | Attempts | Final ceiling | Cash |${showModeled ? " Modeled |" : ""}`);
    p(`|---|---|---:|---:|---:|${showModeled ? "---:|" : ""}`);
    for (const pkt of retried) {
      p(`| \`${pkt.task_id}\` | ${pkt.phase} | ${pkt.attempts} | ${pkt.finalCeiling ?? "—"} | ${fmtUSD(pkt.cash)} |${showModeled ? ` ${fmtUSD(pkt.modeled)} |` : ""}`);
    }
    p();
  } else {
    p(`  Packets that hit the output cap`);
    p();
    for (const pkt of retried) {
      const cost = [
        ...(pkt.cash > 0 || pkt.modeled === 0 ? [`cash ${fmtUSD(pkt.cash)}`] : []),
        ...(pkt.modeled > 0 ? [`modeled ${fmtUSD(pkt.modeled)}`] : []),
      ].join(" · ");
      p(`  ${gutter(ACTOR.handoff)}${pkt.task_id.padEnd(22)} ${pkt.phase.padEnd(22)} ${String(pkt.attempts) + " attempts"} → ${cost}`);
    }
    p();
  }
}

// ─── delegation receipts ──────────────────────────────────────────────

const delegationDir = join(runDir, "delegation");
const receipts = existsSync(delegationDir)
  ? readdirSync(delegationDir)
      .filter((n) => n.startsWith("worker-delegation-") && n.endsWith(".json"))
      .sort()
      .map((n) => readJson(join(delegationDir, n)))
      .filter((r) => Object.keys(r).length > 0)
  : [];

if (receipts.length > 0) {
  if (asMarkdown) {
    p(`## Delegated to an agent worker`);
    p();
    p(`${receipts.length} packet(s) ran as agent sessions rather than single completion calls.`);
    p();
  } else {
    p(`  Delegated to an agent worker`);
    p();
    p(`  ${receipts.length} packet(s) ran as agent sessions rather than single completion calls.`);
    p();
    for (const [tag, meaning] of ACTOR_LEGEND) p(`  ${tag}  ${meaning}`);
    p();
  }
}

// ─── provenance summary ───────────────────────────────────────────────

const provLine = Object.entries(provCount)
  .filter(([, n]) => n > 0)
  .map(([k, n]) => `${n} ${k}`)
  .join(", ");

if (asMarkdown) {
  p(`---`);
  p();
  p(`_Provenance key: V = vendor-metered, E = estimated, M = modeled, – = no model call (skipped or in-session), ~ = mixed within phase, ? = unlabelled._`);
  if (provLine) p(`_Dispatched events: ${provLine}._`);
  if (driverManifest.pin_rejection) {
    p();
    p(`> **Pin rejected during this run:** ${driverManifest.pin_rejection}`);
  }
} else {
  p(`  Provenance key: V vendor-metered · E estimated · M modeled · – no model call · ~ mixed · ? unlabelled`);
  if (provLine) p(`  Dispatched events: ${provLine}`);
  if (driverManifest.pin_rejection) {
    p();
    p(`  ! Pin rejected during this run: ${driverManifest.pin_rejection}`);
  }
  p();
}

console.log(out.join("\n"));
