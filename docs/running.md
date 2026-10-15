# Running the harness

> **For:** driving the harness — the interactive skills, every flag on the headless driver, the pin gate, the resume loop and what the run directory holds. **Also see:** [setup.md](setup.md) · [understanding-output.md](understanding-output.md) · [troubleshooting.md](troubleshooting.md).

![The pipeline's phases and gates — eleven greenfield states with gates after requirements, design and security review and before final acceptance; brownfield adds discovery, change_plan and Gate 0](assets/phases-and-gates.svg)

Two shapes. Interactive is how you use the harness: you invoke a skill in an agy chat and answer the gates yourself. Headless is the cost check: `run.mjs` runs the same pipeline unattended and records the conductor's usage from agy's own stream.

## Interactive

Run `node tools/setup.mjs --project-root /path/to/your/project` once (README, "Setup — the two-prompt flow"); it mounts the plugin as `.agents/plugins/mmo/` in the project and prints the command that starts the chat. Start agy in the project on the policy's driver pin, and answer yes to the trust prompt:

```bash
cd /path/to/your/project && agy --model gemini-3.8-flash-high
```

Without `--model` the chat runs on agy's default model, and the run refuses to start on it: [the chat's pin check](#the-chats-pin-check) checks the model it ran on against the pin's model before anything is dispatched. `gemini-3.8-flash-high` is the default policy's slug. For the project's own policy, either command below prints the slug derived from its `driver:` block the way `run.mjs` derives `--model`. Run them in the harness clone; `npm run verify` without `--project-root` checks the clone itself and prints no start command.

```bash
node plugin/agy/start-command.mjs --project-root=/path/to/your/project
npm run verify -- --project-root=/path/to/your/project
```

What an interactive run's pin check can see:

| Part of the slug | Read from | A wrong start it catches |
|---|---|---|
| The model, `gemini-3.8-flash` | agy's local conversation record, field `.1.19` ([check 18](verification/p1-agy-runtime.md)) | A chat started with plain `agy`: the record names agy's default model |
| The effort, `high` | Nothing: `.1.19` reads `gemini-3.8-flash` on a `-high` run, and the collector reads no effort field | None. A chat started at another effort passes, so use the slug exactly as printed |

Whether a chat started with `--model` conducts on that slug is [check 19](verification/p1-agy-runtime.md), pending: a plain `agy` chat on agy 1.3.5 conducted on `gemini-4-argon`, and no interactive run started with `--model` is recorded yet. Until it is, `pin.verified` in the run's manifest is what shows the chat held the pin's model.

`/skills` lists `mmo:greenfield`, `mmo:brownfield`, `mmo:pass` and the rest; the bridge's tools are reached through `call_mcp_tool`. Invoke a skill and answer the gates yourself. Credentials come from the shell that launched `agy` (see [SETUP.md](../SETUP.md)).

### The chat's pin check

A chat runs on the model agy was started with, and plain `agy` starts on agy's own default. So the interactive skills run `plugin/agy/check-driver-pin.mjs` before anything is dispatched: at brownfield step 1, at greenfield step 3, again with the run id at Gate 0 (brownfield) or before Phase -1 (greenfield), and when a brownfield run resumes. It reads the model calls agy's local conversation record holds for the project's conversations active since the run started ([check 18](verification/p1-agy-runtime.md)) and compares their model names with the policy's `driver:` block.

| Exit | Meaning | The skill |
|---|---|---|
| `0` | Every recorded call is the pinned model (`gemini-3.8-flash` or its slug) | Continues |
| `1` | A call ran on another model, even when another conversation's record could not be read, or the pin has no price today | Prints the message and stops before any dispatch. The message names the model seen, the pin, and the restart command, `agy --model gemini-3.8-flash-high` |
| `3` | No conversation or model call recorded yet, or a conversation's record could not be read and no readable call is off the pin. The message names the unreadable conversation | Says the model is not checked, never that it passed, and checks again before the first paid dispatch |
| `2` | Usage or policy error, or `--run-id` names a run started under another policy | Stops |

With `--run-id` it copies the resolved policy to `.sdlc/runs/<run-id>/policy_snapshot.yaml`, which `manifest.mjs` reads the pin from, so an interactive run's `pin.verified` is computed. A run folder elsewhere takes `--output-dir`, resolved against `--project-root`: the pipeline passes the run's output folder as `--output-dir`, so a `/mmo:pass` run with the default study and run id gets `examples/workforce-ops/passes/pass1/policy_snapshot.yaml`. A run that already has a snapshot (a resumed run) is checked against it and keeps it.

Effort is not checked, and an interactive manifest says so (`pin.effort_verified: false`). agy's record names the model without its effort (`gemini-3.8-flash` for the slug `gemini-3.8-flash-high`, [check 14](verification/p1-agy-runtime.md)), and the label line in agy's `cli.log` (`Propagating selected model override to backend: label="…"`) is written when an agy process starts, not per conversation, while `cli.log` itself points at the newest process's log. Start the chat with the slug so the effort is the pinned one.

## Headless

```bash
node plugin/agy/run.mjs \
  --brief=examples/quick-demo/brief.md \
  --project-root=/path/to/empty/dir \
  --policy=antigravity-flash38-plus-opus5 \
  --gates=auto-approve \
  --run-id=quick-demo-1 \
  --dry-run
```

`--dry-run` prints the invocation with the prompt truncated and every credential reported only as set/unset. Drop it to run.

| Flag | Default | Meaning |
|---|---|---|
| `--brief` | `<project-root>/brief.md` | The brief the conductor reads |
| `--project-root` | cwd | The application's repo; added to the agy workspace with `--add-dir` |
| `--output-dir` | `<project-root>/.sdlc/runs/<run-id>` | The run record, one folder per run. Added to the workspace when it is outside the project. A reused folder is safe for cost: the manifest, the report and the cost cap count only this run's lines, and a `SUMMARY.md` older than this run's start does not mark it complete |
| `--code-dir` | `<project-root>/src`; the project root with `--mode=brownfield` | Where the application is written |
| `--policy` | `.sdlc/project.json` → `default_policy`, else `antigravity-flash38-plus-opus5` | Policy name under `plugin/config/policies/`. A `<project-root>/routing-policy.yaml` wins over it, as it does in the bridge ([SETUP.md §5](../SETUP.md#5-choosing-the-policy)) |
| `--run-id` | timestamp | `pass_id` on every telemetry event, and the run's folder name. Letters, digits, `.`, `_`, `-` |
| `--gates` | required | `auto-approve` records `auto-approved` in `gates.jsonl` and continues; `auto-abort` stops at the first gate. `prompt` is refused: print mode has no one to answer, and the resume loop would carry the run past every gate unreviewed. Answer gates yourself in an interactive session instead |
| `--mode`, `--intent`, `--seed` | — | The brownfield handover the guide's step 4 reads. `--seed` without `--intent` on a brownfield run resolves the job type at launch through `plugin/scripts/infer-intent.mjs` and records `intent.source: "inferred"`; a seed that matches no job type, or several, refuses to launch and asks for `--intent` |
| `--resume=<conversation-id>` | — | Continue an earlier session instead of starting one |
| `--max-turns` | 12 | Cap on agy invocations per run |
| `--print-timeout` | `6h` | agy's own print-mode timeout; the default is 5 minutes |
| `--agy-bin` | `agy` | Path to the binary when it is not on PATH |
| `--inline-env` | off | Check-5 fallback: build a per-run root under the OS temp dir with credentials inlined into `mcp_config.json` |
| `--keep-run-root` | off | Keep that root after the run, for inspection |
| `--allow-unverified-pin` | off | Run while a pin check is pending (none is today); stamps `pin.verified: false`, `pin.unverified_reason: "pending_checks"` in the manifest |

### What the invocation pins

| argv | Why | Check |
|---|---|---|
| `--model gemini-3.8-flash-high` | The driver pin, slug derived from the policy's `driver:` block | 14 |
| `--dangerously-skip-permissions` | Print mode soft-denies every tool that would prompt | 6 |
| no `--sandbox` | The bridge is a piped subprocess | 2 |
| `--print-timeout 6h` | A pass runs hours | — |
| cwd = repo root | Where the plugin mount lives; on agy 1.3.5 print mode loads its MCP server and hooks — see below | 1, 10 |
| `--add-dir <project>` | Mandatory; the workspace is otherwise the harness repo | — |

### The pin gate

`docs/verification/p1-agy-runtime.md` says nothing may be pinned on a pending check. `plugin/agy/telemetry/fairnessPin.mjs` lists the checks the headless pin depends on (2, 4, 6, 10); all four passed live on 2026-09-17, so `run.mjs` runs without `--allow-unverified-pin`. If a check is ever set back to pending, the gate closes again.

Passed checks open the gate; they do not prove the run held the pin. `pin.verified` is `true` only when agy itself named the model that conducted, and every name it gave is the pinned model or its slug. It judges the model name, not the effort: a headless run's effort is the one in the slug `run.mjs` passed to agy, while an interactive run's is whatever the chat was started with, so its pin carries `effort_verified: false` and the console's driver line reads `gemini-3.8-flash (high, effort not checked)`:

| `pin.unverified_reason` | Meaning |
|---|---|
| `model_mismatch` | agy named a model that is not the pin (`driver_model_mismatch` lists it). On an interactive run, most often a chat started without `--model` |
| `pending_checks` | A check in `pin.pending_checks` is pending, and the run went ahead under `--allow-unverified-pin` |
| `no_model_observed` | Neither the stream nor agy's local conversation record named a model, so nothing shows which model conducted |

`pin.observed_models` lists the names read: the stream's (`driver_reported_models`) and, on a headless run, the `.1.19` field of agy's local conversation record (`driver_usage.local_record.models`). An interactive run reads them from `driver-collector.json`; without a collection its pin stays `no_model_observed`. It reads the pin itself from `policy_snapshot.yaml`, which [the chat's pin check](#the-chats-pin-check) writes; without one, `harness.pin` is `null`.

### What print mode loads

On agy 1.3.5, `agy -p` run from the harness repo loads the plugin mount: the bridge's MCP server, reached through `call_mcp_tool` as `mmo_model-dispatch`, and the plugin's hooks (check 1). agy 1.2.5 loaded none of it. The conductor prompt `run.mjs` renders still tells the model to dispatch through `plugin/agy/dispatch.mjs`, which speaks MCP to the bridge itself. The write-contract hook fires headless on 1.3.5: `harness.write_guard.state` is `hook` when it judged the run's writes, and the after-run check lists what the run changed outside its contract either way ([brownfield-write-contract.md](brownfield-write-contract.md#headless-runs)).

### The resume loop

One `agy --print` invocation may end before the pipeline does. `run.mjs` reads the `conversation_id` from the stream, and while `SUMMARY.md` is absent and agy exited 0, re-invokes with `--conversation <id>` and a short resume prompt, up to `--max-turns`. A run that recorded its own end (`.sdlc/runs/<run-id>/run-end.json`, written when Phase 7 stops it) is not resumed. A brownfield run completes when `SUMMARY.md` appears and `test-run.json` records a passing run of the test command Gate 0 froze, unless Gate 0 froze `none`. When agy exits because its own model hit a quota (`RESOURCE_EXHAUSTED`, code 429, on stderr), `run.mjs` waits and resumes the same conversation, after 60 s, 3 min and 10 min by default (`--quota-waits=60,180,600`; `--quota-waits=` turns it off). Each retry counts toward `--max-turns`. Every invocation's stream lands in `driver-events.jsonl`, in order, and `driver-manifest.json` → `driver_usage.invocations` records where each one starts and ends. agy's `usage` counters are cumulative within one process (check 8) and carry over into a resumed process on the same conversation (check 16, recorded on agy 1.3.0). The reader therefore differences each result against the one before, across processes, and a run with more than one invocation has one driver figure. `driver_usage.cost_usd_high` keeps the per-invocation reading beside it for comparison.

`--resume=<conversation-id>` into the same `--output-dir` keeps the earlier launch's invocations: `run.mjs` reads them back from the directory before it writes, so the driver line covers the whole conversation, not only the resumed part. The resume must use the policy and driver pin the conversation started under; `run.mjs` refuses otherwise. A resume that finds no earlier record in the directory is flagged `resumed_without_earlier_record`, because check 16 decides whether its first counters include the earlier launch.

## The cost check: the greenfield and brownfield proof runs

The headless run checks what a run costs: `run.mjs` captures the conductor's own usage from agy's stream, every dispatch is priced at the bridge, and `manifest.json` carries the labelled lines. Each command below is copy-paste-runnable from the repo root.

**1. Before anything is spent.** All free.

| Step | Command | Pass when |
|---|---|---|
| Fresh build | `npm ci && npm run build` | No `bridge … older than its source` warning on later commands |
| Setup check | `npm run verify` | No blocking problem; Node 22.19+ |
| Offline suite | `npm test` | Every test passes |
| agy signed in | `agy models` | Lists `gemini-3.8-flash-high` |
| Stub run | the [offline smoke run](#offline-smoke-run) below | Report prints three cost lines |

Export one Claude wallet and the Gemini key in the shell you launch from. Arm A (`ANTHROPIC_API_KEY`) makes the Opus line cash on an Anthropic invoice, which is the line you can reconcile; the claude.ai seat makes it modeled.

```bash
export ANTHROPIC_API_KEY=...   # arm A
export GEMINI_API_KEY=...
```

**2. The greenfield run** — the Ping Service brief, one endpoint, every phase and gate:

```bash
mkdir -p /tmp/ping && cp examples/quick-demo/brief.md /tmp/ping/brief.md
node plugin/agy/run.mjs --project-root=/tmp/ping --run-id=ping-1 --gates=auto-approve --dry-run
node plugin/agy/dispatch.mjs --preflight --auth-mode=vendor --project-root=/tmp/ping --out=/tmp/ping-preflight.json; cat /tmp/ping-preflight.json
```

Read the dry run (policy, `policy_source`, driver price period, pin) and the preflight (`ok: true`, every model priced). Then, on an explicit go for the spend:

```bash
node plugin/agy/run.mjs --project-root=/tmp/ping --run-id=ping-1 --gates=auto-approve
node tools/report.mjs /tmp/ping/.sdlc/runs/ping-1
```

**3. The brownfield run** — the shipped bugfix example, in its own git project:

```bash
cp -R plugin/examples/brownfield-bugfix /tmp/bugfix
git -C /tmp/bugfix init -q && git -C /tmp/bugfix add -A && git -C /tmp/bugfix commit -qm baseline
node tools/setup.mjs --project-root=/tmp/bugfix --yes --no-agent --policy=antigravity-flash38-plus-opus5
node plugin/agy/run.mjs --project-root=/tmp/bugfix --mode=brownfield --intent=bugfix \
  --brief=/tmp/bugfix/intent_brief.md --run-id=bugfix-1 --gates=auto-approve
node tools/report.mjs /tmp/bugfix/.sdlc/runs/bugfix-1
```

Read `harness.write_guard` in `manifest.json`: `state` says whether the write hook judged the run's writes (`hook` on agy 1.3.5), and `after_run_check.outside_contract` lists what the run changed outside its contract. Read it and `git -C /tmp/bugfix diff` before you keep anything.

**4. Check the cost.** In each run's `manifest.json`:

| Field | What to check |
|---|---|
| `cost.lines[]` | Three lines, each with its `kind`. Never add a `modeled` figure to a `cash` one |
| `cost.lines[driver].basis` | Names the dated price period; a range means check 16 is still pending |
| `harness.driver_token_readings` | Every entry `cache-outside-total+thinking-in-output (adds_up)`. `not_recorded_layout` means agy changed how it reports its counters; anything else is booked at the dearest reading |
| `driver-manifest.json` → `driver_usage.local_record.agrees` | `true`: agy's local record and the stream agree on the driver's tokens |
| `harness.driver_model_mismatch` | Absent |
| `harness.bridge_build_stale` | Absent |
| `harness.other_runs_in_directory` | Absent |
| `completed` | `true`; `false` means re-run with the `--resume=` command `run.mjs` printed |

The Anthropic console (arm A) and the Gemini API billing page show the cash lines a day later; the run's `telemetry.jsonl` is the per-call ledger to reconcile against.

## Choosing a policy in the console

```bash
npm run console
```

Opens the policy console at http://127.0.0.1:3000 (`plugin/policy-console/`): a gallery of the shipped presets with the agy driver pin on each card, and an editor that customizes models, per-phase routing and thinking into a new saved policy under `plugin/config/policies/`. The `driver:` block and `hard_cost_cap_usd` are shown and carried into the saved file as-is; the pin is not a per-project choice. `plugin/scripts/setup-policy.mjs` runs the same page during setup and writes the chosen name to `.sdlc/project.json`.

## Offline smoke run

Before any paid run, drive the whole chain against the stub `agy` in `tools/test/fixtures/fake-agy/`. It speaks the recorded stream-json shapes, needs two invocations (so the resume loop runs), and makes one real $0 bridge call through the dispatch fallback:

```bash
mkdir -p /tmp/smoke && cp examples/quick-demo/brief.md /tmp/smoke/brief.md
npm run smoke -- --project-root=/tmp/smoke --run-id=smoke1
node tools/report.mjs /tmp/smoke/.sdlc/runs/smoke1
```

`tools/test/smoke-run.test.mjs` runs the same thing under `npm test`. Nothing the stub emits is a measurement; every figure is made up and labeled modeled.

## The run directory

| File | Written by | What |
|---|---|---|
| `policy_snapshot.yaml` | `run.mjs` at launch; `check-driver-pin.mjs --run-id` at an interactive run's start | The policy as it was when the run started |
| `skills/pipeline.md`, `skills/brownfield-guide.md` | `run.mjs` at launch | The playbook with real paths rendered in |
| `preflight.json` | the conductor, from `preflight_dispatch` | Rule 0's verdict |
| `telemetry.jsonl` | the bridge | Every dispatched call, vendor-metered |
| `gates.jsonl` | the conductor | One line per gate with the decision mode |
| `state.json` | the conductor, before each gate and after its decision | The gate the run is at and its status (`gate_pending`, `running`, `complete`, `aborted`). It is one of the inputs to [when a run counts as unfinished](#when-a-run-counts-as-unfinished) |
| `driver-events.jsonl` | `run.mjs` | The raw stream-json, every invocation |
| `driver-stderr.log` | `run.mjs` | agy's stderr, where soft-denials and hook notices land |
| `driver-cost-modeled.jsonl` | `run.mjs` | One `provenance: "modeled"` event per turn at the driver card |
| `driver-manifest.json` | `run.mjs` | The pin, exit status, invocations, completion, modeled driver cost and its `driver_usage` evidence (range, per-invocation counters, invocations that reported no usage), the mode and the job type with how it was chosen (`flag` or `inferred`) |
| `manifest.json` | `run.mjs` at the end, via `plugin/agy/manifest.mjs` | The code-written run record: the bridge's rollups plus `harness`, `usage` and `cost` with the three labeled lines. Rebuild any time with `node plugin/agy/manifest.mjs <dir>` |
| `test-run.json`, `test-output.txt` | `plugin/scripts/test-run.mjs`, brownfield Phase 7 | The test command's status, exit code and output. A brownfield run completes only on a passing record |
| `SUMMARY.md` | the conductor | The completion signal |

`node tools/report.mjs <dir>` prints the cost report, keeping the modeled driver line apart from the cash lines.

### When a run counts as unfinished

The next `/mmo:brownfield` offers to resume an unfinished run, and `/mmo:policy change` refuses while one exists. `plugin/scripts/lib/run-state.mjs` decides, in this order:

| The run | Unfinished |
|---|---|
| Its write contract still binds: Gate 0 froze it and the run has no `run-end.json` | Yes, whatever its `state.json` says. Until you resume or discard it, its contract judges every write, so a new run cannot write its own run folder |
| Otherwise, it wrote the latest `state.json` of any run folder, its status is not `complete`, `completed`, `aborted` or `failed`, and it has no `run-end.json` | Yes |
| Any other run | No |

A headless brownfield run that stops after Gate 0 gets its `run-end.json` from `run.mjs`, so it is not offered: continue it with the `--resume=` command `run.mjs` printed.
