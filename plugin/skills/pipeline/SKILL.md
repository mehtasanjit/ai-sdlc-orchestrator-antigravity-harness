---
name: pipeline
description: The end-to-end AI-SDLC workflow definition consumed by the conductor. Defines the state machine, TaskPacket schema, HITL gates, telemetry contract, and the prompts/templates for each phase. The conductor reads this skill to know exactly what to do at each step.
---

# AI-SDLC Workflow — Conductor Playbook

This skill is the source of truth for the conductor. Whether you arrived here from `/mmo:greenfield`, `/mmo:brownfield` (or one of its seven per-job aliases), `/mmo:pass`, or the headless conductor prompt `plugin/agy/run.mjs` renders, you follow the state machine below.

---

## State machine

```
-1. preflight                       → prove every model this run dispatches to is reachable (free, no API call)
0. read_brief
1. requirements_analysis           → requirements.md
   ── GATE 1 ─────────────────────────────────────
2. architecture_design             → design.md
   ── GATE 2 ─────────────────────────────────────
3. (mixed policy only) cache_project_header  → prime the mechanical-tier model's cache
4. plan_task_packets                  → packets.json (list of TaskPackets)
5. execute_packets                    → for each: route → execute → validate → integrate → retry on failure
6. senior_code_review                 → review.json + refinement packets
   re-execute refinement packets
7. test_run                           → npm install && npm test; debug failures (route via policy)
8. security_review                    → security_review.md
   ── GATE 3 ─────────────────────────────────────
9. generate_final_report              → SUMMARY.md; manifest.json is written by code
   ── GATE 4 (final acceptance) ───────────────────
```

---

## How you dispatch

Every model call in this playbook is a TaskPacket handed to the `model-dispatch` bridge. The bridge
routes it per policy, runs it, prices it and appends the telemetry row; you never choose the model
and never write the content yourself. There are two ways to hand a packet over, and which one you
have depends on how this session was started:

**Headless (`plugin/agy/run.mjs`, the measured runs).** The Antigravity CLI loads no plugin, MCP
server or hook in print mode (p1-agy-runtime.md check 1), so the bridge is *not* in your toolset.
Write the TaskPacket to a JSON file and run:

```
node "${MMO_PLUGIN_ROOT}/agy/dispatch.mjs" \
  --packet=<path-to-packet.json> \
  --out=<path-for-result.json> \
  --policy=<policy> \
  --project-root="<project_root>" \
  --run-id=<run_id> \
  --telemetry="<output_dir>/telemetry.jsonl"
```

Then **read the result from the `--out` file**. Stdout carries only a one-line summary — do not
parse it for anything beyond a quick success check. A non-zero exit means the dispatch failed.
Keep the quotes around paths: they can contain spaces, and an unquoted one splits into separate
arguments. The script speaks MCP to the same bridge an interactive session calls directly.

**Interactive (`agy` in the workspace, plugin loaded).** The bridge's tools are reachable through
`call_mcp_tool` with the server name `mmo_model-dispatch` (agy prefixes a plugin's server with the
plugin name; the bare `model-dispatch` is refused): `execute_with_model` (the packet, plus
`policy_name`, `project_root` and `telemetry_path`), `preflight_dispatch`, `load_policy`,
`simulate_policy` and `log_telemetry`. Same tools, same TaskPacket, same result shape. If no
`mmo_model-dispatch` server is connected in the session, or `call_mcp_tool` is not in your
toolset, fall back to the command above.

The rest of this playbook says "dispatch a packet" and shows the command form; read it as either
route. Every phase's real work goes through one of them — a phase that silently becomes your own
prose is invisible to the cost record and defeats the measurement this harness exists for.

---

## Run start and end markers (interactive)

The manifest's session window, its `harness.status`, and the driver collector's window come from
two lines in `<output_dir>/orchestrator.log`. Write them with the log script, never by hand. The
script writes to `<project_root>/.sdlc/runs/<run_id>/orchestrator.log`, which is `<output_dir>`'s
log on the default layout.

Before Phase -1 on greenfield (on brownfield the guide logged it at Gate 0; do not log it twice):

```
node "${MMO_PLUGIN_ROOT}/scripts/mmo-log.mjs" --event=run.start --run-id=<run_id> --started-at=<run_started_at> --mode=greenfield --policy=<policy> --project-root="<project_root>"
```

After Gate 4 is answered `accept`, or when the run stops at any gate on `abort`, log the end and
rebuild the manifest:

```
node "${MMO_PLUGIN_ROOT}/scripts/mmo-log.mjs" --event=run.end --run-id=<run_id> --outcome=<completed|aborted> --project-root="<project_root>"
node "${MMO_PLUGIN_ROOT}/agy/manifest.mjs" "<output_dir>" --policy=<policy> --run-id=<run_id>
```

The rebuilt manifest reads the same telemetry, so its cost lines are the ones `SUMMARY.md` already
copied; it adds the run's start and end and the gate outcome. **Headless: skip both.** The launcher
records the run's window in `driver-manifest.json` and builds the manifest after you exit.

---

## Phase -1 — preflight (MANDATORY, before anything else)

```
node "${MMO_PLUGIN_ROOT}/agy/dispatch.mjs" --preflight --auth-mode=vendor \
  --policy=<policy> --project-root="<project_root>" --out="<output_dir>/preflight.json"
```

Interactive: call `preflight_dispatch` with `auth_mode: "vendor"`, `policy_name` and
`project_root` instead. Either way, **read the result before doing anything else** and write it to
`<output_dir>/preflight.json`.

**If `ok` is false, STOP.** Print the `halt_reason` verbatim, print the failing model's `error`, and end
the run. Do not read the brief, do not start phase 1, do not "try the mechanical tier and see". A policy
whose cheap tier cannot be reached does not degrade into a slightly-more-expensive run — every packet
falls back to the premium tier, and the result costs *more* than a single-model baseline while appearing
to succeed. That is the one outcome this harness exists to disprove, so it is worth refusing to start.

**If `warnings` is non-empty, print each one and keep going.** A warning is a model this run will not
dispatch to, so its failure cannot affect this run. Print them because they are true and the operator
should know. Do not treat a warning as a halt: refusing to start a viable run is not the safe error, it
is the one that teaches the operator to override a gate that exists to protect them.

**`not_selected` is not a warning and not a problem.** A policy may hold more than one way of reaching a
tier — `antigravity-flash38-plus-opus5` reaches its mechanical tier either as a Gemini model call or as an Antigravity
agent — and only the one this install selected can be dispatched to. The other is listed here, unchecked,
because its prerequisites are irrelevant to a run that will never call it. Do not report it as a failure,
do not try to "fix" it, and do not offer to install anything on its behalf.

**If `ok` is true**, report the configuration to the user in one line before phase 1 — the policy name,
each model, and on the Google Cloud path the resolved project and region — then continue. This is the only point in
the run where the operator can see what is about to be billed and to which project, while it is still
free to stop.

This call constructs each adapter, which is where credential discovery happens and where a missing or
unusable credential throws. It makes no model call and costs nothing. It exists because that
construction used to happen lazily at the first mechanical packet — phase 4 of 9, after the premium
phases were already billed — which is the worst possible moment to discover a setup problem.

`--auth-mode=vendor` is not optional and is not a choice this run makes: every model call, including
judgment work, routes through the bridge so per-phase cost attribution survives. There is no in-session
mode. The bridge still requires the argument, so pass it.

---

## Phase-by-phase prompts

Every phase below produces its artifact by dispatching a TaskPacket. You write the packet, run the
dispatch command, read the result file, and write the returned content to the artifact path. You do
not author the content yourself — a phase that silently becomes your own prose is invisible to the
cost record and defeats the measurement this harness exists for.

### Phase 1 — requirements_analysis

Dispatch a packet (`phase: "requirements_analysis"`, `task_type: "requirements"`) whose inputs carry
`<brief.md>`. Write the result to `<output_dir>/requirements.md` with sections:

- **In scope** (numbered, testable)
- **Out of scope** (numbered)
- **Functional requirements per module** (FR-1, FR-2, ...)
- **Non-functional requirements** (NFR-1, ...)
- **PII inventory** (table: field, sensitivity, protection)
- **Role matrix** (role × resource × action)
- **Acceptance criteria** (numbered, executable)
- **Open questions for HITL** (if any)

### Phase 2 — architecture_design

Dispatch a packet (`phase: "architecture_design"`, `task_type: "design"`) whose inputs carry
`<output_dir>/requirements.md`. The packet's `instruction` carries the architect role: produce a
design document covering module boundaries, the data model, the API contract, and the key
cross-cutting decisions with ADR-style rationale. Write the result to `<output_dir>/design.md`.

**Use [`roles/architect.md`](roles/architect.md) verbatim as the `instruction` body.** It carries
the full deliverable list — including the environment-variable contract that codegen turns into a
validation schema, `.env.example`, and `.env.test` — and the brownfield variant that produces
`change_plan.md` instead. Do not paraphrase it; the checklist is the value.

### Phase 4 — plan_task_packets

Dispatch a packet (`phase: "plan_task_packets"`, `task_type: "packet_plan"`) whose inputs carry
`<output_dir>/design.md` (brownfield: `change_plan.md`, `intent_brief.md` and `baseline.json`)
and `<output_dir>/requirements.md`, and whose `outputSchema` asks for a list of TaskPackets — one
per file-sized unit of work, each carrying the fields of the TaskPacket schema below. Write the
returned list to `<output_dir>/packets.json`.

The plan is the worker's, not yours. You may fill in what the worker cannot know — `pass_id`,
`intent`, and the `content` of each `inputs[]` slice it named by path — but you do not add, drop,
merge, split or re-scope a packet, and you never generate the plan with a local script or by
hand. If the returned plan is wrong, re-dispatch the planning packet with the problem stated in
its `instruction`. A plan you write yourself leaves no `plan_task_packets` row in
`telemetry.jsonl`, and the code-written manifest lists the phase under
`harness.unrecorded_phases`.

The tables below are what the planning packet's `instruction` asks the worker for.

Suggested packet types and one packet per:

| task_type | What |
|---|---|
| `prisma_schema` | full `schema.prisma` |
| `entity` | one Prisma model annotation set (if any custom) |
| `dto` | one DTO file (create/update/query DTOs grouped per resource) |
| `controller_handler` | one controller class (all routes for one resource) |
| `service_method` | one service class |
| `module_wiring` | one NestJS @Module file |
| `guard` | one guard class |
| `interceptor` | one interceptor (e.g. masking, logging) |
| `filter` | global exception filter |
| `migration` | initial migration (or `db push` script) |
| `seed_data` | seed.ts producing demo employees + roles |
| `test_unit` | unit tests per service |
| `test_integration` | integration tests per controller (Supertest) |
| `docstring` | TSDoc on public service methods |
| `readme_section` | one section of the project README |
| `adr_draft` | one ADR file |
| `env_docs` | `.env.example` — every required environment variable from `design.md` §6, no values |
| `env_test_fixture` | `.env.test` — every required environment variable with a value that satisfies the schema declared in `design.md` §6 (e.g., a 32-char string where the schema demands `min(32)`, `file:./test.db` for the DB URL, a hex-encoded fake KEK). This file is what the test runner copies to `.env` before `npm test`. |

When the app uses a validating `ConfigModule` (or Joi / Zod / envalid equivalent), packets for `env_docs` and `env_test_fixture` are **required** — omitting either is a senior-review blocker. The two files must be internally consistent: every key listed in `.env.example` must appear in `.env.test` with a schema-valid value.

### Brownfield-mode task types (v1)

The table above is greenfield-Nest-centric. In brownfield mode (`mode: brownfield`), packets use a **stack-agnostic** base set of primitives plus an optional `subtype` hint that the loaded stack adapter (`plugin/skills/pipeline/stacks/*.md`) resolves to concrete codegen guidance.

| task_type | Purpose | Common `subtype` values |
|---|---|---|
| `new_file_add` | Create a file that didn't exist at discovery time | `nest_controller` · `nest_service` · `django_view` · `fastapi_router` · `test` (see adapter) |
| `existing_file_edit` | Modify a file that already existed | `module_wiring` · `url_registration` · `router_wiring` · `django_settings` |
| `patch_apply` | Apply a specific unified diff | (rare — usually `existing_file_edit` is enough) |
| `doc_addition` | New doc under docs/ or module README | `readme` · `adr` · `runbook` · `api` |
| `doc_update` | Update an existing doc | — |
| `test_add` | New test file for new source | `unit` · `integration` · `e2e` |
| `test_backfill` | Add tests for existing untested code | Same as `test_add` |
| `bug_reproduce` | Failing test that captures the bug | — |
| `bug_diagnose` | Root-cause analysis — emit a note, not code | — |
| `bug_fix_apply` | Apply the fix identified by `bug_diagnose` | — |
| `refactor_extract` | Extract shared logic into a new utility | — |
| `dependency_add` | Add a dep + adjacent-code adjustments | `patch` · `minor` · `major` |

**Framework-owned wiring** — new controllers/routes/views usually need a corresponding
registration edit in a wiring file (Nest module, Django urls.py, FastAPI main.py's
include_router). Emit these as **paired packets** with the same `pass_id` — atomic per-pair:
if the wiring edit fails, roll back the new-file packet within the same pair.

**Every brownfield packet MUST set `artifact_path`** (§7.1) so the write-contract validator can
reject off-limits paths at dispatch time. Missing `artifact_path` is a planner bug.

**`doc_addition` vs `doc_update` — read from the brief, don't infer.** When `intent_brief.md`
carries a "## Task type" heading (only present when the chosen intent declares `task_types` in
`intents.json` — currently just `docs`), every packet you plan for this run uses that exact
`task_type` value. Do not infer `doc_addition` vs `doc_update` from file existence or context —
the user already chose it at brief-collection time (`brownfield-guide/SKILL.md` step 4b), and a
per-project policy may route the two differently (an update is a smaller edit than fresh
authoring, and might reasonably go to a cheaper model). When the heading is absent — every
non-docs intent, and `docs` runs from before this existed — infer as before.

### TaskPacket initial output-ceiling budgets

Set `budget.maxOutputTokens` per phase type. The adapter automatically doubles this ceiling on any attempt that terminates with the vendor's max-tokens stop reason (Anthropic `stop_reason: "max_tokens"`, Gemini `finishReason: "MAX_TOKENS"`), up to 3 doublings or the model's absolute output limit declared in the policy YAML (`max_output_tokens_absolute`), whichever comes first. Cached input keeps retry cost low.

- **Codegen packets:** `3000` (services, controllers, DTOs, tests). Most files fit first-shot; a few large service files double once or twice.
- **Premium packets (design, senior_code_review, security_review):** `5000`. Design and review artifacts are the ones that historically hit the ceiling.
- **Docs, ADR, README:** `3000`. Same doubling behavior.
- **Debug packets:** inherit from the packet they refine.

Every attempt emits its own TelemetryEvent with `attempt_number`, `ceiling_used`, and (on retries) `retry_reason: "output_cap"` — all sharing the packet's `task_id`. The report collapses them into one row per packet.

### Phase 5 — execute_packets

Say when the loop starts and when it ends, with the packet count. Every dispatch inside it logs
itself through the bridge (`route.decide`, `dispatch.start`/`.end` on the `MMO:` log stream), but
nothing marks the loop's own boundaries unless you do.

For each packet, in dependency order:

Dispatch it with the command above. The bridge routes per policy — you do not choose the model.
Validate the returned structured output against the schema; if invalid, construct a *refined*
packet (new id, `retry_count+1`, with the validation error appended to instruction) and
re-dispatch. The refined packet keeps the original `phase` and `task_type`: a new label
(`code_fix`, `test_refinement`, ...) matches no rule, falls to the policy default, and is
flagged `routing.fallback` in the run record. After 2 mechanical-tier retries fail, the policy
escalates to the premium tier automatically (rule with `retry_count: { gte: 2 }`) — the routing
decision is the policy's, and the escalated packet dispatches exactly like every other one.

Write the returned file content to disk at the packet's stated `artifact_path`.

**Brownfield: record every write for `/mmo:revert`.** Gate 0 ran `write-provenance.mjs --init`.
Around every file you write into the project — a packet's `artifact_path`, a refinement, a fix in
Phase 7, an `.env.example` key — run, with the run's id and the repo root:

```bash
node "${MMO_PLUGIN_ROOT}/scripts/write-provenance.mjs" --before --run-id=<run_id> --path=<artifact_path> --packet-id=<packet id> --project-root="<repo-root>"
#   ... write the file ...
node "${MMO_PLUGIN_ROOT}/scripts/write-provenance.mjs" --after --run-id=<run_id> --path=<artifact_path> --project-root="<repo-root>"
```

`--before` takes the file's first snapshot in this run (its hash, and a backup copy when git cannot
restore it) and keeps it: a retry or a second packet on the same file never replaces it, so
`/mmo:revert` restores the file as it was before the run, not an earlier attempt. A tooling step
that writes files itself (a deps run's install rewriting `package.json` and the lockfile) gets the
same `--before` for each file it writes, then the step, then `--after`. Files under the run's own
`.sdlc/runs/<run_id>/` are the record, not the project: they need no provenance. Greenfield runs
skip this; their whole tree is new.

### Phase 6 — senior_code_review

Dispatch one packet per module (`phase: "senior_code_review"`, `task_type: "review"`) whose inputs
carry the module's generated files. The packet's `instruction` carries the senior-reviewer role:
read the code module by module and emit a structured review, with a refinement TaskPacket for any
defect found. Collect the refinement packets from the results and re-dispatch them via Phase 5
mechanics. Write the collected review to `<output_dir>/review.json`.

**Use [`roles/senior-reviewer.md`](roles/senior-reviewer.md) verbatim as the `instruction` body.**
It carries the eight review criteria and the output schema.

Two obligations on this phase specifically, both spelled out in that file. **Attach whole files,
not slices** — a review packet is the one place where under-filling `inputs` yields a confidently
wrong answer instead of an obviously incomplete one, because every criterion is a search for an
absence and the worker has no tools to go looking. And when a result comes back with a non-empty
`not_verifiable` array, **widen those inputs and re-dispatch that module** before treating its
verdict as final.

### Phase 7 — test_run

**Greenfield mode.** Bootstrap the env fixture first — this is required for any app whose codegen produced a validating `ConfigModule` (or equivalent) at boot. The codegen phase is contractually required (see Phase 5 acceptance criteria and the senior review's env-fixture check) to emit `.env.example` (docs) and `.env.test` (fixture values that satisfy the declared schema).

```bash
cd <output_dir>
# Only copy .env.test → .env when neither exists. Never overwrite an existing .env —
# a real .env holds real secrets and belongs to the user.
if [ -f .env.test ] && [ ! -f .env ]; then cp .env.test .env; fi
npm install --silent && npm test
```

**Brownfield mode.** The greenfield env-copy above is refused entirely — the repo already has an `.env` (or an equivalent secrets manager) that the user manages, and copying a codegen-produced fixture would either overwrite real secrets or drop the run into a schema-invalid state. Instead:

```bash
cd <repo-root>   # NOT <output_dir> — the app-under-test is the user's actual repo
# Do NOT touch .env under any circumstances. Do NOT copy .env.test → .env.
```

If codegen introduced new required env vars (via `existing_file_edit` on `.env.example`):
1. Append the new keys to `.env.example` (this IS a permitted write — .env.example is in the allowlist by default and holds no values, only key names).
2. Print the list of new keys to the operator with a mini-gate: *"Codegen introduced N new required env vars: X, Y, Z. Populate them in your .env before Phase 7 continues, or say `skip` to run Phase 7 anyway (tests requiring these keys will fail)."*
3. Wait for the user's response before invoking the test command.

The test command in brownfield is `baseline.test_command` (confirmed at Gate 0), not hardcoded `npm test`. Working directory is the repo root (not `<output_dir>`); in monorepos, use the per-package scope from `baseline.monorepo.packages[].test_command` for whichever package the changed files belong to.

**Both modes:**

On failure:
- If the error is `Config validation error: "X" is required` or equivalent → the codegen phase missed keys. In greenfield build a debug TaskPacket routed to codegen to add the missing keys with schema-valid values. In brownfield, ask the user via the mini-gate above; do NOT patch `.env` from the harness.
- Any other failure → parse the output, build a `debug` TaskPacket with the failing test name + error + relevant source slice. Route via policy. Retry up to 2 cost-efficient tier attempts; the policy escalates to the premium tier from there.

**Test-command probe (optional Phase 0.5 in brownfield).** The pipeline pre-check (§7.4) already ran the discovered test command with `--collect-only` / `--dry-run` at prompt 1 to prove deps are installed. If pre-check step 2 failed for this run, Phase 7 halts with the recorded error rather than attempting the real run.

### Phase 8 — security_review

Dispatch a packet (`phase: "security_review"`, `task_type: "security_review"`) whose inputs carry the
generated code. The packet's `instruction` carries the security-reviewer role: a threat-model-style
pass over PII handling, authorization coverage, audit completeness, secret leakage, and dependency
risk. Write the result to `<output_dir>/security_review.md`.

**Use [`roles/security-reviewer.md`](roles/security-reviewer.md) verbatim as the `instruction`
body.** It carries the full checklist and the report format.

The dependency-risk check is a shell command, and the dispatched worker cannot run one. **Run the
stack's production-dependency audit yourself and attach its output as a file slice in `inputs`.**
If you do not, that check comes back under `## Could not verify` rather than passing — which is
correct, and is the point: the reviewer is instructed never to pass a check it could not run, and
never to report an absence it could not confirm. Attach whole files here for the same reason as
Phase 6.

### Phase 9 — generate_final_report

**Brownfield: close the undo record first**, after the last project write and before the report:

```bash
node "${MMO_PLUGIN_ROOT}/scripts/write-provenance.mjs" --finalize --run-id=<run_id> --project-root="<repo-root>"
```

It records the git head after the run and the commits between the two heads, which `/mmo:revert`
needs to tell this run's changes from a later run's.

**`manifest.json` is written by code, never by you, and it comes first.** `SUMMARY.md` copies its
cost lines; it never computes them.

1. **Interactive: collect your own usage, then run the manifest, before you write `SUMMARY.md`.**

   ```
   node "${MMO_PLUGIN_ROOT}/agy/collect-driver-usage.mjs" "<output_dir>" --run-id=<run_id> --project-root="<project_root>" --since=<run_started_at>
   node "${MMO_PLUGIN_ROOT}/agy/manifest.mjs" "<output_dir>" --policy=<policy> --run-id=<run_id>
   ```

   The first reads this session's model calls from agy's local conversation record and writes the
   modeled driver line; without it the driver line is `NOT MEASURED`. `<run_started_at>` is the
   time the entry command recorded at its first step, so the setup, pre-check and discovery calls
   before the run folder existed are counted too.

   It writes `manifest.json` and prints one labelled line per wallet, for example
   `gemini workers cash $0.59569 · claude worker modeled $5.600058 · driver NOT MEASURED`.
   `cash` is dollars a vendor invoices. `modeled` is tokens priced at a card with no invoice behind
   it (Opus on a claude.ai seat, the conductor on a Google seat). `NOT MEASURED` is a cost nothing
   recorded. **Headless: do not run it.** `run.mjs` builds `manifest.json` after you exit, once it
   has priced your own loop from the agy stream.
2. **Write `<output_dir>/SUMMARY.md`:**
   - **Cost.** Interactive: one bullet per line `manifest.mjs` printed, copied with its kind and
     figure exactly as printed. Headless: one sentence saying the labelled cost lines are in
     `manifest.json` → `cost.lines`, written by the launcher after this session. Never compute a
     total, never add a `modeled` figure to a `cash` one, and never put a figure on a
     `NOT MEASURED` line. They are different kinds of dollars; their sum is neither the bill nor
     the usage.
   - **Per phase.** The model each phase ran on, read from `<output_dir>/telemetry.jsonl`. No
     dollar figures here: one phase can mix a cash worker and a modeled one.
   - Links to the key artifacts.

Your own loop cost is not yours to compute. Headless runs get a modeled driver line from the
launcher; interactive runs get it from `collect-driver-usage.mjs`, and carry the driver as
`NOT MEASURED` only when that found nothing.

---

## TaskPacket schema (canonical)

```ts
{
  id: "tp_<phase>_<seq>",
  phase: "codegen" | "tests" | "docs" | "debug" | "refactor" | ...,
  task_type: "controller_handler" | "service_method" | ...,
  module: "employees" | "leave" | ...,
  instruction: "<imperative, <300 tokens>",
  inputs: [ { path, content, reason } ],  // SLICED — never full files unless necessary
  outputSchema: { /* JSON schema */ },
  acceptance: ["<testable bullet>", ...],
  budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },  // codegen initial; adapter doubles on max_tokens truncation up to 3× (see below)
  retry_count: 0,
  pass_id: "<run_id>",  // this run's id: the folder name under .sdlc/runs/, and every --run-id
  intent: "docs" | "bugfix" | "feature-extend" | "feature-new" | "refactor" | "test" | "deps"  // brownfield only — omit entirely on greenfield packets
}
```

**Set `intent` on every brownfield packet, from the confirmed value in `intent_brief.md`.** A
policy may route the same `phase` differently per intent (e.g. `refactor`'s Tests phase to a
different model than `docs`'s) via a rule matching on both `phase` and `intent` — the router
falls back to the phase's blanket rule when no intent-specific one exists. Omitting `intent`
silently drops the packet out of every intent-scoped rule and back onto the blanket rule, which
is exactly greenfield's existing behavior — so this is safe to skip on greenfield packets, but
never skip it on brownfield.

---

## Intent matrix — brownfield only

**Applies only when `mode: brownfield`.** Greenfield (`/mmo:greenfield`) runs the full pipeline
described above with no matrix-based branching.

In brownfield, one state machine handles seven intents. Which phases fire — and what shape their
outputs take — depends on the intent picked at Gate 0. Tier assignment (which model runs each
phase) does NOT change per intent; that's fixed by the loaded policy (§11).

| Intent | Phase 1 · requirements | Phase 2 · architecture | Phase 4 · packet plan | Phase 7 · tests | Phase 8 · security review |
|---|---|---|---|---|---|
| **docs** | scoped ("what docs?") | **SKIP** | `doc_addition` / `doc_update` packets | doc-lint only | changed files only |
| **bugfix** | reproduce + diagnose | **SKIP** unless design-affecting | `bug_reproduce` → `bug_diagnose` → `bug_fix_apply` → `test_add` | regression + focused suite | changed files only |
| **feature-extend** | delta requirements | delta `change_plan.md` | mixed `existing_file_edit` + `new_file_add` | affected suites | changed files only |
| **feature-new** | new-feature requirements | full subsystem design (`change_plan.md`) | full mix (`new_file_add`, `test_add`, `doc_addition`, wiring) | affected + new | changed files only |
| **refactor** | delta (what to preserve) | delta refactor plan | `refactor_extract` + `patch_apply` | **full suite** (invariants) | changed files only |
| **test** | coverage target | **SKIP** | `test_backfill` / `test_add` | new tests + full suite | test files only |
| **deps** | upgrade target list | dep-swap plan | `dependency_add` + adjacent-code patches | full suite + smoke | dep-diff + advisory |

**v1 specialization scope (per C6 cut).** Matrix cells are fully specified for the four "known"
intents (docs, bugfix, feature-extend, feature-new) because they map cleanly to the greenfield
behavior we already have. The three "new" intents (refactor, test, deps) route to the closest-
fitting known behavior in v1, with intent-specific prompt overrides landing in v1.5. This means
v1 ships all seven intents (surface-complete) with the last three at ~70% of full-specialized
quality; v1.5 tightens them.

**How the conductor branches.** After Gate 0 approval (which sets `intent` on the run
context), the conductor consults this table before each phase to decide: SKIP the phase, run
its default form, or run its intent-specific form. Skipped phases still emit a TelemetryEvent
with `phase: <name>, task_type: "skipped"` so downstream summaries stay complete.

**Skip semantics.**
- SKIP means the phase does not run at all — no packet dispatched, no artifact written, no gate
  fires for that phase. The gate immediately after a skipped phase is also skipped.
- Docs intent example: Phase 2 (architecture) skips → Gate 2 also skips → conductor goes
  straight from Gate 1 (requirements) to Phase 4 (packet planning).

---

## HITL gate prompt templates

**Gate delivery.** Interactive, you print the gate block yourself and wait for the user's reply,
then append one line with their decision to `<output_dir>/gates.jsonl`:
`{"gate": <N>, "artifact": "<file the gate reviewed>", "decision": "approved|revise|aborted|accepted", "note": "<one line>"}`
(`accepted` for Gate 4's `accept`; the manifest reads Gate 4's last line to mark the run completed).
Every gate is a fenced `> ⏸ **HITL Gate <N> — <Title>**` block (templates below), printed
verbatim. Headless, the conductor prompt names the gate mode (`auto-approve` or `auto-abort`):
print the block anyway, apply the mode's decision, and append the line to `<output_dir>/gates.jsonl`
that the conductor prompt specifies — a run whose gates were not reviewed by a person must say so. **Persist
the gate-pending state to `.sdlc/local/state.json` before printing** — if the session dies
mid-gate, session-hydrate detects a non-terminal state and re-prompts on the next
`/mmo:brownfield` invocation. No new command needed.

### Gate 0 — Brownfield only, before Gate 1

> ⏸ **HITL Gate 0 — Discovery Confirmation**
>
> I read your repo and produced `<sdlc_root>/runs/<run-id>/discovery.md`. Confirm:
>
> - **Stack:** `<top-detected stacks>` — correct? add/override?
> - **Test command:** `<detected>` — enter to accept, or paste the command.
> - **Policy:** `<the default_policy field setup wrote to .sdlc/project.json>` — accept, or
>   name another on-disk policy for this run only (one saved from the policy console). To change the project's
>   persistent default, re-run setup (`node "${MMO_PLUGIN_ROOT}/scripts/setup-policy.mjs"`
>   — this is the one command that opens a browser; every other setup step is terminal-only).
> - **Existing AI setup:** `<verbatim list from Tier 1 group 6>` — is any of this
>   authoritative and off-limits? **(default: OFF-LIMITS, do not touch)**
> - **Intent:** `<intent picked in step 4a of /mmo:brownfield>`
> - **File scope:**
>   - allowlist: `<paths proposed by the intent brief>` — accept / edit
>   - off-limits: **project defaults from `.sdlc/project.json.off_limits_default`** apply
>     (`.env*`, `.mcp.json`, `node_modules/**`, `.cursor/rules/**`, other AI tools'
>     settings files, `dist/**`, `.sdlc/**`, `.git/**`) — add anything else this ticket must not touch
>   - AI configs detected in the repo are added on top (see previous bullet)
> - **Repo-state risks (if any):** `<LFS / submodules / failing tests / encrypted secrets>`
> - **Regulated-repo warning (when `baseline.regulated_repo_warning_required`):** *"This repo appears regulated (signals: `<kinds>`). Confirm the active policy uses only compliant endpoints, and that off-limits protects your regulated data folders."*
> - **`.gitignore` needs `.sdlc/` entry (when `baseline.gitignore_covers_sdlc: false`):** *"Your .gitignore doesn't cover .sdlc/. Add `.sdlc/` to .gitignore as part of this run? [Y/n]"*  On yes, add `.gitignore` to the allowlist so the codegen phase can create-or-append it (a codegen packet or a small helper write, per intent). On no, note in the final report so the user gets the same follow-up prompt that surfaced in the docs-gen v1 run.
>
> Typical cost for a `<intent>` run on a repo this size: `$X.XX–$Y.YY`.
>
> Reply: `approved`, `revise: <comments>`, or `abort`.

On `approved`, freeze the write contract by code with
`node "${MMO_PLUGIN_ROOT}/scripts/write-contract.mjs" --freeze --run-id=<run_id> --allowlist='<JSON>' --off-limits='<JSON>' --project-root="$(pwd)"`
(the brownfield guide's step 5); never write `.sdlc/local/write-contract.json` yourself. Build `off_limits` by concatenating `.sdlc/project.json.off_limits_default`
(the project-level constants — `.env*`, `.mcp.json`, `node_modules/**`, etc., written by setup)
with the AI-configs from `baseline.ai_configs_detected` and any ticket-specific paths the user
added at Gate 0. The PreToolUse hook and the packet validator both read the merged list — the
UX shrinks (Gate 0 doesn't re-ask about constants each ticket), the enforcement is unchanged.
See `plugin/agy/hooks/write-contract-check.mjs` for the hook.

**Default the AI-coexistence answer to OFF-LIMITS.** A user who hits `approved` without reading
must not accidentally authorize the harness to rewrite their `.cursor/rules` or their custom
`routing-policy.yaml`. If the user wants a competing AI config in scope, they must move it
explicitly.

### Gate 1
> ⏸ **HITL Gate 1 — Requirements Approval**
> I've written `<output_dir>/requirements.md`. Please review and reply with one of:
> - `approved` — proceed to architecture
> - `revise: <comments>` — I'll revise the requirements file based on your comments
> - `abort` — stop the run

### Gate 2
> ⏸ **HITL Gate 2 — Architecture Approval**
> I've written `<output_dir>/design.md`. Same options as Gate 1.

### Gate 3
> ⏸ **HITL Gate 3 — Security Review**
> Security review at `<output_dir>/security_review.md`. Reply `approved`, `revise: <comments>`, or `abort`.

### Gate 4
> ⏸ **HITL Gate 4 — Final Acceptance**
> The full SDLC pass is complete.
> Cost so far: Gemini workers cash $X.XX · Claude worker <cash or modeled> $Y.YY · driver <modeled $Z.ZZ or NOT MEASURED> — separate lines, never added together
> Files: N  ·  Tests: passing/total
> Reply `accept` to finalize the manifest, or `reject: <comments>` to revise.

---

## Telemetry contract (every LLM call)

Every dispatched call writes its own event to `<output_dir>/telemetry.jsonl` — the bridge does
this when you pass `--telemetry`, so you never hand-write a telemetry event.

**Always pass `<output_dir>/telemetry.jsonl`, and nowhere else.** The path is not just where
events land: the agent-worker path anchors its delegation evidence to the same directory,
resolving it as `<dirname of telemetry_path>/delegation` (`AntigravityWorkerAdapter`). Pointing
telemetry somewhere else silently separates each delegation's brief, sidecar and receipt from the
run they document, and the run report then cannot find them. This bites only when the mechanical
tier routes to the agent worker (`--enable-agent`, or a policy selecting `flash-agsdk-worker`),
which is exactly when the evidence matters most.

Event shape:

```json
{
  "ts": "ISO-8601",
  "pass": "pass1|pass2",
  "phase": "<state>",
  "task_type": "<from packet>",
  "task_id": "<from packet>",
  "module": "<from packet>",
  "model": "<canonical model_name>",
  "provenance": "vendor",
  "routed_by": "orchestrator|fallback|manual",
  "routing": { "policy_name": "...", "policy_version": 1, "rule_index": 3, "rule_reason": "..." },
  "input_tokens": 1840,
  "input_tokens_cached": 1420,
  "output_tokens": 612,
  "cost_usd": 0.00234,
  "latency_ms": 1850,
  "success": true,
  "retry_count": 0,
  "artifact_path": "src/leave/leave.controller.ts"
}
```

**Your own loop cost is not yours to record.** Headless, the launcher reads the `agy --print
--output-format stream-json` event stream after the run and derives the conductor's token usage
from its `usage` counters, writing those events to `driver-cost-modeled.jsonl` with
`provenance: "modeled"` — modeled from token counts at the policy's driver card, because a
Google-seat driver has no per-token invoice (p1-agy-runtime.md check 9). Interactive, there is no
such stream and nothing records your loop: the manifest carries the driver line as `NOT MEASURED`
(`kind: "unmeasured"`), unmeasured and never free. Never invent token counts or cost for your own
work: a guessed figure sitting beside measured ones is worse than no figure.

**But anything that made no model call must still leave a row.** Four cases produce one:

- the intent's phase table says SKIP (`skipped`);
- brownfield discovery, which is always yours — log it once, after the read, as
  `--log-phase=discovery --task-type=in_session` (`brownfield-guide/SKILL.md` step 3);
- you completed a phase yourself, in-session, without dispatching a packet — a senior review
  with no changed modules, a security review over an empty diff (`in_session`);
- you changed a file yourself after a worker wrote it, or wrote a file no packet asked for —
  log an `in_session` row for the phase the file belongs to (`codegen`, `tests`, `docs`) with a
  `--reason` that names the file. Do this only when no packet can do the job; see below.

Record each with a zero-cost event (interactive: `log_telemetry` with `task_type: "skipped"` or
`"in_session"` and a `reason`), so that a phase missing from `telemetry.jsonl` always means a lost
event and never an ambiguous one:

```bash
node "${MMO_PLUGIN_ROOT}/agy/dispatch.mjs" \
  --log-phase=<state> --task-type=skipped|in_session \
  --module=<module> --reason='<why in one line>' --run-id=<run_id> \
  --policy=<policy> --telemetry="<output_dir>/telemetry.jsonl" \
  --out="<output_dir>/<state>-skip-receipt.json"
```

These carry `provenance: "none"` and all-zero tokens. That is not an estimate — it is the fact
that no model call was made. Where such work did consume tokens, they were yours. A headless run
counts them on the modeled driver line; an interactive run counts them there too once
`collect-driver-usage.mjs` has read agy's local record, and otherwise has them in no figure. Either way the
row and its `--reason` string are the only record that the work happened and that you did it.

**What is never in-session.** Packet planning (Phase 4) and the senior review's refinement
packets (Phase 6) are always dispatched. Apply a refinement by turning it into a full TaskPacket
(`id`, `phase`, `artifact_path`, `intent`, …) and dispatching it through Phase 5 mechanics —
never by editing the file yourself. The same holds for any other fix to a file a worker wrote:
dispatch a refined packet for it. Write each worker's returned content to its `artifact_path`
exactly as returned. An `in_session` row explains a change you made yourself; it does not make
that change dispatched work.

The code-written manifest checks this. `harness.unrecorded_phases` lists every judgment phase the
run went through with no row at all, and `harness.conductor_edits` lists every planned file whose
final content differs from the last worker result for it, plus files no packet planned.

A run that writes `packets.json`, `review.json` or `security_review.md`, or changes a file a
worker wrote, without either dispatching a packet or logging one of these is under-reporting
itself.

**Pricing constants come from the loaded policy YAML's `pricing:` block for the current model — never from your trained knowledge, never hardcoded.** If the policy's pricing block is missing, abort the run.
