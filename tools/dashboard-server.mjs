#!/usr/bin/env node
/**
 * Live Tokenomics & Multi-Model Communication Visualizer for Antigravity Harness.
 *
 * Usage:
 *   node tools/dashboard-server.mjs [--port=8088] [--project-root=examples/quick-demo]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseCliArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

const CLI_ARGS = parseCliArgs(process.argv.slice(2));
const PORT = Number(CLI_ARGS.port || process.env.PORT || 8088);

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function safeReadJsonl(p) {
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function safeReadText(p, maxLen = 35000) {
  try {
    const txt = fs.readFileSync(p, "utf8");
    return txt.length > maxLen ? txt.slice(0, maxLen) + "\n...[truncated]..." : txt;
  } catch {
    return null;
  }
}

function parseDriverSteps(events) {
  const steps = [];
  let maxStep = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCache = 0;
  let totalThinking = 0;
  let latestDesc = "Initializing...";
  let convId = "";
  let modelName = "";

  const byIndex = new Map();
  for (const ev of events || []) {
    if (ev.event === "init") {
      convId = ev.conversation_id || "";
      modelName = ev.init?.model || "gemini-3.8-flash-high";
    } else if (ev.event === "step_update" && ev.step_update) {
      const su = ev.step_update;
      if (su.step_index > maxStep) maxStep = su.step_index;
      if (su.step_type === "agent_response" && su.state === "DONE") {
        const u = su.usage || {};
        totalIn += Number(u.input_tokens || 0);
        totalOut += Number(u.output_tokens || 0);
        totalCache += Number(u.cache_read_tokens || 0);
        totalThinking += Number(u.thinking_tokens || 0);
      }
      byIndex.set(su.step_index, su);
      if (su.step_type === "tool") {
        latestDesc = `Step #${su.step_index} · ${su.tool_name} (${su.state})`;
      } else if (su.step_type === "agent_response") {
        latestDesc = `Step #${su.step_index} · Conductor Reasoning (${su.state})`;
      }
    } else if (ev.event === "result") {
      latestDesc = `COMPLETE (${ev.result?.status || "done"})`;
    }
  }

  for (const su of Array.from(byIndex.values())) {
    if (su.step_type === "tool") {
      const params = su.tool_info?.parameters || {};
      const target = params.CommandLine || params.Path || JSON.stringify(params);
      const isDispatch = String(target).includes("dispatch.mjs");
      steps.push({
        step_index: su.step_index,
        type: isDispatch ? "dispatch" : "tool",
        state: su.state,
        name: su.tool_name,
        duration: su.duration_seconds ? `${su.duration_seconds.toFixed(2)}s` : "running...",
        detail: String(target),
        output: su.tool_info?.output ? String(su.tool_info.output).slice(0, 600) : "",
      });
    } else if (su.step_type === "agent_response") {
      const u = su.usage || {};
      steps.push({
        step_index: su.step_index,
        type: "llm",
        state: su.state,
        name: "Conductor LLM Turn",
        duration: su.duration_seconds ? `${su.duration_seconds.toFixed(1)}s` : "thinking...",
        detail: `in: ${u.input_tokens || 0} · out: ${u.output_tokens || 0} · think: ${u.thinking_tokens || 0} · cache_read: ${u.cache_read_tokens || 0}`,
        output: "",
      });
    }
  }

  return {
    convId,
    modelName,
    maxStep,
    totalIn,
    totalOut,
    totalCache,
    totalThinking,
    latestDesc,
    steps,
  };
}

function parseWorkerInstances(orchLog, packetMap, resultMap, telemetry) {
  const byId = new Map();
  const lines = String(orchLog || "").split(/\r?\n/);

  for (const line of lines) {
    if (line.includes("route.decide")) {
      const pid = (line.match(/packet_id=([^\s]+)/) || [])[1];
      if (!pid) continue;
      const phase = (line.match(/phase=([^\s]+)/) || [])[1] || "";
      const taskType = (line.match(/task_type=([^\s]+)/) || [])[1] || "";
      const modelId = (line.match(/model_id=([^\s]+)/) || [])[1] || "";
      const reason = (line.match(/rule_reason="([^"]+)"/) || [])[1] || "";
      const cur = byId.get(pid) || { packet_id: pid };
      byId.set(pid, { ...cur, phase, task_type: taskType, model_id: modelId, rule_reason: reason, status: cur.status || "ROUTING" });
    } else if (line.includes("dispatch.start")) {
      const pid = (line.match(/packet_id=([^\s]+)/) || [])[1];
      if (!pid) continue;
      const modelId = (line.match(/model_id=([^\s]+)/) || [])[1] || "";
      const ts = (line.match(/MMO:\s+([^\s]+)/) || [])[1] || "";
      const cur = byId.get(pid) || { packet_id: pid };
      byId.set(pid, { ...cur, model_id: modelId || cur.model_id, started_at: ts, status: "RUNNING" });
    } else if (line.includes("dispatch.end")) {
      const pid = (line.match(/packet_id=([^\s]+)/) || [])[1];
      if (!pid) continue;
      const ok = (line.match(/ok=([^\s]+)/) || [])[1] === "true";
      const lat = Number((line.match(/latency_ms=(\d+)/) || [])[1] || 0);
      const cost = Number((line.match(/cost_usd=([0-9.]+)/) || [])[1] || 0);
      const cur = byId.get(pid) || { packet_id: pid };
      byId.set(pid, { ...cur, status: ok ? "DONE" : "FAILED", latency_ms: lat, cost_usd: cost });
    }
  }

  (telemetry || []).forEach((t, idx) => {
    const pid = t.task_id || `dispatch_${idx + 1}`;
    const cur = byId.get(pid) || { packet_id: pid };
    byId.set(pid, {
      ...cur,
      telemetry_idx: idx,
      phase: t.phase || cur.phase || "",
      task_type: t.task_type || cur.task_type || "",
      model_id: t.model || t.model_id || cur.model_id || "",
      wallet: t.wallet?.name || cur.wallet || "",
      status: "DONE",
      latency_ms: t.latency_ms || cur.latency_ms || 0,
      cost_usd: t.cost_usd ?? cur.cost_usd ?? 0,
      tokens_in: t.input_tokens || 0,
      tokens_out: t.output_tokens || 0,
    });
  });

  for (const [pid, pkt] of Object.entries(packetMap || {})) {
    const cur = byId.get(pid) || { packet_id: pid };
    const hasRes = Boolean(resultMap?.[pid]);
    const goal =
      pkt?.task?.goal ||
      pkt?.task?.title ||
      pkt?.goal ||
      pkt?.instruction ||
      pkt?.instructions ||
      pkt?.description ||
      (Array.isArray(pkt?.target_files) ? `Files: ${pkt.target_files.join(", ")}` : "");
    const phase = cur.phase || pkt?.phase || "";
    const taskType = cur.task_type || pkt?.task_type || pkt?.task?.type || "";
    const inferredTier =
      String(cur.model_id || "").toLowerCase().includes("opus") ||
      ["requirements_analysis", "architecture_design", "plan_task_packets", "senior_code_review", "security_review"].includes(phase)
        ? "deep"
        : "light";
    byId.set(pid, {
      ...cur,
      phase,
      task_type: taskType,
      goal: String(goal || "").slice(0, 110),
      status: cur.status === "DONE" || hasRes ? "DONE" : "RUNNING",
      tier: inferredTier,
    });
  }

  const all = Array.from(byId.values()).map((w) => {
    const m = String(w.model_id || "").toLowerCase();
    const tier =
      w.tier ||
      (m.includes("opus") || ["requirements_analysis", "architecture_design", "plan_task_packets", "senior_code_review", "security_review"].includes(w.phase)
        ? "deep"
        : "light");
    return { ...w, tier };
  });

  return {
    deep: all.filter((w) => w.tier === "deep"),
    light: all.filter((w) => w.tier === "light"),
  };
}

function listAvailableRuns(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(runsDir)) {
    const full = path.join(runsDir, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        const real = fs.realpathSync(full);
        entries.push({ name, mtimeMs: st.mtimeMs, real });
      }
    } catch {
      // ignore broken symlinks
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.map((e) => e.name);
}

function collectAntigravityRun(scenario = "quick-demo", requestedRun = "") {
  const exDir = CLI_ARGS["project-root"]
    ? path.resolve(REPO_ROOT, String(CLI_ARGS["project-root"]))
    : path.join(REPO_ROOT, "examples", scenario);
  const runsDir = path.join(exDir, ".sdlc", "runs");
  const availableRuns = listAvailableRuns(runsDir);

  let runId = requestedRun;
  if (!runId || !availableRuns.includes(runId)) {
    const preferred = `${scenario}-${requestedRun}`;
    if (requestedRun && availableRuns.includes(preferred)) {
      runId = preferred;
    } else if (availableRuns.length > 0) {
      runId = availableRuns[0];
    } else {
      runId = requestedRun || "latest";
    }
  }

  const dir = path.join(runsDir, runId);
  const telemetry = safeReadJsonl(path.join(dir, "telemetry.jsonl"));
  const manifest = safeReadJson(path.join(dir, "manifest.json"));
  const driverManifest = safeReadJson(path.join(dir, "driver-manifest.json"));
  const driverCost = safeReadJsonl(path.join(dir, "driver-cost-modeled.jsonl"));
  const driverEvents = safeReadJsonl(path.join(dir, "driver-events.jsonl"));
  const driver = parseDriverSteps(driverEvents);
  const gates = safeReadJsonl(path.join(dir, "gates.jsonl"));
  const state = safeReadJson(path.join(dir, "state.json"));
  const preflight = safeReadJson(path.join(dir, "preflight.json"));
  const orchLog = safeReadText(path.join(dir, "orchestrator.log"), 40000) || "";
  const reportTxt = safeReadText(path.join(dir, "report.txt"), 40000) || "";

  const packetMap = {};
  const resultMap = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("tp_") && f.endsWith(".result.json")) {
        const id = f.replace(".result.json", "");
        resultMap[id] = safeReadJson(path.join(dir, f));
      } else if (f.startsWith("res_") && f.endsWith(".json")) {
        const id = "tp_" + f.slice(4, -5);
        resultMap[id] = safeReadJson(path.join(dir, f));
      } else if (f.startsWith("tp_") && f.endsWith(".json")) {
        const id = f.replace(".json", "");
        packetMap[id] = safeReadJson(path.join(dir, f));
      }
    }
  }

  const usesAgyCli = orchLog.includes("flash-agy-cli") || JSON.stringify(preflight || {}).includes("flash-agy-cli");

  return {
    runId,
    availableRuns,
    dir,
    exists: fs.existsSync(dir),
    conductor: `Antigravity CLI (agy · ${driver.modelName || "gemini-3.8-flash-high"})`,
    judgeWorker: "Claude Agent SDK Worker (claude-opus-5)",
    fastWorker: usesAgyCli
      ? "Gemini 3.8 Flash (flash-agy-cli via agy -p seat)"
      : "Gemini 3.8 Flash (flash-completion via API/Vertex)",
    policy: manifest?.policy_name || "antigravity-flash38-plus-opus5",
    preflight,
    telemetry,
    manifest,
    driverManifest,
    driverCost,
    driver,
    gates,
    state,
    packetMap,
    resultMap,
    workers: parseWorkerInstances(orchLog, packetMap, resultMap, telemetry),
    orchLog,
    reportTxt,
    artifacts: {
      "requirements.md": safeReadText(path.join(dir, "requirements.md"), 35000),
      "design.md": safeReadText(path.join(dir, "design.md"), 35000),
      "packets.json": safeReadText(path.join(dir, "packets.json"), 35000),
      "review.json": safeReadText(path.join(dir, "review.json"), 35000),
      "security_review.md": safeReadText(path.join(dir, "security_review.md"), 35000),
      "SUMMARY.md": safeReadText(path.join(dir, "SUMMARY.md"), 35000),
    },
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Antigravity Harness · Live Tokenomics & Communication Visualizer</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #1f2630;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --opus: #f0883e;
    --opus-bg: rgba(240,136,62,0.15);
    --flash: #3fb950;
    --flash-bg: rgba(63,185,80,0.15);
    --cond: #58a6ff;
    --cond-bg: rgba(88,166,255,0.15);
    --gate: #a371f7;
    --gate-bg: rgba(163,113,247,0.15);
    --warn: #d29922;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 13px; }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 100;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand h1 { margin: 0; font-size: 16px; font-weight: 700; }
  .badge-live {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--flash-bg); color: var(--flash); border: 1px solid rgba(63,185,80,0.4);
    padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--flash); animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .controls { display: flex; align-items: center; gap: 10px; }
  select, button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  }
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; font-family: var(--mono);
  }
  .pill.opus { background: var(--opus-bg); color: var(--opus); border: 1px solid rgba(240,136,62,0.35); }
  .pill.flash { background: var(--flash-bg); color: var(--flash); border: 1px solid rgba(63,185,80,0.35); }
  .pill.cond { background: var(--cond-bg); color: var(--cond); border: 1px solid rgba(88,166,255,0.35); }
  .pill.gate { background: var(--gate-bg); color: var(--gate); border: 1px solid rgba(163,113,247,0.35); }

  .top-summary { padding: 14px 20px 0; }
  .banner {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;
  }
  .kpi-row {
    display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 12px;
  }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; }
  .kpi .lbl { font-size: 10.5px; color: var(--muted); text-transform: uppercase; }
  .kpi .val { font-size: 18px; font-weight: 700; font-family: var(--mono); margin-top: 4px; }
  .kpi .sub { font-size: 11px; color: var(--muted); margin-top: 3px; }

  .grid { display: grid; grid-template-columns: 1fr 1.15fr; gap: 16px; padding: 14px 20px 24px; align-items: start; }
  .col { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: visible; display: flex; flex-direction: column; }
  .col-header { padding: 12px 16px; background: var(--panel-2); border-bottom: 1px solid var(--border); font-weight: 700; display: flex; justify-content: space-between; align-items: center; }

  .flow-list { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
  #conductorList { max-height: 680px; overflow-y: auto; scroll-behavior: smooth; }
  .flow-item {
    background: var(--bg); border: 1px solid var(--border); border-left: 4px solid var(--border);
    border-radius: 6px; padding: 9px 12px; cursor: pointer;
  }
  .flow-item:hover { border-color: var(--cond); }
  .flow-item.tier-opus { border-left-color: var(--opus); }
  .flow-item.tier-flash { border-left-color: var(--flash); }
  .flow-item.tier-cond { border-left-color: var(--cond); }
  .flow-item.tier-dispatch { border-left-color: var(--gate); background: rgba(163,113,247,0.06); }
  .flow-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .flow-meta { margin-top: 5px; font-family: var(--mono); font-size: 11.5px; color: var(--muted); word-break: break-all; }

  .tabs { display: flex; gap: 6px; padding: 10px 16px 8px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .tab-btn { background: var(--bg); border: 1px solid var(--border); padding: 5px 11px; border-radius: 5px; font-size: 11.5px; cursor: pointer; font-family: var(--mono); color: var(--text); }
  .tab-btn.active { background: var(--cond-bg); color: var(--cond); border-color: var(--cond); font-weight: 700; }
  .pre-box {
    margin: 10px 16px 16px; padding: 12px; background: #090c10; border: 1px solid var(--border);
    border-radius: 6px; font-family: var(--mono); font-size: 11.5px; line-height: 1.45;
    white-space: pre-wrap; color: #c9d1d9;
  }

  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.75);
    display: none; align-items: center; justify-content: center; z-index: 200; padding: 24px;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    width: 92%; max-width: 1100px; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden;
  }
  .modal-head {
    padding: 14px 18px; background: var(--panel-2); border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center;
  }
  .modal-body { padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
  .modal-body h4 { margin: 0 0 6px 0; color: var(--cond); font-size: 12px; text-transform: uppercase; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>Antigravity Harness · Live Tokenomics & Communication Visualizer</h1>
    <span class="badge-live"><span class="dot"></span> LIVE INCREMENTAL UPDATE</span>
  </div>
  <div class="controls">
    <label for="passSelect" style="color:var(--muted)">Run:</label>
    <select id="passSelect" onchange="onRunSelectChange()"></select>
    <button onclick="fetchData(true)">Refresh Now</button>
  </div>
</header>

<div class="top-summary" id="topSummary">Loading...</div>
<div class="grid">
  <div class="col">
    <div class="col-header">
      <span>1. Live Conductor Activity Stream (driver-events.jsonl · chronological)</span>
      <span class="pill cond" id="stepCountBadge">0 steps</span>
    </div>
    <div class="flow-list" id="conductorList"></div>
  </div>
  <div class="col">
    <div class="col-header">
      <span>2. Worker Dispatches (telemetry.jsonl & tp_*.json) + Generated Artifacts</span>
      <span class="pill flash" id="workerCountBadge">0 completed</span>
    </div>
    <div class="flow-list" id="workerList"></div>
    <div class="tabs" id="tabBar"></div>
    <pre class="pre-box" id="tabContentBox">Loading...</pre>
  </div>
</div>

<div class="modal-backdrop" id="modalBackdrop" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-head">
      <div id="modalTitle" style="font-family:var(--mono);font-weight:700;font-size:14px;">Task Packet Inspector</div>
      <button onclick="closeModal()">Close (ESC)</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
let latestRight = null;
let curTab = "orch";
let selectedRun = "";
let prevHashes = { top: "", steps: "", workers: "", tabs: "", tabBody: "", runOptions: "" };

function fmtUsd(v) { return "$" + Number(v || 0).toFixed(4); }
function fmtTok(n) {
  n = Number(n || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setIfChanged(key, elId, html, scrollToBottom = false) {
  if (prevHashes[key] === html) return;
  prevHashes[key] = html;
  const el = document.getElementById(elId);
  if (el) {
    el.innerHTML = html;
    if (scrollToBottom) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }
}

function onRunSelectChange() {
  selectedRun = document.getElementById("passSelect").value;
  fetchData(true);
}

function selectTab(tabKey) {
  curTab = tabKey;
  if (latestRight) renderTabsAndContent(latestRight, true);
}

function inspectPacket(taskId, idx) {
  if (!latestRight) return;
  const d = latestRight;
  const t = (d.telemetry || [])[idx] || {};
  const pkt = d.packetMap?.[taskId] || null;
  const res = d.resultMap?.[taskId] || null;
  document.getElementById("modalTitle").textContent = "Packet Inspector: " + (taskId || t.phase || "");
  document.getElementById("modalBody").innerHTML = \`
    <div>
      <h4>1. Telemetry & Policy Routing Receipt</h4>
      <pre class="pre-box" style="margin:0;">\${escapeHtml(JSON.stringify(t, null, 2))}</pre>
    </div>
    <div>
      <h4>2. Conductor ──▶ Worker TaskPacket (\${escapeHtml(taskId)}.json)</h4>
      <pre class="pre-box" style="margin:0;">\${escapeHtml(pkt ? JSON.stringify(pkt, null, 2) : "No packet JSON found.")}</pre>
    </div>
    <div>
      <h4>3. Worker ──▶ Conductor Response (res_\${escapeHtml((taskId||'').replace(/^tp_/,''))}.json)</h4>
      <pre class="pre-box" style="margin:0;">\${escapeHtml(res ? JSON.stringify(res, null, 2) : "In-flight or not written yet.")}</pre>
    </div>
  \`;
  document.getElementById("modalBackdrop").classList.add("open");
}

function closeModal() {
  document.getElementById("modalBackdrop").classList.remove("open");
}
window.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

function renderTabsAndContent(d, force = false) {
  const artKeys = Object.keys(d.artifacts || {}).filter(k => d.artifacts[k]);
  const validTabs = ["orch", "report", ...artKeys];
  if (!validTabs.includes(curTab)) {
    curTab = artKeys.length ? artKeys[0] : "orch";
  }

  const tabsHtml = \`
    <button class="tab-btn \${curTab === 'orch' ? 'active' : ''}" onclick="selectTab('orch')">📡 orchestrator.log</button>
    <button class="tab-btn \${curTab === 'report' ? 'active' : ''}" onclick="selectTab('report')">📊 report.txt</button>
  \` + artKeys.map(k =>
    \`<button class="tab-btn \${curTab === k ? 'active' : ''}" onclick="selectTab('\${k}')">📄 \${k}</button>\`
  ).join("");

  if (force || prevHashes.tabs !== tabsHtml) {
    prevHashes.tabs = tabsHtml;
    document.getElementById("tabBar").innerHTML = tabsHtml;
  }

  let bodyText = "";
  if (curTab === "orch") bodyText = d.orchLog || "orchestrator.log is currently empty.";
  else if (curTab === "report") bodyText = d.reportTxt || "report.txt will be generated as soon as the run finishes.";
  else bodyText = d.artifacts?.[curTab] || "Empty.";

  if (force || prevHashes.tabBody !== bodyText) {
    prevHashes.tabBody = bodyText;
    document.getElementById("tabContentBox").textContent = bodyText;
  }
}

function render(d, force = false) {
  latestRight = d;
  const runs = d.availableRuns || [d.runId];
  if (!selectedRun) selectedRun = d.runId;
  const optionsHtml = runs.map(r => \`<option value="\${escapeHtml(r)}" \${r === d.runId ? 'selected' : ''}>\${escapeHtml(r)}</option>\`).join("");
  setIfChanged("runOptions", "passSelect", optionsHtml);

  const drv = d.driver || {};
  let opusCalls = 0, flashCalls = 0, opusCost = 0, flashCost = 0;
  for (const ev of (d.telemetry || [])) {
    const m = String(ev.model || ev.model_id || "").toLowerCase();
    const c = Number(ev.cost_usd || 0);
    if (m.includes("opus")) { opusCalls++; opusCost += c; }
    else if (m.includes("flash") || m.includes("gemini")) { flashCalls++; flashCost += c; }
  }
  const packetKeys = Object.keys(d.packetMap || {});
  const resultKeys = Object.keys(d.resultMap || {});
  const deepList = (d.workers?.deep || []).map((w, i) => ({ ...w, instNum: i + 1 })).sort((a, b) => (a.status === "RUNNING" ? -1 : 1) - (b.status === "RUNNING" ? -1 : 1));
  const lightList = (d.workers?.light || []).map((w, i) => ({ ...w, instNum: i + 1 })).sort((a, b) => (a.status === "RUNNING" ? -1 : 1) - (b.status === "RUNNING" ? -1 : 1));
  const deepRunning = deepList.filter(w => w.status === "RUNNING").length;
  const lightRunning = lightList.filter(w => w.status === "RUNNING").length;
  const lastStep = (drv.steps || [])[(drv.steps || []).length - 1] || null;
  const condRunning = !String(drv.latestDesc || "").includes("COMPLETE");

  const renderWorkerChip = (w, idx, prefix, pillClass) => {
    const isRun = w.status === "RUNNING";
    const statusIcon = isRun ? "🟢 RUNNING" : "✅ DONE";
    const lat = w.latency_ms ? (w.latency_ms / 1000).toFixed(1) + "s" : (isRun ? "in-flight..." : "");
    const tIdx = w.telemetry_idx != null ? w.telemetry_idx : -1;
    const num = w.instNum || (idx + 1);
    return \`
      <div onclick="inspectPacket('\${escapeHtml(w.packet_id)}', \${tIdx})" style="background:var(--bg);border:1px solid \${isRun ? 'var(--flash)' : 'var(--border)'};border-radius:6px;padding:7px 10px;cursor:pointer;display:flex;flex-direction:column;gap:3px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <div>
            <span style="font-family:var(--mono);font-weight:700;font-size:11.5px;">\${prefix} #\${num} · \${escapeHtml(w.packet_id)}</span>
            <span class="pill \${pillClass}" style="margin-left:4px;">\${escapeHtml(w.phase || w.task_type || "")}</span>
          </div>
          <span style="font-family:var(--mono);font-size:11px;color:\${isRun ? 'var(--flash)' : 'var(--muted)'};font-weight:700;">\${statusIcon} \${lat ? '· ' + lat : ''}</span>
        </div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          \${escapeHtml(w.goal || w.rule_reason || w.task_type || "")}
        </div>
      </div>
    \`;
  };

  const topHtml = \`
    <div class="banner">
      <div>
        <div style="font-size:15px;font-weight:700;">Run: <code style="color:var(--cond)">\${escapeHtml(d.runId)}</code> · Policy: <code>\${escapeHtml(d.policy)}</code></div>
        <div style="margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;">
          <span class="pill cond">[D] Conductor: \${escapeHtml(d.conductor)}</span>
          <span class="pill opus">[J] Judgment: \${escapeHtml(d.judgeWorker)}</span>
          <span class="pill flash">[G] Mechanical: \${escapeHtml(d.fastWorker)}</span>
        </div>
      </div>
      <div>
        <span class="pill \${String(drv.latestDesc).includes('COMPLETE') ? 'flash' : 'cond'}" style="font-size:13px;padding:6px 12px;">
          ⚡ \${escapeHtml(drv.latestDesc || "Running")}
        </span>
      </div>
    </div>
    <div class="kpi-row">
      <div class="kpi">
        <div class="lbl">Conductor Live Steps</div>
        <div class="val" style="color:var(--cond)">Step #\${drv.maxStep || 0}</div>
        <div class="sub">\${fmtTok(drv.totalIn)} in · \${fmtTok(drv.totalOut)} out · \${fmtTok(drv.totalCache)} cache</div>
      </div>
      <div class="kpi">
        <div class="lbl">[J] Claude Opus 5</div>
        <div class="val" style="color:var(--opus)">\${fmtUsd(opusCost)}</div>
        <div class="sub">\${deepList.length} spawned · \${deepRunning} running (\${opusCalls} done)</div>
      </div>
      <div class="kpi">
        <div class="lbl">[G] Gemini 3.8 Flash</div>
        <div class="val" style="color:var(--flash)">\${fmtUsd(flashCost)}</div>
        <div class="sub">\${lightList.length} spawned · \${lightRunning} running (\${flashCalls} done)</div>
      </div>
      <div class="kpi">
        <div class="lbl">Task Packets Written</div>
        <div class="val">\${packetKeys.length} packets</div>
        <div class="sub">\${resultKeys.length} results received</div>
      </div>
      <div class="kpi">
        <div class="lbl">Preflight & Gates</div>
        <div class="val" style="color:var(--gate)">\${d.preflight?.ok ? "PREFLIGHT OK" : "PENDING"}</div>
        <div class="sub">Gates recorded: \${(d.gates || []).length} / 4</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:0.85fr 1.15fr 1.15fr;gap:12px;margin-top:12px;">
      <div style="background:var(--panel);border:1px solid var(--border);border-top:3px solid var(--cond);border-radius:8px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:700;color:var(--cond);">[D] Conductor (1 Instance · \${escapeHtml(drv.modelName || "gemini-3.8-flash-high")})</span>
          <span class="pill \${condRunning ? 'cond' : 'flash'}">\${condRunning ? '🟢 ACTIVE' : '✅ COMPLETE'}</span>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-family:var(--mono);font-size:11.5px;display:flex;flex-direction:column;gap:4px;">
          <div><b>Current Action:</b> \${escapeHtml(drv.latestDesc || "Idle")}</div>
          <div style="color:var(--muted);"><b>Last Step (#\${lastStep?.step_index ?? 0}):</b> \${escapeHtml(lastStep?.name || "-")} (\${escapeHtml(lastStep?.duration || "-")})</div>
          <div style="color:var(--muted);word-break:break-all;">\${escapeHtml((lastStep?.detail || "").slice(0, 140))}</div>
        </div>
      </div>

      <div style="background:var(--panel);border:1px solid var(--border);border-top:3px solid var(--opus);border-radius:8px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:700;color:var(--opus);">[J] Deep Judgment Workers (\${deepList.length} Spawned · claude-opus-5)</span>
          <span class="pill opus">\${deepRunning > 0 ? '🟢 ' + deepRunning + ' RUNNING' : '✅ ' + deepList.length + ' DONE'}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          \${deepList.map((w, i) => renderWorkerChip(w, i, "Deep", "opus")).join("") || '<div style="color:var(--muted)">No Deep workers spawned yet.</div>'}
        </div>
      </div>

      <div style="background:var(--panel);border:1px solid var(--border);border-top:3px solid var(--flash);border-radius:8px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:700;color:var(--flash);">[G] Light Mechanical Workers (\${lightList.length} Spawned · gemini-3.8-flash)</span>
          <span class="pill flash">\${lightRunning > 0 ? '🟢 ' + lightRunning + ' RUNNING' : '✅ ' + lightList.length + ' DONE'}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          \${lightList.map((w, i) => renderWorkerChip(w, i, "Light", "flash")).join("") || '<div style="color:var(--muted)">No Light workers spawned yet.</div>'}
        </div>
      </div>
    </div>
  \`;
  setIfChanged("top", "topSummary", topHtml);

  document.getElementById("stepCountBadge").textContent = (drv.steps || []).length + " events (Step #" + (drv.maxStep || 0) + ")";
  const stepItems = (drv.steps || []).map((s) => {
    const cls = s.type === "dispatch" ? "tier-dispatch" : (s.type === "llm" ? "tier-opus" : "tier-cond");
    const badge = s.type === "dispatch" ? "🚀 DISPATCH" : (s.type === "llm" ? "🧠 LLM TURN" : "🔧 " + s.name);
    const pillCls = s.state === "ACTIVE" ? "opus" : "cond";
    return \`
      <div class="flow-item \${cls}">
        <div class="flow-top">
          <div>
            <span style="font-family:var(--mono);font-weight:700;">Step #\${s.step_index}</span>
            <span class="pill \${pillCls}">\${escapeHtml(badge)} · \${escapeHtml(s.state)}</span>
          </div>
          <span style="font-family:var(--mono);color:var(--muted);">⏱ \${escapeHtml(s.duration)}</span>
        </div>
        <div class="flow-meta">\${escapeHtml(s.detail)}</div>
      </div>
    \`;
  }).join("");
  setIfChanged("steps", "conductorList", stepItems || '<div style="color:var(--muted)">Waiting for events...</div>', true);

  const inFlightCount = packetKeys.filter(k => !d.resultMap?.[k]).length;
  document.getElementById("workerCountBadge").textContent = (d.telemetry || []).length + " completed · " + inFlightCount + " in-flight";

  const teleItems = (d.telemetry || []).map((t, idx) => {
    const m = String(t.model || t.model_id || "in-session");
    const isOpus = m.toLowerCase().includes("opus");
    const isFlash = m.toLowerCase().includes("flash") || m.toLowerCase().includes("gemini");
    const cls = isOpus ? "tier-opus" : (isFlash ? "tier-flash" : "tier-cond");
    const pill = isOpus ? "opus" : (isFlash ? "flash" : "cond");
    const lat = t.latency_ms ? (t.latency_ms / 1000).toFixed(1) + "s" : "";
    const tid = t.task_id || "";
    return \`
      <div class="flow-item \${cls}" onclick="inspectPacket('\${escapeHtml(tid)}', \${idx})">
        <div class="flow-top">
          <div>
            <span style="font-family:var(--mono);font-weight:700;">#\${idx + 1} \${escapeHtml(tid || t.phase)}</span>
            <span class="pill \${pill}">\${escapeHtml(m)} [\${escapeHtml(t.wallet?.name || t.task_type || "")}]</span>
          </div>
          <span style="font-family:var(--mono);font-weight:700;">\${fmtTok(t.input_tokens)} in / \${fmtTok(t.output_tokens)} out · \${lat} · \${fmtUsd(t.cost_usd)}</span>
        </div>
        <div class="flow-meta">
          [D] Conductor ──(Rule #\${t.routing?.rule_index ?? "-"}: \${escapeHtml(t.routing?.rule_reason || "routed")})──▶ Phase: <b>\${escapeHtml(t.phase)}</b> / Role: <b>\${escapeHtml(t.task_type || "-")}</b> (click to inspect JSON)
        </div>
      </div>
    \`;
  }).join("");

  const inFlightItems = packetKeys
    .filter(k => !d.resultMap?.[k])
    .map(k => \`
      <div class="flow-item tier-dispatch" onclick="inspectPacket('\${escapeHtml(k)}', -1)">
        <div class="flow-top">
          <div>
            <span style="font-family:var(--mono);font-weight:700;">⏳ IN-FLIGHT: \${escapeHtml(k)}.json</span>
            <span class="pill gate">Worker Running...</span>
          </div>
          <span style="font-family:var(--mono);color:var(--muted);">Click to view input TaskPacket</span>
        </div>
      </div>
    \`).join("");

  setIfChanged("workers", "workerList", inFlightItems + teleItems || '<div style="color:var(--muted)">No worker dispatches recorded yet.</div>');
  renderTabsAndContent(d, force);
}

async function fetchData(force = false) {
  try {
    const res = await fetch("/api/state?scenario=quick-demo&pass=" + encodeURIComponent(selectedRun));
    const data = await res.json();
    render(data.right, force);
  } catch (e) {
    console.error(e);
  }
}

fetchData(true);
setInterval(() => fetchData(false), 2000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/api/state") {
    const scenario = url.searchParams.get("scenario") || "quick-demo";
    const passName = url.searchParams.get("pass") || "";
    const payload = {
      scenario,
      passName,
      ts: new Date().toISOString(),
      right: collectAntigravityRun(scenario, passName),
    };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Antigravity Harness Live Dashboard listening on http://127.0.0.1:${PORT}`);
});
