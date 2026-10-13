---
name: brownfield-guide
description: "The shared seven-step brownfield operating manual. Every brownfield entry point — `/mmo:brownfield` and the seven per-job commands (`/mmo:bugfix`, `/mmo:docs`, `/mmo:test`, `/mmo:refactor`, `/mmo:deps`, `/mmo:feature-new`, `/mmo:feature-extend`) — points here. Step 4 branches on an optional handover the invoking command supplies: intent (job type already chosen), seed_description (the user's own words for the job), and intent_from_seed (propose the job type from seed_description)."
---

You are the conductor, following this operating manual. Work through the steps in order. Do not skip
a step because the answer seems obvious. Do not begin the pipeline until Gate 0 is approved.

**Prerequisite check:** if the user has not yet run the plugin's setup (`plugin install` + build
+ credential check), refuse politely and point them at SETUP.md. This command is for the task work;
setup is one-time per machine and happens separately.

**The handover.** The invoking command's prompt may contain a block naming `intent:` and/or
`seed_description:`. Read it before step 4:

- `intent: <id>` present — the job type is already chosen. Skip step 4a's question entirely;
  Gate 0 still re-confirms it. `<id>` must be one of the ids in
  [plugin/config/intents.json](/plugin/config/intents.json).
- `seed_description:` present and non-empty — the user's own words for the job, typed after the
  command. Step 4b treats this as the answer to the interview's first question and asks only the
  remaining ones.
- `intent_from_seed: true` with a non-empty `seed_description` (the ``/mmo:brownfield <text>``
  case) — propose the job type from the wording at step 4a, confirm it with one question, then
  continue as if `intent: <id>` had been supplied. With an empty `seed_description` this line
  is inert.
- `run_id`, `project_root`, `output_dir` and `code_dir` (headless launches only) — the launcher
  chose them. Use them everywhere this guide says `<run-id>`, `.sdlc/runs/<run-id>` and the code
  directory; do not mint a run id of your own. Your shell does not start in the project on a
  headless launch, so every `--project-root="$(pwd)"` below is `--project-root="<project_root>"`,
  and every relative `.sdlc/...` path is under `<project_root>`. `output_dir` is
  `<project_root>/.sdlc/runs/<run_id>` and `code_dir` the project root unless the launch said otherwise.
- `intent_source: inferred` next to `intent: <id>` (headless launches only) — the launcher
  already ran step 4a's inference on `seed_description`. Treat `intent` as chosen; say on Gate
  0's Intent line that it was proposed from the wording.
- Neither `intent` nor a usable `intent_from_seed` (the plain ``/mmo:brownfield`` case) — step
  4 runs exactly as written below: ask which job type, then run the full interview.

---

# 1. Setup-status check — resume or fresh

Before anything else, record when this run started — the collector counts your own model calls
from this moment (`run_started_at`, used at Phase 9):

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```

Then invoke:

```bash
node "${MMO_PLUGIN_ROOT}/scripts/session-hydrate.mjs" --json
```

Read the JSON. Three cases:

- **`resume.pending: true` with `kind: "setup"`** — a previous session died mid-setup. Print
  something like *"Setup was interrupted at section &lt;N&gt; — resuming shepherd from there..."*
  and re-run the remaining setup sections (see §3 below). Do **not** start Gate 0 until setup
  completes.

- **`resume.pending: true` with `kind: "run"`** — a previous task run was interrupted at phase
  &lt;phase&gt;. Print *"A previous &lt;intent&gt; run (`&lt;run_id&gt;`) was interrupted at phase &lt;phase&gt;.
  Would you like to resume it, or start fresh?"* Accept `resume`, `discard`, or `abort`. If
  `resume`, follow the resume path in [plugin/skills/pipeline/SKILL.md](/plugin/skills/pipeline/SKILL.md).
  If `discard`, end the interrupted run so its contract stops holding the project — ask first,
  since ending a run is the user's decision:
  `node "${MMO_PLUGIN_ROOT}/scripts/write-contract.mjs" --abandon --run-id=<run_id> --reason="discarded at resume" --project-root="$(pwd)"`
  — then clear `.sdlc/local/state.json` and continue to step 2.

- **`resume.pending: null`** — normal flow. Print the one-line `marker` from the hydrate
  output (e.g. *"SDLC: 3 prior runs (last: docs, 2d ago); baseline at abc1234; no open resume
  checkpoint."*) so the user has context, then continue to step 2.

# 2. Pre-check the pipeline

Verify the machinery works on this specific repo before spending money on a real intent.

**On the first brownfield invocation per project** OR when `.sdlc/pre-check-status.json` is missing
OR when the baseline hint from step 1 says the baseline is stale, run the full 6-step pre-check.
Otherwise (cached, fresh, plugin version unchanged), report *"pre-check cached from &lt;date&gt;,
all steps still valid"* and skip to step 3.

Script-side steps (2, 4, 5, 6) — you invoke via Bash:

```bash
node "${MMO_PLUGIN_ROOT}/scripts/pre-check.mjs" --run
```

Agent-side steps (1 = discovery smoke, 3 = dispatch smoke) — you run yourself:

1. **Discovery smoke.** Run the discovery read yourself (see [discovery.md](discovery.md) — cheap
   local reading with your own shell and file tools, no dispatch) with `mode: first-time` (or `refresh` if a baseline exists). Watch for a non-git-repo refusal
   or any hard error. On pass, record it:
   ```bash
   echo '{"note":"Tier 1 completed cleanly"}' | node "${MMO_PLUGIN_ROOT}/scripts/pre-check.mjs" --record discovery pass
   ```

3. **Dispatch smoke.** One Gemini Flash call. The policy routes `task_type: "smoke"` to the
   mechanical tier; the free `preflight_dispatch` at Rule 0 already proves every model the policy
   names is reachable, so the smoke never goes to Opus. Write this TaskPacket to
   `.sdlc/runs/<run-id>/smoke-packet.json`:
   ```json
   { "id": "smoke-1", "phase": "pre_check", "task_type": "smoke", "module": "smoke",
     "instruction": "Return the literal string OK", "inputs": [], "outputSchema": { "type": "object" },
     "acceptance": ["Returns OK"], "budget": { "maxInputTokens": 500, "maxOutputTokens": 50 },
     "pass_id": "<run-id>" }
   ```
   Dispatch it through `call_mcp_tool` → `mmo_model-dispatch` / `execute_with_model` (with
   `telemetry_path` set to the run's telemetry file) when the bridge is connected to this session,
   otherwise:
   ```bash
   node "${MMO_PLUGIN_ROOT}/agy/dispatch.mjs" --packet=".sdlc/runs/<run-id>/smoke-packet.json" \
     --out=".sdlc/runs/<run-id>/smoke-result.json" --policy=<policy> --project-root="$(pwd)" \
     --telemetry=".sdlc/runs/<run-id>/telemetry.jsonl"
   ```
   The call costs cents, and its telemetry row puts them on the run's Gemini line. If it returns
   its expected output within the timeout, record pass:
   ```bash
   echo '{"tiers_tested":["gemini-flash"]}' | node "${MMO_PLUGIN_ROOT}/scripts/pre-check.mjs" --record dispatch pass
   ```

If any pre-check step fails, **do not proceed to Gate 0.** Print the reported remediation and
offer inline choices (fix now / switch policy / abort). Do not kick the user out to external
fixes.

# 3. Discovery — Tier 1 (with adaptive profile if triggered)

If not already done during step 2's smoke:

Run the discovery read. It covers the repo (git state, stack manifests, off-limits, monorepo
signals, submodules, LFS, competing AI configs — see [discovery.md](discovery.md) for the full
read order) and writes:
- `.sdlc/runs/<run-id>/discovery.md` (per-run human-readable)
- `.sdlc/runs/<run-id>/baseline.json` (per-run pointer snapshot)
- `.sdlc/baseline/current.json` + `.sdlc/baseline/discovery.md` (living project baseline, on
  first-time or full refresh)
- `.sdlc/baseline/stack-profile.md` (Tier 2b, only when triggered — unknown stack, custom
  framework in AGENTS.md, or `--adaptive-profile` passed)

Wait for discovery to finish. If it refuses (non-git repo), stop here — the shepherd already
printed the git-init guidance.

Then record it. Discovery is your own read — never dispatch it as a packet; the policy has no
rule for it — so it leaves no telemetry row unless you write one. Log a zero-cost `in_session`
row in the run's telemetry, once per run, whether the read happened here or in step 2's smoke:

```bash
node "${MMO_PLUGIN_ROOT}/agy/dispatch.mjs" \
  --log-phase=discovery --task-type=in_session \
  --module=repo --reason='conductor-local Tier 1 read of the repo; no dispatch' \
  --policy=<default_policy from .sdlc/project.json> --run-id=<run-id> \
  --telemetry=".sdlc/runs/<run-id>/telemetry.jsonl" \
  --out=".sdlc/runs/<run-id>/discovery-in_session-receipt.json"
```

In an interactive session with the bridge connected, `log_telemetry` writes the same row (see the
telemetry contract in `pipeline/SKILL.md`). Without it, the run's manifest lists `discovery`
under `harness.unrecorded_phases`.

# 4. Intent brief — pick the intent and describe the job

Two things to collect from the user. Both go into `.sdlc/runs/<run-id>/intent_brief.md`.

**a. Intent.**

- **Handover carries `intent: <id>`** — already chosen. Skip the question; read `title`,
  `summary`, and `interview` for `<id>` from
  [plugin/config/intents.json](/plugin/config/intents.json) and continue to step 4b.
- **Handover carries `intent_from_seed: true` and a non-empty `seed_description`** — propose
  the job type before asking for it. Run:

  ```bash
  node "${MMO_PLUGIN_ROOT}/scripts/infer-intent.mjs" --json "<seed_description>"
  ```

  Read `intent` from the JSON. When it is an id, read that intent's `title` and `summary` from
  `intents.json` and ask one question:

  > This reads as a **<title>** job — <summary> Right? (`yes` / name another: docs, bugfix,
  > feature-extend, feature-new, refactor, test, deps)

  `yes` takes the proposal; a named id takes that instead. On an unattended run (gates set to
  auto-approve) take the proposal without asking and record that in the gate log. When
  `intent` is null, say why — the `candidates` that collided, or that nothing matched — and
  fall through to the seven-option question below. Either way, continue to step 4b with
  `seed_description` as the first answer.
- **Neither** — ask which job type. Show the seven options with one-line examples, drawn
  from `intents.json`'s `title` and `example` fields, so the choice is meaningful:

  - `docs` — write API docs, README, ADRs, docstrings for the auth module
  - `bugfix` — fix the /login endpoint returning 500 on missing password
  - `feature-extend` — add a `?filter` param to the existing /users endpoint
  - `feature-new` — add a webhooks module (endpoint, storage, retry loop)
  - `refactor` — extract shared date logic into a util module and update all call sites
  - `test` — backfill unit tests for src/payments to reach 80% line coverage
  - `deps` — upgrade jest 28 → 29 (and adapt breaking changes)

**b. Source — describe the specific job.** Three ways to get it:
- **Interview (default)** — ask the intent's `interview` questions from `intents.json` (2–4
  short questions), then draft the brief from the answers. **If the handover carries a non-empty
  `seed_description`**, treat it as the answer to the first question and ask only the rest. Show
  the draft back, ask to approve or edit.
- **Bring your own file** — if the user says they have a brief already, ask for the path.
  Read it, ask to confirm it's the right one.
- **Inline chat** — if the user just describes it in this message (and no `seed_description` was
  already supplied by the handover), capture their words verbatim into the brief.

**Task type — only when the chosen intent declares `task_types` in `intents.json`.** Ask one more
question after the interview above, offering each option's `label`: *"Which kind of &lt;intent&gt; job
is this — &lt;label 1&gt; or &lt;label 2&gt;?"* Record the chosen `id`. Intents with no `task_types` array
(everything except `docs`, for now) skip this — nothing changes for them.

Write the brief to `.sdlc/runs/<run-id>/intent_brief.md` with this heading contract:

```
# Intent Brief — <intent> — <short title>

## Context
## Goal
## Task type          (omit this heading entirely when the intent has no task_types)
## Files in scope
## Files off-limits
## Acceptance criteria
## Non-goals
```

"Task type" holds the chosen `id` verbatim (e.g. `doc_update`), not the label — Phase 4 in
`pipeline/SKILL.md` reads it back to set the generated TaskPacket's `task_type` field directly,
instead of inferring it from context. A policy can then route `doc_update` differently from
`doc_addition` via an ordinary `rules[].when.task_type` match — no new policy schema needed, since
`task_type` is already a routing key.

Fill in "Files in scope" and "Files off-limits" with your best guess based on discovery + intent
+ the user's description. These are proposals; Gate 0 lets the user adjust before commit.

# 5. Gate 0 — Discovery Confirmation

The one confirmation moment before real work begins. Fires unconditionally — even when the
handover pre-set `intent` and `seed_description`, nothing below is skipped. Print the gate
template from [plugin/skills/pipeline/SKILL.md](/plugin/skills/pipeline/SKILL.md) (search for
"Gate 0"), filling in:

- **Stack** — top-detected from `baseline.stacks`. Ask if it's right; accept overrides.
- **Test command** — `baseline.test_command_proposed`. Accept an override.
- **Auth mode** — `vendor`, the only mode on this runtime: every call is billed through the
  bridge on the credentials in the shell that launched agy. Required — preflight aborts
  without it. State it rather than ask; there is no in-session `estimated` mode on this runtime.
- **Policy** — read `payload.project.default_policy` from the session-hydrate output already
  captured in step 1 of this command. This is what setup wrote to `.sdlc/project.json`. If
  it is null, setup was not completed for this project — abort Gate 0 and tell the user to
  run setup first (see [SETUP.md](/SETUP.md) §5 — the one setup step that opens a browser
  for the policy console). Do not silently default and do not launch the console from here.
  On a headless launch the conductor prompt names the policy the launcher resolved (it already
  read `routing-policy.yaml`, `--policy` and `project.json` in the bridge's order): use that one,
  and do not abort for a missing `default_policy`.
  Otherwise show the resolved name; accept, or accept an on-disk policy name for this run only
  (one saved from the policy console) — a per-run override does not overwrite the project default.
- **Existing AI setup** — verbatim list from `baseline.ai_configs_detected`. Default is
  **OFF-LIMITS** for all of them. User can move any into the allowlist by naming it explicitly.
- **Intent** — from step 4a. Re-confirm, even when the handover pre-set it.
- **File scope** — the allowlist and off-limits proposed from step 4b. Let the user edit.

Reply options: `approved` / `revise: <comments>` / `abort`.

**Cost projection (single line at the bottom, before the reply prompt).** From a rough
per-intent × baseline-size table, print *"Typical cost for a &lt;intent&gt; run on a repo this size:
$X–$Y. Approve or abort."* No dedicated mini-gate; the projection is informational and part
of Gate 0's approve/revise/abort.

**Repo-state risks (surface here, don't defer).** If discovery found LFS, submodules,
encrypted secrets, failing tests before we started, or an aggressive .gitignore, list them as
extra confirmation lines with the plugin's default behavior. Example:
> ⚠ `.gitmodules` present — submodules will be treated as opaque; the plugin will never write
>   into them. Continue? [assumed yes unless you say otherwise]

On `approved`:
1. Freeze the confirmed allowlist + off-limits by code — never write the contract yourself:
   ```bash
   node "${MMO_PLUGIN_ROOT}/scripts/write-contract.mjs" --freeze --run-id=<run-id> \
     --allowlist='<JSON array of globs>' --off-limits='<JSON array of globs>' --project-root="$(pwd)"
   ```
   Add `--strict-write=off` only when the user passed it. It writes `.sdlc/local/write-contract.json`
   and the run's freeze record `.sdlc/runs/<run-id>/contract.lock.json`. The PreToolUse hook
   (`plugin/agy/hooks/write-contract-check.mjs`, wired in `plugin/hooks.json`) reads the contract
   before every file write and refuses off-limits or not-in-allowlist paths at the tool boundary.
   While the run is live it allows the run's own `.sdlc/runs/<run-id>/`, and refuses every write if
   the contract is edited after this freeze. A refusal names the rule; do not route around it.
   Headless (`agy -p`) loads no hooks, so a headless run has no write guard: see the run record's
   `harness.write_guard`.
2. Initialise the run's undo record:
   ```bash
   node "${MMO_PLUGIN_ROOT}/scripts/write-provenance.mjs" --init --run-id=<run-id> --intent=<intent> --project-root="$(pwd)"
   ```
3. Update `.sdlc/runs/<run-id>/intent_brief.md` with the final scope.
4. Mark the run's start (interactive only; a headless launch records its own window). The manifest
   and the driver collector read this line; `<run_started_at>` is the time recorded in step 1:
   ```bash
   node "${MMO_PLUGIN_ROOT}/scripts/mmo-log.mjs" --event=run.start --run-id=<run-id> --started-at=<run_started_at> --mode=brownfield --intent=<intent> --policy=<policy> --project-root="$(pwd)"
   ```
5. Continue to step 6.

On `revise: <comments>` — rewrite the affected parts and re-show Gate 0.

On `abort` — nothing was frozen, so there is nothing to switch off. Do not delete the run directory
(leave it as a partial record), and stop.

If the run stops at any later gate on `abort`, or for any reason after the freeze, end it so the
contract stops holding the project:

```bash
node "${MMO_PLUGIN_ROOT}/scripts/write-contract.mjs" --close --run-id=<run-id> --outcome=aborted --project-root="$(pwd)"
```

# 6. Run the pipeline

Follow [plugin/skills/pipeline/SKILL.md](../pipeline/SKILL.md) with:
- `mode: brownfield`
- `intent: <from Gate 0>`
- `run_id: <YYYYMMDD-HHMMSS-<intent>-<slug>>` — or, on a headless launch, the handover's `run_id`
- `intent_brief_path: .sdlc/runs/<run-id>/intent_brief.md`
- `baseline_path: .sdlc/baseline/current.json`
- `policy: <as configured by setup — see the Policy bullet of Gate 0>`
- `auth_mode: vendor` — the only mode on this runtime (the Auth mode bullet of Gate 0); the
  bridge's preflight requires it and refuses to guess which transport bills the run.
- `code_dir: <the project's working directory — the repo root, since edits land across the
  existing tree, not into one generated folder>`
- `output_dir: .sdlc/runs/<run-id>` — where `requirements.md`, `design.md`,
  `security_review.md`, `packets.json`, `telemetry.jsonl`, `manifest.json`, and the final report
  land for this run.

You then drive phases 1 through 9 with gates 1, 2, 3, 4 as usual — but branched by
intent (see the Intent matrix in SKILL.md). At each gate, relay the gate prompt to the user; do
not answer on their behalf.

# 7. Close out

After the final report:

1. End the run, after Gate 4 is accepted and the pipeline's `run.end` line and manifest rebuild
   ran (the pipeline's "Run start and end markers" section). This records the contract's end and
   switches it off; until it runs, the contract refuses the ledger writes below:
   ```bash
   node "${MMO_PLUGIN_ROOT}/scripts/write-contract.mjs" --close --run-id=<run-id> --project-root="$(pwd)"
   ```
2. Append a row to `.sdlc/ledger.md` (human-readable) and `.sdlc/ledger.json` (machine mirror).
   Any cost in the row is the labelled lines the manifest rebuild after `run.end` printed, copied;
   never a single total. Those carry the complete driver line; `SUMMARY.md`'s stops before Gate 4.
3. Update the project fingerprint record with a link to the ledger.
4. Print the report to the user: the labelled lines the manifest rebuild after `run.end` printed,
   each with its kind — `cash`, `modeled` or `NOT MEASURED` — never a total, never a modeled
   figure added to a cash one; files touched; and (if applicable) the `git reset` command the
   report provides as the escape hatch.

Do not propose a follow-up run.

# Flag surface (headless / repeat runs)

``/mmo:pass`` is the flag-driven twin of every brownfield entry point for scripted / CI invocations:

```
--mode brownfield --intent <docs|bugfix|feature-extend|feature-new|refactor|test|deps>
--gates auto-approve | auto-abort | prompt   (default prompt; auto-abort recommended in CI)
--from-config .sdlc/project.json              (auto-approve Gate 0 only when fingerprint matches)
--policy <name>                                (override the default routing policy)
--strict-write=off                             (downgrade write-contract hook to warnings)
--allow-dirty                                  (bypass git-dirty block if commit_strategy != none)
--recheck                                      (force pre-check re-run even when cache is valid)
--adaptive-profile                             (force Tier 2b even when a matching adapter exists)
--refresh-profile                              (force stack-profile re-scan)
```

See [plugin/skills/pass/SKILL.md](/plugin/skills/pass/SKILL.md) for the full flag contract.
