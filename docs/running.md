# Running the harness

> **For:** driving the harness — the interactive skills, every flag on the headless driver, the pin gate, the resume loop and what the run directory holds. **Also see:** [setup.md](setup.md) · [understanding-output.md](understanding-output.md) · [troubleshooting.md](troubleshooting.md).

![The pipeline's phases and gates — eleven greenfield states with gates after requirements, design and security review and before final acceptance; brownfield adds discovery, change_plan and Gate 0](assets/phases-and-gates.svg)

Two shapes. Interactive is how you build and debug the plugin; headless is how a measured run is recorded.

## Interactive

Run `node tools/setup.mjs --project-root <project>` once (README, "Setup — the two-prompt flow"); it mounts the plugin as `<project>/.agents/plugins/mmo/`. Then open `agy` in the project — or in the repo root, where the committed mount already applies — and answer yes to the trust prompt. `/skills` lists `mmo:greenfield`, `mmo:brownfield`, `mmo:pass` and the rest; the bridge's tools are reached through `call_mcp_tool`. Invoke a skill, answer the gates by hand. Credentials come from the shell that launched `agy` (see [SETUP.md](../SETUP.md)).

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
| `--policy` | `antigravity-flash38-plus-opus5` | Policy name under `plugin/config/policies/` |
| `--run-id` | timestamp | `pass_id` on every telemetry event, and the run's folder name. Letters, digits, `.`, `_`, `-` |
| `--gates` | `prompt` | `prompt` waits for you; `auto-approve` records `auto-approved` and continues; `auto-abort` stops at the first gate |
| `--mode`, `--intent`, `--seed` | — | The brownfield handover the guide's step 4 reads. `--seed` without `--intent` on a brownfield run resolves the job type at launch through `plugin/scripts/infer-intent.mjs` and records `intent.source: "inferred"`; a seed that matches no job type, or several, refuses to launch and asks for `--intent` |
| `--resume=<conversation-id>` | — | Continue an earlier session instead of starting one |
| `--max-turns` | 12 | Cap on agy invocations per run |
| `--print-timeout` | `6h` | agy's own print-mode timeout; the default is 5 minutes |
| `--agy-bin` | `agy` | Path to the binary when it is not on PATH |
| `--inline-env` | off | Check-5 fallback: build a per-run root under the OS temp dir with credentials inlined into `mcp_config.json` |
| `--keep-run-root` | off | Keep that root after the run, for inspection |
| `--allow-unverified-pin` | off | Run while a pin check is pending (none is today); stamps `pin.verified: false` in the manifest |

### What the invocation pins

| argv | Why | Check |
|---|---|---|
| `--model gemini-3.8-flash-high` | The driver pin, slug derived from the policy's `driver:` block | 14 |
| `--dangerously-skip-permissions` | Print mode soft-denies every tool that would prompt | 6 |
| no `--sandbox` | The bridge is a piped subprocess | 2 |
| `--print-timeout 6h` | A pass runs hours | — |
| cwd = repo root | Where the plugin mount lives; print mode loads it anyway only in name — see below | 10 |
| `--add-dir <project>` | Mandatory; the workspace is otherwise the harness repo | — |

### The pin gate

`docs/verification/p1-agy-runtime.md` says nothing may be pinned on a pending check. `plugin/agy/telemetry/fairnessPin.mjs` lists the checks the headless pin depends on (2, 4, 6, 10); all four passed live on 2026-09-17, so `run.mjs` runs without `--allow-unverified-pin` and writes `pin.verified: true`. If a check is ever set back to pending, the gate closes again.

### Headless is plugin-less

`agy -p` loads no workspace customization: no plugin, MCP server, hook or skill (check 1). A headless run therefore has no `/mmo:*` skills and no bridge tools in the model's toolset; the conductor prompt `run.mjs` renders tells the model to dispatch through `plugin/agy/dispatch.mjs`, which speaks MCP to the bridge itself. The write-contract hook does not fire headless — a headless brownfield run has no guard, and its record should say so.

### The resume loop

One `agy --print` invocation may end before the pipeline does. `run.mjs` reads the `conversation_id` from the stream, and while `SUMMARY.md` is absent and agy exited 0, re-invokes with `--conversation <id>` and a short resume prompt, up to `--max-turns`. Every invocation's stream lands in `driver-events.jsonl`, in order, and `driver-manifest.json` → `driver_usage.invocations` records where each one starts and ends. agy's `usage` counters are cumulative within one process (check 8); whether a resumed process continues them or restarts at zero is check 16, still pending. Until it is recorded, a run with more than one invocation carries a driver **range**: `driver-cost-modeled.jsonl` and the headline figure are the upper bound (each process priced as fresh counters), and `driver_usage.cost_usd_low` is the lower bound (each process differenced against the one before).

`--resume=<conversation-id>` into the same `--output-dir` keeps the earlier launch's invocations: `run.mjs` reads them back from the directory before it writes, so the driver line covers the whole conversation, not only the resumed part. The resume must use the policy and driver pin the conversation started under; `run.mjs` refuses otherwise. A resume that finds no earlier record in the directory is flagged `resumed_without_earlier_record`, because check 16 decides whether its first counters include the earlier launch.

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
| `policy_snapshot.yaml` | `run.mjs` at launch | The policy as it was when the run started |
| `skills/pipeline.md`, `skills/brownfield-guide.md` | `run.mjs` at launch | The playbook with real paths rendered in |
| `preflight.json` | the conductor, from `preflight_dispatch` | Rule 0's verdict |
| `telemetry.jsonl` | the bridge | Every dispatched call, vendor-metered |
| `gates.jsonl` | the conductor | One line per gate with the decision mode |
| `driver-events.jsonl` | `run.mjs` | The raw stream-json, every invocation |
| `driver-stderr.log` | `run.mjs` | agy's stderr, where soft-denials and hook notices land |
| `driver-cost-modeled.jsonl` | `run.mjs` | One `provenance: "modeled"` event per turn at the driver card |
| `driver-manifest.json` | `run.mjs` | The pin, exit status, invocations, completion, modeled driver cost and its `driver_usage` evidence (range, per-invocation counters, invocations that reported no usage), the mode and the job type with how it was chosen (`flag` or `inferred`) |
| `manifest.json` | `run.mjs` at the end, via `plugin/agy/manifest.mjs` | The code-written run record: the bridge's rollups plus `harness`, `usage` and `cost` with the three labeled lines. Rebuild any time with `node plugin/agy/manifest.mjs <dir>` |
| `SUMMARY.md` | the conductor | The completion signal |

`node tools/report.mjs <dir>` prints the cost report, keeping the modeled driver line apart from the cash lines.
