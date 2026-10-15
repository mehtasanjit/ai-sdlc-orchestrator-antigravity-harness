/**
 * Approval integrity, driven through the real scripts and the agy hook over
 * stdin:
 *   - plugin/scripts/record-gate.mjs writes each gate answer with the
 *     artifact's SHA-256 and the reply verbatim;
 *   - under a live contract the hook refuses a write to an artifact a gate
 *     approved, until a revise is recorded, and refuses a hand-written gate line;
 *   - a file Gate 0 froze as conditional is refused until an
 *     approved-conditional record opens it;
 *   - the close-out and the manifest refuse `completed` when an approved
 *     artifact changed, with or without a contract;
 *   - hand-written gates.jsonl lines from earlier runs still load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { approvalVerdict, readGateLines } from "../../plugin/scripts/lib/gate-record.mjs";
import { readGates, runOutcome } from "../../plugin/agy/telemetry/runWindow.mjs";
import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";
import { headlessVerdict } from "../../plugin/agy/run.mjs";
import { outsideContract } from "../../plugin/agy/writeGuard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(ROOT, "plugin", "agy", "hooks", "write-contract-check.mjs");
const WRITE_CONTRACT = join(ROOT, "plugin", "scripts", "write-contract.mjs");
const RECORD_GATE = join(ROOT, "plugin", "scripts", "record-gate.mjs");
const MMO_LOG = join(ROOT, "plugin", "scripts", "mmo-log.mjs");
const POLICY = "antigravity-flash38-plus-opus5";
const RUN = "20261015-113821-bugfix-login-password";
const OWN = `.sdlc/runs/${RUN}`;
const CONDITION = "if route error-handling is needed";

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const recordGate = (root, ...args) => node(RECORD_GATE, [`--run-id=${RUN}`, ...args, `--project-root=${root}`]);
const close = (root, ...args) => node(WRITE_CONTRACT, ["--close", `--run-id=${RUN}`, ...args, `--project-root=${root}`]);
const hook = (root, toolCall) =>
  JSON.parse(spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ toolCall, workspacePaths: [root] }), encoding: "utf8", cwd: root }).stdout);
const writeFile = (root, path) => hook(root, { name: "write_to_file", args: { TargetFile: join(root, path), CodeContent: "x" } });
const replaceIn = (root, path) => hook(root, { name: "replace_file_content", args: { TargetFile: join(root, path), TargetContent: "a", ReplacementContent: "b" } });
const shell = (root, CommandLine) => hook(root, { name: "run_command", args: { CommandLine } });

/** The bf-chat2 project: auth.js and its spec in scope, index.js only on a condition, and the run's folder. */
function project({ freeze = true, conditional = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "approval-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  for (const f of ["auth.js", "auth.spec.js", "index.js"]) writeFileSync(join(root, "src", f), `// ${f}\n`);
  const runDir = join(root, OWN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "discovery.md"), "# Discovery\n");
  if (freeze) {
    const fz = node(WRITE_CONTRACT, [
      "--freeze", `--run-id=${RUN}`, '--allowlist=["src/auth.js","src/auth.spec.js"]', '--off-limits=[".env",".sdlc/**","node_modules/**"]',
      "--test-command=none", ...(conditional ? ["--conditional=src/index.js", `--condition=${CONDITION}`] : []), `--project-root=${root}`,
    ]);
    assert.equal(fz.status, 0, fz.stderr);
  }
  return { root, runDir };
}

const approveRequirements = (root, runDir, text = "# Requirements\nFR-18: src/index.js MUST remain unmodified\n") => {
  writeFileSync(join(runDir, "requirements.md"), text);
  const r = recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/requirements.md`, "--reply=approved");
  assert.equal(r.status, 0, r.stderr);
};

test("record-gate writes the gate line with the artifact's SHA-256 and the reply verbatim", () => {
  const { root, runDir } = project({ freeze: false });
  try {
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\n");
    const reply = `revise: keep FR-18, but "index.js" > the route may log`;
    let r = recordGate(root, "--gate=1", "--decision=revise", `--artifact=${OWN}/requirements.md`, `--reply=${reply}`);
    assert.equal(r.status, 0, r.stderr);
    r = recordGate(root, "--gate=1", "--decision=approved", `--artifact=${join(runDir, "requirements.md")}`, "--reply", "approved");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Gate 1 approved for \.sdlc\/runs\/.*\/requirements\.md/);
    const [revise, approved] = readGateLines(runDir);
    assert.equal(revise.reply, reply, "the reply is kept as relayed");
    assert.deepEqual(
      { ...approved, ts: typeof approved.ts },
      { gate: 1, decision: "approved", artifact: `${OWN}/requirements.md`, sha256: sha(join(runDir, "requirements.md")), reply: "approved", ts: "string", run_id: RUN, written_by: "plugin/scripts/record-gate.mjs" },
    );
    assert.ok(Number.isFinite(Date.parse(approved.ts)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("record-gate refuses a gate line it cannot stand behind", () => {
  const { root, runDir } = project({ freeze: false });
  try {
    const lines = () => readGateLines(runDir) ?? [];
    assert.match(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/requirements.md`).stderr, /records the person's reply/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/requirements.md`, "--reply=approved").stderr, /no file at/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved", "--artifact=requirements.md", "--reply=approved").stderr, /relative to the project root/);
    assert.match(recordGate(root, "--gate=1", "--decision=fine", `--artifact=${OWN}/discovery.md`, "--reply=ok").stderr, /is not one of/);
    assert.match(recordGate(root, "--gate=7", "--decision=approved", `--artifact=${OWN}/discovery.md`, "--reply=ok").stderr, /--gate must be/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved", "--artifact=../elsewhere.md", "--reply=ok").stderr, /outside the project/);
    assert.match(recordGate(root, "--gate=1", "--decision=auto-approved", `--artifact=${OWN}/discovery.md`, "--reply=approved").stderr, /takes no --reply/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved-conditional", "--artifact=src/index.js", "--reply=yes").stderr, /Gate 0 decision/);
    assert.match(recordGate(root, "--gate=0", "--decision=approved-conditional", "--artifact=src/index.js", "--reply=yes").stderr, /no live write contract/);
    assert.equal(lines().length, 0, "a refusal writes nothing");

    assert.equal(recordGate(root, "--gate=1", "--decision=auto-approved", `--artifact=${OWN}/discovery.md`).status, 0, "a headless gate mode's decision carries no reply");
    assert.equal(lines()[0].reply, null);

    approveRequirements(root, runDir);
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\nFR-18 rewritten\n");
    const again = recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/requirements.md`, "--reply=approved");
    assert.equal(again.status, 2);
    assert.match(again.stderr, /changed after Gate 1 approved it .* no revise was recorded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the hook refuses a write to an approved artifact under a live contract, and allows it after a recorded revise", () => {
  const { root, runDir } = project();
  try {
    assert.equal(writeFile(root, `${OWN}/requirements.md`).decision, "allow", "not yet approved");
    approveRequirements(root, runDir);
    for (const reply of [replaceIn(root, `${OWN}/requirements.md`), writeFile(root, `${OWN}/REQUIREMENTS.md`), shell(root, `echo FR-18 >> ${join(runDir, "requirements.md")}`)]) {
      assert.equal(reply.decision, "deny");
      assert.match(reply.reason, /approved artifact of run .*Gate 1 recorded it approved/);
      assert.match(reply.reason, /Stop and ask them/);
      assert.match(reply.reason, /never write an approval, resolution or escalation note yourself/);
      assert.match(reply.reason, /record-gate\.mjs" --run-id=\S+ --gate=1 --decision=revise --artifact=\.sdlc\/runs\/\S+\/requirements\.md --reply=/);
    }
    assert.equal(writeFile(root, `${OWN}/state.json`).decision, "allow", "the rest of the run folder stays writable");

    assert.equal(recordGate(root, "--gate=1", "--decision=revise", `--artifact=${OWN}/requirements.md`, "--reply=revise: let FR-18 allow logging").status, 0);
    assert.equal(replaceIn(root, `${OWN}/requirements.md`).decision, "allow", "a recorded revise re-opens it");
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\nFR-18 revised\n");
    assert.equal(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/requirements.md`, "--reply=approved").status, 0);
    assert.equal(replaceIn(root, `${OWN}/requirements.md`).decision, "deny", "approved again, locked again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("under a live contract only record-gate writes gates.jsonl, and its own command line goes through", () => {
  const { root, runDir } = project();
  try {
    const gates = join(runDir, "gates.jsonl");
    for (const reply of [writeFile(root, `${OWN}/gates.jsonl`), shell(root, `echo '{"gate":1,"decision":"approved"}' >> ${gates}`)]) {
      assert.equal(reply.decision, "deny");
      assert.match(reply.reason, /gate record of live run .*Only plugin\/scripts\/record-gate\.mjs writes it/);
    }
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\n");
    const line = `node "${RECORD_GATE}" --run-id=${RUN} --gate=1 --decision=revise --artifact=${OWN}/requirements.md --reply="revise: index.js > auth.js, then cp it" --project-root="${root}"`;
    assert.equal(shell(root, line).decision, "allow", "the quoted reply is prose, not a redirect or a copy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a conditional file is refused until Gate 0's approved-conditional is recorded, then allowed", () => {
  const { root } = project();
  try {
    const contract = JSON.parse(readFileSync(join(root, ".sdlc", "local", "write-contract.json"), "utf8"));
    assert.deepEqual(contract.conditional, [{ path: "src/index.js", condition: CONDITION }]);
    assert.equal(writeFile(root, "src/auth.js").decision, "allow");
    const refused = writeFile(root, "src/index.js");
    assert.equal(refused.decision, "deny");
    assert.ok(refused.reason.includes(`only on the condition Gate 0 froze: "${CONDITION}"`), refused.reason);
    assert.match(refused.reason, /stop and ask them, quoting the condition/);
    assert.match(refused.reason, /--gate=0 --decision=approved-conditional --artifact=src\/index\.js --reply=/);
    assert.equal(writeFile(root, "src/INDEX.js").decision, "deny", "the condition holds in any letter case");

    assert.match(recordGate(root, "--gate=0", "--decision=approved-conditional", "--artifact=src/auth.js", "--reply=yes").stderr, /not a conditional file of run .*"src\/index\.js"/);
    const opened = recordGate(root, "--gate=0", "--decision=approved-conditional", "--artifact=src/index.js", "--reply=yes, the route needs a 400 handler");
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(readGateLines(join(root, OWN)).at(-1).condition, CONDITION);
    assert.equal(writeFile(root, "src/index.js").decision, "allow");
    assert.equal(writeFile(root, "src/INDEX.js").decision, "deny", "an approval grants exactly the path it names");
    assert.equal(replaceIn(root, "src/index.js").decision, "allow", "an opened file is not an approved artifact: it stays writable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--freeze takes each --conditional with its --condition, and the after-run check honours the approval", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-freeze-"));
  mkdirSync(join(root, ".git"));
  try {
    const base = ["--freeze", `--run-id=${RUN}`, '--allowlist=["src/**"]', "--test-command=none", `--project-root=${root}`];
    for (const extra of [["--conditional=src/index.js"], ["--condition=if needed"], ["--conditional=src/a.js", "--condition=if a", "--conditional=src/b.js"]]) {
      const r = node(WRITE_CONTRACT, [...base, ...extra]);
      assert.equal(r.status, 2, extra.join(" "));
      assert.match(r.stderr, /--conditional '<glob>' --condition/);
    }
    const contract = { allowlist: ["src/**"], off_limits: [], conditional: [{ path: "src/index.js", condition: "if needed" }] };
    assert.deepEqual(outsideContract(["src/a.js", "src/index.js"], contract), ["src/index.js"], "conditional wins over a wider allowlist");
    assert.deepEqual(outsideContract(["src/a.js", "src/index.js"], contract, { opened: ["src/index.js"] }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the close-out refuses completed when an approved artifact changed, and the manifest records it", () => {
  const { root, runDir } = project();
  try {
    approveRequirements(root, runDir);
    copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(runDir, "policy_snapshot.yaml"));
    writeFileSync(join(runDir, "telemetry.jsonl"), "");
    node(MMO_LOG, ["--event=run.start", `--run-id=${RUN}`, "--mode=brownfield", "--intent=bugfix", `--project-root=${root}`]);
    writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
    assert.equal(recordGate(root, "--gate=4", "--decision=accepted", `--artifact=${OWN}/SUMMARY.md`, "--reply=accept").status, 0);
    const manifest = () => buildHarnessManifest({ runDir, policyName: POLICY, runId: RUN, env: {} });
    assert.deepEqual([manifest().harness.completed, manifest().harness.status], [true, "completed"]);
    assert.equal(manifest().harness.gates.at(-1).reply, "accept", "the manifest carries the reply as recorded");

    // A write the hook does not model still lands on disk.
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\nFR-18 rewritten by the conductor\n");
    const m = manifest();
    assert.deepEqual([m.harness.completed, m.harness.status], [false, "incomplete"]);
    assert.deepEqual(m.harness.approved_artifact_changed.map((c) => [c.path, c.gate, c.state]), [[`${OWN}/requirements.md`, 1, "changed"]]);
    assert.match(m.harness.incomplete_reason, /requirements\.md \(changed after Gate 1 approved it\)/);
    const refused = close(root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /cannot end as completed: approved artifact\(s\) no longer match their gate record/);
    assert.equal(readGateLines(runDir).length, 2, "nothing written");

    assert.equal(recordGate(root, "--gate=1", "--decision=revise", `--artifact=${OWN}/requirements.md`, "--reply=revise: rewrite FR-18").status, 0);
    assert.equal(close(root).status, 2, "re-opened and never approved again");
    assert.equal(manifest().harness.approved_artifact_changed[0].state, "reopened");
    assert.equal(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/requirements.md`, "--reply=approved").status, 0);
    assert.equal(manifest().harness.approved_artifact_changed, undefined);
    const closed = close(root);
    assert.equal(closed.status, 0, closed.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a greenfield run has no contract, and still does not complete with a changed approved artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "approval-green-"));
  const runDir = join(root, ".sdlc", "runs", RUN);
  mkdirSync(runDir, { recursive: true });
  try {
    writeFileSync(join(runDir, "design.md"), "# Design\n");
    assert.equal(recordGate(root, "--gate=2", "--decision=approved", `--artifact=${OWN}/design.md`, "--reply=approved").status, 0);
    assert.equal(writeFile(root, `${OWN}/design.md`).decision, "allow", "no contract, so no lock: the close-out is the check");
    assert.equal(headlessVerdict({ outputDir: runDir, runId: RUN, mode: "greenfield", summaryWritten: true }).completed, true);
    writeFileSync(join(runDir, "design.md"), "# Design, edited\n");
    const verdict = headlessVerdict({ outputDir: runDir, runId: RUN, mode: "greenfield", summaryWritten: true });
    assert.equal(verdict.completed, false);
    assert.match(verdict.reason, /design\.md \(changed after Gate 2 approved it\)/);
    const approvals = approvalVerdict(runDir, RUN);
    assert.deepEqual([approvals.held, approvals.checked, approvals.changed[0].current_sha256], [false, 1, sha(join(runDir, "design.md"))]);
    const outcome = runOutcome({ runDir, gates: [{ gate: 4, decision: "accepted" }], approvals });
    assert.equal(outcome.completed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hand-written gates.jsonl lines from earlier runs still load; in a record-gate run they decide nothing", () => {
  const { root, runDir } = project();
  try {
    const old = [
      { gate: 0, artifact: `${OWN}/discovery.md`, decision: "approved", note: "Gate 0 approved by user" },
      { gate: 1, artifact: `${OWN}/requirements.md`, decision: "approved", note: "Gate 1 approved by user" },
      { gate: 4, artifact: `${OWN}/SUMMARY.md`, decision: "accepted", note: "Gate 4 accepted by user" },
    ];
    writeFileSync(join(runDir, "gates.jsonl"), old.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\n");
    writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
    const gates = readGates(runDir);
    assert.deepEqual(gates, old.map(({ note, ...g }) => g), "the old shape loads as before");
    assert.equal(runOutcome({ runDir, gates }).completed, true, "an old run's Gate 4 still completes it");
    assert.equal(approvalVerdict(runDir, RUN).checked, 0);
    assert.equal(replaceIn(root, `${OWN}/requirements.md`).decision, "allow", "a hand-written approval locks nothing");
    assert.equal(writeFile(root, "src/index.js").decision, "deny", "and opens no conditional file");

    writeFileSync(join(runDir, "design.md"), "# Design\n");
    assert.equal(recordGate(root, "--gate=2", "--decision=approved", `--artifact=${OWN}/design.md`, "--reply=approved").status, 0);
    const mixed = runOutcome({ runDir, gates: readGates(runDir) });
    assert.deepEqual([mixed.completed, mixed.gate_lines_ignored], [false, 3], "the hand-written Gate 4 no longer counts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bf-chat2 replayed: the approved requirements and the conditional route file are both refused", () => {
  const { root, runDir } = project();
  try {
    assert.equal(recordGate(root, "--gate=0", "--decision=approved", `--artifact=${OWN}/discovery.md`, "--reply=approved").status, 0);
    approveRequirements(root, runDir, "| FR-18 | src/index.js MUST remain unmodified; escalate via OQ-1 |\n| OQ-1 | open |\n");
    const before = sha(join(runDir, "requirements.md"));

    const rewrite = hook(root, {
      name: "replace_file_content",
      args: { TargetFile: join(runDir, "requirements.md"), TargetContent: "| OQ-1 | open |", ReplacementContent: "| OQ-1 | Resolved & Approved at Gate 0 / Gate 1 |" },
    });
    assert.equal(rewrite.decision, "deny");
    assert.match(rewrite.reason, /approved artifact .*Changing an approved artifact is the person's decision/);

    const route = hook(root, { name: "write_to_file", args: { TargetFile: join(root, "src", "index.js"), CodeContent: "app.post('/login', handler)\n" } });
    assert.equal(route.decision, "deny");
    assert.ok(route.reason.includes(CONDITION), route.reason);

    const gateLine = shell(root, `echo '{"gate": 1, "decision": "approved"}' >> ${join(runDir, "gates.jsonl")}`);
    assert.equal(gateLine.decision, "deny", "and the gate record cannot be hand-written");
    assert.equal(sha(join(runDir, "requirements.md")), before);
    const denials = readFileSync(join(root, ".sdlc", "local", "guard-decisions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((d) => d.decision === "deny");
    assert.deepEqual(denials.map((d) => d.matched_rule), ["approved-artifact", "conditional", "gate-record"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the playbooks record gates with record-gate and treat a request for approval as a gate", () => {
  const read = (...p) => readFileSync(join(ROOT, "plugin", ...p), "utf8");
  for (const [name, text] of [["pipeline", read("skills", "pipeline", "SKILL.md")], ["brownfield-guide", read("skills", "brownfield-guide", "SKILL.md")], ["conductor", read("agy", "prompts", "conductor.md")], ["rules", read("rules", "AGENTS.md")]]) {
    assert.match(text, /record-gate\.mjs/, name);
    assert.doesNotMatch(text, /append (one|a) line[^.]*gates\.jsonl/i, `${name} no longer has the conductor hand-write gates.jsonl`);
    assert.match(text, /approval\s+is\s+a\s+gate/, `${name}: a request for approval is a gate`);
    assert.match(text, /[Nn]ever write an approval,\s+resolution\s+or\s+escalation\s+note\s+yourself/, name);
  }
  assert.match(read("skills", "pipeline", "SKILL.md"), /--conditional='<path>' --condition='<condition>'/, "Gate 0 freezes an if-needed file as conditional");
});
