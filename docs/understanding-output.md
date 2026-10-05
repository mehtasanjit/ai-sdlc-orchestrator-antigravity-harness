# Understanding the output

> **For:** reading `telemetry.jsonl`, `driver-cost-modeled.jsonl`, `manifest.json`, `provenance.json`, and the cost report. **Also see:** [methodology.md](methodology.md) · [running.md](running.md#the-run-directory).

After a run finishes, the record lives under the run's output directory — `.sdlc/` for greenfield (`/mmo:greenfield`, or `run.mjs` with its default `--output-dir`), `.sdlc/runs/<YYYYMMDD-HHMMSS>-<intent>-<slug>/` for brownfield (`/mmo:brownfield`, the seven job aliases, `/mmo:pass --mode=brownfield`). Two files carry the money, and they are kept apart on purpose:

- `telemetry.jsonl` — one JSON object per line, one line per **dispatched** model call: everything that went through the bridge. Vendor-metered. Real usage, and on a key or a GCP project, real money.
- `driver-cost-modeled.jsonl` — one line per conductor turn, priced from agy's stream-json `usage` at the policy's driver card. **Modeled.** A Google seat has no per-token invoice, so this figure is what the tokens *would* cost at the published rate, not what anyone was billed. Headless runs only — an interactive session exposes no `usage` counters to the plugin, so an interactive run's manifest carries the driver line as `kind: "unmeasured"`: $0 with a `NOT MEASURED` basis and `cost.driver_measured: false`, never a modeled $0.

Around them:

- `manifest.json` — the code-written rollup ([plugin/agy/manifest.mjs](../plugin/agy/manifest.mjs)): totals, per-phase, per-module and per-task-type breakdowns of the dispatched work, plus `harness`, `usage` and `cost` blocks that carry the three labeled cost lines. The conductor never writes it.
- `driver-manifest.json`, `driver-events.jsonl`, `driver-stderr.log` — the launcher's own record of a headless run: the pin it asserted, agy's exit status, every raw stream-json event, agy's stderr (where soft-denials and hook notices land).
- `policy_snapshot.yaml`, `preflight.json`, `gates.jsonl` — the policy as it was at launch; Rule 0's pricing verdict; one line per gate with the decision and its mode.
- `skills/pipeline.md`, `skills/brownfield-guide.md` — the playbook the conductor was given, with real paths rendered in. What the model read, exactly.
- `SUMMARY.md` — the conductor's completion signal and its own summary. Every figure in it is quoted from `telemetry.jsonl`; it is not the record.
- Generated source under `src/` (greenfield) or the files named at Gate 0 (brownfield).

Brownfield runs add, under `.sdlc/runs/<run-id>/`:

- `provenance.json` — every file this run created or modified, keyed by path, with the pre-run hash. `/mmo:revert` reads this to undo the run.
- `intent_brief.md`, `discovery.md`, `change_plan.md`, `senior-review.md`, `security-review.md`, `final_report.md` — the per-phase artifacts.
- `packets.jsonl` — the TaskPacket stream the conductor dispatched, one per line.

A `delegation/` directory appears only on runs that chose the Antigravity SDK agent path — three files per delegated packet (brief, worker usage sidecar, receipt). See [the delegation directory](#the-delegation-directory).

The report emitted by `node tools/report.mjs <run-dir>` is a rendered view of these files. `--markdown` renders it as tables for pasting into an issue.

## The report, section by section

### Header

Identifies the run: id, policy, the driver pin (`gemini-3.8-flash`, effort `high`), start timestamp and duration. A run invoked with `--run-id=foo` shows `foo` here.

### Dispatched work — vendor-metered

One row per SDLC phase. Columns:

- **Prov** — the provenance of the row's figures. `V` vendor-metered, `E` estimated (never on this runtime), `M` modeled, `–` no model call (a phase the conductor completed in-session or skipped, logged for completeness at zero cost), `~` mixed within the phase, `?` unlabelled.
- **Calls** — how many bridge dispatches occurred in that phase.
- **Tokens (in / out)** — summed input and output tokens across those calls.
- **Cost** — sum of the per-call `cost_usd` values.

The row order follows the state machine — requirements first, then design, planning, codegen, tests, docs, senior review, security review. **SDLC total** is the sum of the productive phases; **Runner overhead** (when present) is dispatched work that is not SDLC-productive — preflight, retries, shell-adjacent packets; **Vendor-metered total** is both. Every dollar in this section came through the bridge and carries a vendor-reported token count.

On the Claude seat (Claude Code signed in to claude.ai, no key exported) the Opus rows are still vendor-metered *tokens*, but the dollars are modeled — no invoice exists. The manifest's `cost` block moves that line out of `dispatched_cash_usd` (see [`manifest.json`](#manifestjson)); the report's table does not, so read the manifest's `harness.arm` before quoting the total as spend.

### Driver loop — modeled, not measured

Its own section, deliberately. Turns, tokens and the modeled cost of the conductor's own loop — reasoning, file reads, the growing conversation — derived from agy's `usage` counters at the driver card. The text under the table repeats the point every time: this is not an amount anyone was billed, and it is kept out of the vendor total. Two figures that are different kinds of dollars are never summed. Full method in [methodology.md](methodology.md#three-cost-lines).

On an interactive run the plugin sees no `usage` counters, so the section reads _No driver turns recorded._ instead of printing zeroes.

### Packets that hit the output cap

Printed only when a packet was retried after hitting its `max_output_tokens` ceiling. One row per such packet: attempts, the ceiling on the final attempt, and the cost across every attempt. Absent otherwise.

### Delegated to an agent worker

Printed only when the run delegated packets to the Antigravity SDK worker. One row per delegated packet: tool calls the worker made (a trailing `+` means the worker's own recording cap was hit and the figure is a floor), files `+` added / `~` modified / `-` removed, wall-clock, cost from telemetry (so it covers every attempt). `*` marks a retried packet, `!` a worker that did not finish, `?` a receipt with no matching telemetry event.

**What "Files" does and does not claim.** The bridge digests every file in the working directory immediately before the worker starts and again after it exits, and compares them. Modification means the *content* changed. `.git`, `node_modules`, `dist`, `.venv` and similar are not walked, and the worker's own output directory is excluded so a delegation cannot report its own evidence as a change. That gives you what changed *while the worker held the directory* — not proof it was the only writer, and not attribution to any one tool call. For that, read the receipt's tool-call list.

### Provenance key and footer

The legend for the **Prov** column, and the count of dispatched events by provenance.

## The raw files

### `telemetry.jsonl`

One JSON object per line. Key fields on a dispatched line:

```json
{
  "ts": "2026-09-18T12:07:50.917Z",
  "pass": "quick-demo-1",
  "phase": "codegen",
  "task_type": "controller_handler",
  "task_id": "tp_codegen_012",
  "module": "ping",
  "model": "gemini-3.8-flash",
  "model_id": "flash-completion",
  "adapter": "mcp:model-dispatch",
  "tier": "mechanical",
  "provenance": "vendor",
  "routed_by": "policy",
  "routing": { "policy_name": "antigravity-flash38-plus-opus5", "policy_version": 1, "rule_index": 7, "rule_reason": "Schema-driven boilerplate" },
  "input_tokens": 3421,
  "input_tokens_cached": 0,
  "output_tokens": 2103,
  "cost_usd": 0.0104,
  "price_basis": "list",
  "latency_ms": 8241,
  "success": true,
  "retry_count": 0
}
```

Fields the report reads: `phase`, `provenance`, `input_tokens`, `input_tokens_cached`, `input_tokens_cache_write`, `output_tokens`, `cost_usd`, `success`, `retry_count`. Everything else is there for downstream analysis.

- `model` is the vendor's model name; `model_id` is the policy leaf that dispatched. They differ when a policy offers two doors to the same model — `flash-completion` and `flash-agsdk-worker` both carry `"model": "gemini-3.8-flash"`. Group by `model_id` when the door matters; `routing.select` records the choice that led there.
- `adapter` is the policy adapter that ran the call. The manifest books each event to a cost line from it. Events written before the field existed lack it, and the manifest falls back to the policy snapshot, then to the `claude-` or `gemini-` prefix of `model`.
- `ceiling_used` is the output cap the vendor was given for that attempt. An adapter that gives none (`claude-agent-sdk`, `claude-cli`, `antigravity-worker`) writes `ceiling_used: null`, `budget_enforced: false`, and the packet's `budget.maxOutputTokens` as `budget_declared`; on those lines `output_tokens` can exceed `budget_declared`. See [methodology.md](methodology.md#output-ceiling-doubling).
- `wallet` is the wallet the call billed, recorded by the bridge at dispatch. The manifest books each event's wallet from it, so rebuilding the manifest from another shell does not change it. Events written before the field existed lack it; see [`manifest.json`](#manifestjson) for the fallback.

  | Key | Meaning |
  |---|---|
  | `name` | `anthropic`, `gcp`, `claude-seat` or `gemini-api-key`; `null` when nothing the adapter saw settled it |
  | `source` | `reported` (Claude Code said so: the Agent SDK init frame or the result's `modelUsage`), `env` (the bridge's environment at dispatch), `transport` (the Gemini door the adapter built) |
  | `arm` | Claude only: `A`, `B`, `seat` or `unknown` |
  | `api_key_source`, `claude_code_version` | `claude-agent-sdk` only: the init frame's `apiKeySource` (`ANTHROPIC_API_KEY`, `none`, ...) and Claude Code version |
  | `api_provider` | Claude only: the provider the result reports (`firstParty`, `vertex`, ...) |
  | `project`, `region` | Arm B only: `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` in the bridge's environment |
  | `backend`, `location` | Gemini only: `api-key` or `vertex-adc`, and the Vertex location (empty on the key) |

- `price_basis` is `list` (the dated price list in [plugin/mcp/model-dispatch/src/prices.ts](../plugin/mcp/model-dispatch/src/prices.ts)) or `custom` (the policy's `pricing:` block under `pricing_override: true`).
- A Gemini completion line (`model_id: flash-completion`) adds `thinking_level`, the `thinkingConfig.thinkingLevel` the request carried (`LOW` under the shipped policy, `null` when it carried none), and `output_tokens_reasoning`, the attempt's `thoughtsTokenCount`. The reasoning count is already inside `output_tokens` and billed at the output rate; on an attempt that hit the output cap it shows how much of the ceiling went to thinking.
- An Opus line (the `claude-cli` adapter) adds `cli_reported_cost_usd` — Claude Code's own figure for the call, kept as a cross-check and never booked — and `ttl_split` (`transcript`, `approximate` or `no_cache_writes`) saying how the 5-minute / 1-hour cache-write buckets were told apart. `input_tokens_cache_write_1h` holds the 1-hour share when it is known; it bills at 2× input instead of 1.25×.
- `provenance: "none"` with `task_type: "in_session"` or `"skipped"` is a phase the conductor logged without dispatching (`dispatch.mjs --log-phase`). Zero tokens, zero cost; its work, if any, accrues to the driver loop.
- `latency_ms` is a real wall-clock figure on dispatched calls and `null` on logged-only lines.

Sum a phase with standard shell tools:

```bash
jq -r 'select(.phase=="codegen") | .cost_usd' .sdlc/telemetry.jsonl | awk '{s+=$1} END {print s}'
```

### `driver-cost-modeled.jsonl`

Same line shape as telemetry, so the two files can be concatenated for analysis without the report or the manifest confusing them: every line carries `tier: "orchestrator"`, `provenance: "modeled"`, `phase: "driver_loop"`, `task_type: "conductor"` and `task_id: "driver-turn-<n>"`, and `buildManifest` partitions those out of every dispatched sum.

```json
{
  "task_id": "driver-turn-2",
  "model": "gemini-3.8-flash",
  "tier": "orchestrator",
  "provenance": "modeled",
  "billing_mode": "seat",
  "input_tokens": 700,
  "input_tokens_cached": 800,
  "output_tokens": 330,
  "output_tokens_reasoning": 30,
  "cost_usd": 0.001823
}
```

`output_tokens_reasoning` is agy's `thinking_tokens`, billed at the output rate; `input_tokens_cached` is its `cache_read_tokens`, at the cached rate. agy's `usage` is cumulative within one process. Each line carries `invocation` (which `agy --print` process reported it) and `usage_reading` (how a resumed process was priced). While [check 16](verification/p1-agy-runtime.md) is pending the reading is `per-invocation`: a resumed process's counters are priced as fresh, the upper bound. No event carries a timestamp; `ts` is the reader's arrival clock.

`driver-manifest.json` → `driver_usage` holds the evidence behind the line:

| Field | Meaning |
|---|---|
| `resume_check` | `{check: 16, state}`; `pending` until the live result is recorded |
| `reading` | The reading `driver-cost-modeled.jsonl` uses |
| `cost_usd`, `cost_usd_low`, `cost_usd_high` | The driver figure, and the same results priced under each reading. Equal for a run with one invocation |
| `invocations[]` | Per `agy --print` process: exit status, wall clock, `result` count, `num_turns`, `duration_seconds`, the raw cumulative `usage`, and the line count that splits `driver-events.jsonl` |
| `invocations_without_usage` | Processes that ended without a `result` event. Their driver tokens are in no figure |

### `manifest.json`

The dispatched rollup, then three blocks this harness adds.

**Dispatched rollup** — `total_cost_usd`, `total_input_tokens`, `total_input_tokens_cached`, `total_input_tokens_cache_write`, `total_output_tokens`, `model_breakdown`, `phase_breakdown` (with `by_model` inside each phase), `module_breakdown`, `task_type_breakdown`, `duration_sec`, `pass`, `policy_name`. Dispatched work only, always.

**`harness`**

| Field | Meaning |
|---|---|
| `name`, `kind`, `runtime` | `antigravity`, `sdlc`, and `{ name: "antigravity-cli", version }` as reported by the binary |
| `auth_mode` | `vendor` — the only mode this runtime accepts |
| `provider_source` | Where each leg's dollars come from: `driver` (`google-seat` or `gemini-api-key`), `claude` (`anthropic-api`, `vertex`, `claude-seat` or `mixed`), `gemini` (the Gemini line's `wallet`) |
| `arm` | The Claude line's arm: `A` (Anthropic key), `B` (Vertex), `seat` (Claude Code signed in to claude.ai), `mixed`, or `null` when no Claude call ran or no wallet could be named |
| `pin` | `model`, `effort`, `slug`, `billing_mode`, `verified`, `pending_checks` — the driver pin `run.mjs` asserted, and whether every check it depends on has passed live |
| `delegated` | Whether any packet went to the agent worker |
| `cable` | One-paragraph description of the wiring: driver runtime and models, driver auth, worker models, `claude_worker_auth` (names the arm, the GCP project and region on arm B, or the seat), `summary` (each worker model and the adapter its events recorded, or `adapter not recorded`) |
| `driver_cost_usd`, `driver_cost_basis`, `driver_turns`, `agy_invocations` | The modeled driver figure and the sentence that says how it was derived; how many turns and how many `agy --print` invocations (the resume loop) |
| `driver_cost_usd_low`, `driver_cost_resume_check` | Present while check 16 is pending on a resumed run: the lower bound of the driver range; `driver_cost_usd` is the upper |
| `driver_invocations_without_usage` | `agy --print` processes that reported no `usage`; the driver figure is missing their tokens |
| `completed`, `gates`, `pin_rejection` | Whether `SUMMARY.md` appeared; the gate mode; the stderr line if agy refused the pinned model |
| `written_by`, `written_at` | `plugin/agy/manifest.mjs` and when |

**`usage`** — `dispatched` and `driver` token buckets side by side, the driver's stamped `provenance: "modeled"`.

**`cost`**

| Field | Meaning |
|---|---|
| `dispatched_cash_usd` | Bridge dispatches that a vendor invoiced. On arm A or B this equals `total_cost_usd`. Opus calls on the seat are subtracted out, because they were not invoiced either |
| `driver_modeled_usd` | The conductor's loop at the driver card |
| `claude_seat_modeled_usd` | Present only when Opus calls ran on the seat: those calls, priced at the Anthropic card, no invoice |
| `lines[]` | Three entries — `driver`, `gemini_workers`, `claude_worker` — each with `kind` (`cash`, `modeled`, or `mixed` on a Claude line partly on the seat), the wallet, models, tokens, `cost_usd`, and on the modeled and mixed ones a `basis` sentence. A fourth, `unclassified`, appears only when an event names no known worker adapter and no `claude-` or `gemini-` model; its dollars stay off both worker lines |
| `note` | The rule, restated in the file itself: the cash figure and the modeled figures are different kinds of dollars and are not summed |

The two worker lines take their wallet from each event's `wallet` stamp:

| Field | Meaning |
|---|---|
| `wallet`, `arm` | The one wallet the line's events used, or `mixed` |
| `wallet_source` | `events` (every event carried the stamp), `env at manifest time` (none did, so the wallet was read from the environment of the shell running `manifest.mjs`, and a claude.ai login probe for the seat), `events + env at manifest time`, or `no dispatches` |
| `wallets[]` | Present when the line used more than one wallet: each wallet with its `calls`, `cost_usd` and `wallet_source` |
| `mixed_wallets[]` | Present when one worker (policy leaf) shows more than one wallet in a single run. Check the run before quoting its cost |
| `wallet_note` | Present when the fallback environment cannot name a wallet: `CLAUDE_CODE_USE_VERTEX` and `ANTHROPIC_API_KEY` both set |

A Claude line whose calls ran partly on the seat has `kind: "mixed"` and a `seat_modeled_usd`; only that share leaves `dispatched_cash_usd`.

Rebuild the manifest any time with `node plugin/agy/manifest.mjs <run-dir> --policy=<name> --run-id=<id> --agy-version=<v>`. The rebuild is not idempotent: `written_at` changes, `harness.runtime.version` comes from `agy --version` at rebuild time unless you pass `--agy-version`, and on events without the `wallet` stamp the wallets follow the environment you run it from.

### `provenance.json`

Brownfield only. Written by [plugin/scripts/write-provenance.mjs](../plugin/scripts/write-provenance.mjs) before and after every write. One entry per file under `files_touched`:

```json
{
  "path": "src/auth/auth.service.ts",
  "existed_before": true,
  "sha_before": "3f1c…",
  "sha_after": "9a07…",
  "tracked_in_git": true,
  "backup_path": ".sdlc/runs/<run-id>/backups/src__auth__auth.service.ts",
  "packet_id": "tp_codegen_003",
  "written_at": "2026-09-18T12:10:41.002Z"
}
```

`backup_path` is set only for files that were uncommitted before the run — a tracked, committed file is restored from git instead.

`/mmo:revert <run-id>` restores each entry to its pre-run state — `git checkout` for tracked-committed files, the per-run backup for uncommitted ones — and refuses with a three-way diff when the file has changed since. See [brownfield-write-contract.md](brownfield-write-contract.md).

### The delegation directory

Present only on runs that delegated. Three files per delegated packet, named after the packet's task id:

- **`worker-task-<packet>.md`** — the brief the worker was given, exactly as written to disk.
- **`worker-usage-<packet>.json`** — written by the worker process itself: the model it reached, the SDK version, the Google Cloud project and region, its token usage, its tool calls.
- **`worker-delegation-<packet>.json`** — the receipt, written by the bridge (`schema: "delegation-record/1"`): `task_id`/`phase`/`task_type`/`module` (the join key back to `telemetry.jsonl`), `cable` copied from the sidecar, `duration_ms`/`success`/`error`, `cost_usd`/`tokens`, `tool_calls` (`count`, `truncated`, `sample`), `files` (`added`, `modified`, `removed`, plus `unchanged`, `scanned`, `truncated`, `unreadable`), `artifacts`.

A receipt is written for failed delegations too. A retried packet overwrites all three files, so what survives describes the final attempt; the report marks those rows with `*`.

### The driver's raw stream

`driver-events.jsonl` is every stream-json line agy emitted, across every invocation of the run, unaltered. `init` carries the conversation id the resume loop reuses; `step_update` lines are the model's tool steps; `result` carries the cumulative `usage`. When a figure in `driver-cost-modeled.jsonl` looks wrong, this is the file to check it against. `driver-stderr.log` is where agy prints a soft-denial (a tool that would have prompted, refused in print mode) and hook notices.

## Other files that may appear

- **`.hook-logs/hook.jsonl`** — one line per bridge call, written by the `PostToolUse` heartbeat hook in an interactive session. Timestamp and payload size only; independent of `telemetry.jsonl`, useful for confirming the hook fired for each expected call. Safe to delete.
- **`.sdlc/project.json`** — `default_policy` and the off-limits defaults for this project, written by the policy console. Not a run record.
- **`.sdlc/local/`** — `mmo-select.json` (the Gemini door choice), `write-contract.json` (the brownfield contract confirmed at Gate 0), `guard-decisions.jsonl` (every write the hook refused, with the rule). Local state, not for git.
- **`.agents/run-*/`** — a per-run customization root that `run.mjs --inline-env` materialises with credentials inlined. Gitignored; deleted after the run unless `--keep-run-root`.
