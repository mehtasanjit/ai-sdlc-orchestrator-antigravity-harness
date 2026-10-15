/**
 * Approval integrity, driven through the real scripts and the agy hook over
 * stdin:
 *   - plugin/scripts/record-gate.mjs writes each gate answer with the
 *     artifact's SHA-256 and the reply verbatim, read from a file so no shell
 *     quoting touches it, and only the decision the reply gives;
 *   - under a live contract the hook refuses a write to an artifact a gate
 *     approved, until a revise is recorded, and refuses a hand-written gate line;
 *   - a file Gate 0 froze as conditional is refused until an
 *     approved-conditional record opens it;
 *   - the close-out and the manifest refuse `completed` when an approved
 *     artifact changed, with or without a contract;
 *   - a gate record that is oversized, cut back or edited holds nothing;
 *   - hand-written gates.jsonl lines from earlier runs still load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_REPLY_BYTES, approvalVerdict, launcherGateMode, readGateLines, recordGateMode } from "../../plugin/scripts/lib/gate-record.mjs";
import { readGates, runOutcome } from "../../plugin/agy/telemetry/runWindow.mjs";
import { buildHarnessManifest } from "../../plugin/agy/manifest.mjs";
import { GATE_MODES, headlessVerdict } from "../../plugin/agy/run.mjs";
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
const shaOf = (text) => createHash("sha256").update(text).digest("hex");
const node = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...opts });
const recordGate = (root, ...args) => node(RECORD_GATE, [`--run-id=${RUN}`, ...args, `--project-root=${root}`]);
const freeze = (root, ...extra) => node(WRITE_CONTRACT, [
  "--freeze", `--run-id=${RUN}`, '--allowlist=["src/auth.js","src/auth.spec.js"]', '--off-limits=[".env",".sdlc/**","node_modules/**"]', "--test-command=none", ...extra, `--project-root=${root}`,
]);
const close = (root, ...args) => node(WRITE_CONTRACT, ["--close", `--run-id=${RUN}`, ...args, `--project-root=${root}`]);
const hook = (root, toolCall) =>
  JSON.parse(spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ toolCall, workspacePaths: [root] }), encoding: "utf8", cwd: root }).stdout);
const writeFile = (root, path) => hook(root, { name: "write_to_file", args: { TargetFile: join(root, path), CodeContent: "x" } });
const replaceIn = (root, path) => hook(root, { name: "replace_file_content", args: { TargetFile: join(root, path), TargetContent: "a", ReplacementContent: "b" } });
const shell = (root, CommandLine) => hook(root, { name: "run_command", args: { CommandLine } });

/** The bf-chat2 project: auth.js and its spec in scope, index.js only on a condition, and the run's folder. */
function project({ freeze: frozen = true, conditional = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "approval-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  for (const f of ["auth.js", "auth.spec.js", "index.js"]) writeFileSync(join(root, "src", f), `// ${f}\n`);
  const runDir = join(root, OWN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "discovery.md"), "# Discovery\n");
  if (frozen) {
    const fz = freeze(root, ...(conditional ? ["--conditional=src/index.js", `--condition=${CONDITION}`] : []));
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
    assert.equal(revise.prev_sha256, shaOf(""), "the first line follows an empty record");
    assert.deepEqual(
      { ...approved, ts: typeof approved.ts },
      {
        gate: 1, decision: "approved", artifact: `${OWN}/requirements.md`, sha256: sha(join(runDir, "requirements.md")), reply: "approved", ts: "string", run_id: RUN,
        prev_sha256: shaOf(readFileSync(join(runDir, "gates.jsonl"), "utf8").split("\n")[0] + "\n"), written_by: "plugin/scripts/record-gate.mjs",
      },
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
    assert.match(recordGate(root, "--gate=1", "--decision=auto-approved", `--artifact=${OWN}/discovery.md`, "--reply=approved").stderr, /takes no reply/);
    assert.match(recordGate(root, "--gate=1", "--decision=auto-approved", `--artifact=${OWN}/discovery.md`).stderr, /run .* has no launcher record \(gate-mode\.json\)/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/discovery.md`, "--reply=approved", "--note=looks wrong").stderr, /unknown option --note/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/discovery.md`, `--reply=${"x".repeat(MAX_REPLY_BYTES + 1)}`).stderr, /a reply is at most 16384/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/discovery.md`, "--reply=ok", `--reply-file=${OWN}/gate-reply.txt`).stderr, /give the reply once/);
    for (const file of [`${OWN}/discovery.md`, "src/gate-reply.txt", `${OWN}/nested/gate-reply.txt`]) {
      assert.match(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/discovery.md`, `--reply-file=${file}`).stderr, /names a gate-reply\*\.txt file directly in the run folder/, file);
    }
    assert.equal(readFileSync(join(runDir, "discovery.md"), "utf8"), "# Discovery\n", "a file that is not a reply file is neither read nor removed");
    assert.match(recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/discovery.md`, `--reply-file=${OWN}/gate-reply.txt`).stderr, /no reply file at/);
    assert.match(recordGate(root, "--gate=1", "--decision=approved-conditional", "--artifact=src/index.js", "--reply=yes").stderr, /Gate 0 decision/);
    assert.match(recordGate(root, "--gate=0", "--decision=approved-conditional", "--artifact=src/index.js", "--reply=yes").stderr, /no live write contract/);
    assert.equal(lines().length, 0, "a refusal writes nothing");

    recordGateMode(runDir, RUN, "auto-approve");
    assert.equal(launcherGateMode(runDir, RUN), "auto-approve");
    assert.equal(recordGate(root, "--gate=1", "--decision=auto-approved", `--artifact=${OWN}/discovery.md`).status, 0, "a run the launcher started unattended records its mode's decision, with no reply");
    assert.equal(lines()[0].reply, null);
    assert.match(recordGate(root, "--gate=1", "--decision=auto-aborted", `--artifact=${OWN}/discovery.md`).stderr, /was launched with --gates=auto-approve/);
    unlinkSync(join(runDir, "gate-mode.json"));

    approveRequirements(root, runDir);
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\nFR-18 rewritten\n");
    const again = recordGate(root, "--gate=1", "--decision=approved", `--artifact=${OWN}/requirements.md`, "--reply=approved");
    assert.equal(again.status, 2);
    assert.match(again.stderr, /changed after Gate 1 approved it .* no revise was recorded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("record-gate records only the decision the reply gives", () => {
  const { root, runDir } = project({ freeze: false });
  try {
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\n");
    const art = `--artifact=${OWN}/requirements.md`;
    for (const [decision, reply, why] of [
      ["revise", "approved", /a revise is the person's "revise: <comments>", and the reply "approved" does not begin with "revise"/],
      ["reject", "accept", /does not begin with "reject"/],
      ["abort", "approved", /does not begin with "abort"/],
      ["approved", "revise: keep FR-18", /begins with "revise", which is not approved: record --decision=revise/],
      ["accepted", "Reject: the summary is wrong", /begins with "reject"/],
      ["approved", "  ABORT", /begins with "abort"/],
      ["approved", "Revised FR-18 is fine", /begins with "revise"/],
    ]) {
      const r = recordGate(root, "--gate=1", `--decision=${decision}`, art, `--reply=${reply}`);
      assert.equal(r.status, 2, `${decision} / ${reply}`);
      assert.match(r.stderr, why);
    }
    assert.equal(readGateLines(runDir), null, "nothing is written");
    for (const [decision, reply] of [["approved", "approved, go ahead"], ["revise", "Revise: FR-18 may log"], ["approved", "lgtm"], ["reject", "reject: redo"], ["abort", "abort"]]) {
      if (decision === "approved") writeFileSync(join(runDir, "requirements.md"), `# Requirements ${reply}\n`);
      assert.equal(recordGate(root, "--gate=1", `--decision=${decision}`, art, `--reply=${reply}`).status, 0, `${decision} / ${reply}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the reply goes through a file, byte for byte, with the command the hook hands the conductor", () => {
  const { root, runDir } = project();
  try {
    approveRequirements(root, runDir);
    const refusal = replaceIn(root, `${OWN}/requirements.md`).reason;
    const [, file, command] = refusal.match(/write their reply word for word to (\S+) with write_to_file, then run (node .*?--project-root="[^"]+")/);
    assert.equal(file, `${OWN}/gate-reply.txt`);
    const reply = 'revise: return "Invalid credentials" on a bad password, keep `src/index.js` unchanged, cap retries at $5, run $(echo HACKED) first; it\'s fine if cost > $5\nsecond line \\ done\n';
    assert.equal(writeFile(root, file).decision, "allow", "the conductor writes the reply file with its file tool");
    writeFileSync(join(root, file), reply);
    assert.equal(shell(root, command).decision, "allow", "the hook lets the command it suggested through");
    const sh = spawnSync("/bin/sh", ["-c", command.replace(/^node /, `"${process.execPath}" `)], { cwd: join(root, "src"), encoding: "utf8" });
    assert.equal(sh.status, 0, sh.stderr);
    const line = readGateLines(runDir).at(-1);
    assert.deepEqual([line.decision, line.reply], ["revise", reply.replace(/\n$/, "")], "stored as written, one trailing newline aside");
    assert.ok(!existsSync(join(root, file)), "the reply file is removed once recorded");
    assert.ok(!existsSync(join(root, "src", ".sdlc")), "run from a subfolder, it still records into the project's run folder");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("record-gate refuses a project root that is not the run's", () => {
  const { root, runDir } = project();
  try {
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\n");
    const fromSrc = node(RECORD_GATE, [`--run-id=${RUN}`, "--gate=1", "--decision=revise", `--artifact=${OWN}/requirements.md`, "--reply=revise: x"], { cwd: join(root, "src") });
    assert.equal(fromSrc.status, 2);
    assert.match(fromSrc.stderr, /belongs to the project at \S+approval-\w+: pass --project-root=/);
    const other = mkdtempSync(join(tmpdir(), "approval-other-"));
    try {
      const r = recordGate(other, "--gate=1", "--decision=revise", `--artifact=${OWN}/requirements.md`, "--reply=revise: x");
      assert.match(r.stderr, /no run folder at/);
      assert.ok(!existsSync(join(other, ".sdlc")), "and creates none");
    } finally { rmSync(other, { recursive: true, force: true }); }
    assert.equal(readGateLines(runDir), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an auto decision belongs to a run the launcher started in that mode; in a chat it completes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-launch-"));
  try {
    writeFileSync(join(dir, "brief.md"), "# brief\n");
    const out = join(dir, "out");
    const r = spawnSync(process.execPath, [join(ROOT, "plugin", "agy", "run.mjs"), `--project-root=${dir}`, `--output-dir=${out}`, "--gates=auto-abort", "--allow-unverified-pin", "--agy-bin=/nonexistent/agy", "--run-id=t"], { encoding: "utf8" });
    assert.match(r.stderr, /could not launch/);
    assert.equal(launcherGateMode(out, "t"), "auto-abort", "run.mjs records the gate mode before agy starts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(GATE_MODES["auto-approve"], /gate record/, "an unattended concern goes in the final report; the gate record takes no note");

  const { root, runDir } = project();
  try {
    writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
    assert.match(recordGate(root, "--gate=4", "--decision=auto-approved", `--artifact=${OWN}/SUMMARY.md`).stderr, /no launcher record/);
    assert.equal(shell(root, `echo '{"run_id":"${RUN}","gates":"auto-approve","written_by":"plugin/agy/run.mjs"}' > ${join(runDir, "gate-mode.json")}`).decision, "deny", "the launcher's record is not the conductor's to write");
    recordGateMode(runDir, RUN, "auto-approve");
    assert.equal(recordGate(root, "--gate=4", "--decision=auto-approved", `--artifact=${OWN}/SUMMARY.md`).status, 0);
    const chat = runOutcome({ runDir, gates: readGates(runDir) });
    assert.deepEqual([chat.completed, chat.auto_decisions_in_prompt_run], [false, [{ gate: 4, decision: "auto-approved", artifact: `${OWN}/SUMMARY.md` }]], "no launcher record of the run: a chat, where no person gave that answer");
    assert.equal(runOutcome({ runDir, gates: readGates(runDir), launcher: { provisional: true } }).completed, true, "a headless run's auto-approved Gate 4 completes it");
    copyFileSync(join(ROOT, "plugin", "config", "policies", `${POLICY}.yaml`), join(runDir, "policy_snapshot.yaml"));
    writeFileSync(join(runDir, "telemetry.jsonl"), "");
    const m = buildHarnessManifest({ runDir, policyName: POLICY, runId: RUN, env: {} });
    assert.deepEqual([m.harness.gate_mode, m.harness.completed, m.harness.auto_decisions_in_prompt_run.length], ["prompt", false, 1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the hook refuses a write to an approved artifact under a live contract, and allows it after a recorded revise", () => {
  const { root, runDir } = project();
  try {
    assert.equal(writeFile(root, `${OWN}/requirements.md`).decision, "allow", "not yet approved");
    approveRequirements(root, runDir);
    const bypass = [
      `bash -c 'echo FR-18 >> ${OWN}/requirements.md'`,
      `eval true --reply ';echo "| OQ-1 | Resolved |" > ${OWN}/requirements.md'`,
      `echo x > "${join(runDir, "requirements.md")}"`,
    ];
    for (const reply of [replaceIn(root, `${OWN}/requirements.md`), writeFile(root, `${OWN}/REQUIREMENTS.md`), shell(root, `echo FR-18 >> ${join(runDir, "requirements.md")}`), ...bypass.map((c) => shell(root, c))]) {
      assert.equal(reply.decision, "deny");
      assert.match(reply.reason, /approved artifact of run .*Gate 1 recorded it approved/);
      assert.match(reply.reason, /Stop and ask them/);
      assert.match(reply.reason, /never write an approval, resolution or escalation note yourself/);
      assert.match(reply.reason, /record-gate\.mjs" --run-id=\S+ --gate=1 --decision=revise --artifact=\.sdlc\/runs\/\S+\/requirements\.md --reply-file=\.sdlc\/runs\/\S+\/gate-reply\.txt --project-root="/);
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
    for (const reply of [writeFile(root, `${OWN}/gates.jsonl`), shell(root, `echo '{"gate":1,"decision":"approved"}' >> ${gates}`), shell(root, `eval true --condition ';echo x >> ${OWN}/gates.jsonl'`)]) {
      assert.equal(reply.decision, "deny");
      assert.match(reply.reason, /gate record of live run .*Only plugin\/scripts\/record-gate\.mjs writes it/);
    }
    assert.equal(shell(root, `eval true --reply ';echo k=v > .env'`).decision, "deny", "a prose flag on another command is judged");
    writeFileSync(join(runDir, "requirements.md"), "# Requirements\n");
    const line = `node "${RECORD_GATE}" --run-id=${RUN} --gate=1 --decision=revise --artifact=${OWN}/requirements.md --reply='revise: index.js > auth.js, then cp it' --project-root="${root}"`;
    assert.equal(shell(root, line).decision, "allow", "record-gate's quoted reply is prose, not a redirect or a copy");
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
    assert.match(refused.reason, /--gate=0 --decision=approved-conditional --artifact=src\/index\.js --reply-file=/);
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
    for (const outside of ["/src/index.js", "../src/index.js"]) {
      const r = node(WRITE_CONTRACT, [...base, `--conditional=${outside}`, "--condition=if needed"]);
      assert.equal(r.status, 2, outside);
      assert.match(r.stderr, /lies outside the project/);
    }
    const contract = { allowlist: ["src/**"], off_limits: [], conditional: [{ path: "src/index.js", condition: "if needed" }] };
    assert.deepEqual(outsideContract(["src/a.js", "src/index.js"], contract), ["src/index.js"], "conditional wins over a wider allowlist");
    assert.deepEqual(outsideContract(["src/a.js", "src/index.js"], contract, { opened: ["src/index.js"] }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a conditional path spelled with ./, a doubled slash or in full is frozen project-relative, and enforced", () => {
  const spellings = (root) => ["./src/index.js", "src//index.js", "src/./index.js", join(root, "src", "index.js")];
  for (const i of [0, 1, 2, 3]) {
    const { root } = project({ freeze: false });
    try {
      const spelled = spellings(root)[i];
      const fz = node(WRITE_CONTRACT, ["--freeze", `--run-id=${RUN}`, '--allowlist=["src/**"]', "--test-command=none", `--conditional=${spelled}`, "--condition=if needed", `--project-root=${root}`]);
      assert.equal(fz.status, 0, fz.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(root, ".sdlc", "local", "write-contract.json"), "utf8")).conditional, [{ path: "src/index.js", condition: "if needed" }], spelled);
      assert.equal(writeFile(root, "src/index.js").decision, "deny", `${spelled}: the wider src/** does not open it`);
      assert.equal(writeFile(root, "src/auth.js").decision, "allow");
      assert.equal(recordGate(root, "--gate=0", "--decision=approved-conditional", `--artifact=${spelled}`, "--reply=yes").status, 0, spelled);
      assert.equal(writeFile(root, "src/index.js").decision, "allow");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

/** Gate 0 recorded, then the freeze (which keeps the record's SHA-256), then Gates 1 and 2 approved. */
function anchoredRun() {
  const p = project({ freeze: false });
  assert.equal(recordGate(p.root, "--gate=0", "--decision=approved", `--artifact=${OWN}/discovery.md`, "--reply=approved").status, 0);
  const fz = freeze(p.root, "--conditional=src/index.js", `--condition=${CONDITION}`);
  assert.equal(fz.status, 0, fz.stderr);
  const lock = JSON.parse(readFileSync(join(p.runDir, "contract.lock.json"), "utf8"));
  assert.deepEqual(lock.gate_record, { bytes: readFileSync(join(p.runDir, "gates.jsonl")).length, sha256: sha(join(p.runDir, "gates.jsonl")) });
  approveRequirements(p.root, p.runDir);
  writeFileSync(join(p.runDir, "design.md"), "# Design\n");
  assert.equal(recordGate(p.root, "--gate=2", "--decision=approved", `--artifact=${OWN}/design.md`, "--reply=approved").status, 0);
  return p;
}

test("a gate record that is edited, cut back past the freeze or oversized holds nothing, and the hook then refuses the run folder", () => {
  const gates = (runDir) => join(runDir, "gates.jsonl");
  for (const [name, tamper, problem] of [
    ["a line removed", (runDir) => writeFileSync(gates(runDir), readFileSync(gates(runDir), "utf8").split("\n").filter((l) => !l.includes('"gate":1')).join("\n")), /line 2 of gates\.jsonl does not follow the record before it/],
    ["a recorded hash edited", (runDir) => {
      const lines = readFileSync(gates(runDir), "utf8").split("\n");
      lines[1] = JSON.stringify({ ...JSON.parse(lines[1]), sha256: "0".repeat(64) });
      writeFileSync(gates(runDir), lines.join("\n"));
    }, /line 3 of gates\.jsonl does not follow/],
    ["the record deleted", (runDir) => unlinkSync(gates(runDir)), /no longer begins with the \d+ bytes it held when Gate 0 froze the contract/],
    ["a line that no longer parses", (runDir) => writeFileSync(gates(runDir), readFileSync(gates(runDir), "utf8") + "{oops\n"), /1 line\(s\) of gates\.jsonl after its first record-gate line do not parse/],
    ["oversized", (runDir) => writeFileSync(gates(runDir), readFileSync(gates(runDir), "utf8") + `${" ".repeat(4 * 1024 * 1024)}\n`), /over the 4194304 a gate record is read up to/],
  ]) {
    const { root, runDir } = anchoredRun();
    try {
      assert.equal(approvalVerdict(runDir, RUN).held, true, name);
      tamper(runDir);
      const verdict = approvalVerdict(runDir, RUN);
      assert.equal(verdict.held, false, name);
      assert.match(verdict.record_problem, problem, name);
      for (const path of [`${OWN}/requirements.md`, `${OWN}/state.json`, `${OWN}/gate-reply.txt`]) {
        const r = writeFile(root, path);
        assert.equal(r.decision, "deny", `${name}: ${path}`);
        assert.match(r.reason, /gate record of live run .* cannot be trusted: .*every write to its run folder is refused/);
      }
      assert.equal(writeFile(root, "src/auth.js").decision, "allow", `${name}: the project's allowlist is unchanged`);
      assert.match(recordGate(root, "--gate=1", "--decision=revise", `--artifact=${OWN}/requirements.md`, "--reply=revise: x").stderr, /cannot be trusted/, name);
      const closed = close(root);
      assert.equal(closed.status, 2, name);
      assert.match(closed.stderr, /cannot end as completed: the gate record cannot be trusted/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
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
  const { root, runDir } = project({ freeze: false });
  try {
    assert.equal(recordGate(root, "--gate=0", "--decision=approved", `--artifact=${OWN}/discovery.md`, "--reply=approved").status, 0);
    assert.equal(freeze(root, "--conditional=src/index.js", `--condition=${CONDITION}`).status, 0, "Gate 0 shows src/index.js 'if route error-handling is needed': frozen as conditional");
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

    // The same reasoning through the scripts: the person's "approved" answers cannot be reused for a change.
    const reuse = recordGate(root, "--gate=1", "--decision=revise", `--artifact=${OWN}/requirements.md`, "--reply=approved");
    assert.match(reuse.stderr, /does not begin with "revise"/);
    writeFileSync(join(runDir, "SUMMARY.md"), "# Summary\n");
    assert.match(recordGate(root, "--gate=4", "--decision=auto-approved", `--artifact=${OWN}/SUMMARY.md`).stderr, /no launcher record/);
    assert.equal(replaceIn(root, `${OWN}/requirements.md`).decision, "deny", "still locked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the playbooks record gates with record-gate and treat a request for approval as a gate", () => {
  const read = (...p) => readFileSync(join(ROOT, "plugin", ...p), "utf8");
  for (const [name, text] of [["pipeline", read("skills", "pipeline", "SKILL.md")], ["brownfield-guide", read("skills", "brownfield-guide", "SKILL.md")], ["conductor", read("agy", "prompts", "conductor.md")], ["rules", read("rules", "AGENTS.md")]]) {
    assert.match(text, /record-gate\.mjs/, name);
    assert.doesNotMatch(text, /append (one|a) line[^.]*gates\.jsonl/i, `${name} no longer has the conductor hand-write gates.jsonl`);
    assert.match(text, /approval\s+is\s+a\s+gate/, `${name}: a request for approval is a gate`);
    assert.match(text, /[Nn]ever write an approval,\s+resolution\s+or\s+escalation\s+note\s+yourself/, name);
    assert.doesNotMatch(text, /--reply=/, `${name}: a reply never goes through shell quoting`);
    if (name !== "rules") assert.match(text, /--reply-file=/, name);
  }
  assert.match(read("skills", "pipeline", "SKILL.md"), /--conditional='<path>' --condition='<condition>'/, "Gate 0 freezes an if-needed file as conditional");
});
