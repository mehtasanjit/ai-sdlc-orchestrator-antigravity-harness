# Methodology

> **For:** understanding how tokens and costs are counted — which figures are vendor-metered, which are modeled, and why the two are never added. **Also see:** [understanding-output.md](understanding-output.md) · [architecture.md](architecture.md#three-cost-lines) · [logging.md](logging.md).

![Three cost lines — the driver (Gemini 3.8 Flash on agy, modeled from stream-json usage), the Gemini workers (mechanical phases, cash on a key or Vertex) and the Claude worker (Opus 5 through the Claude Agent SDK, cash on arm A or B, modeled on the seat) — with the manifest's note that the two kinds of dollars are not summed](assets/cost-lines.svg)

How the tokens and costs on the report are derived, in plain terms.

## Three cost lines

A run on this harness produces three cost lines, and the report, the manifest and every doc keep them apart:

| Line | Who | Source | Kind |
|---|---|---|---|
| Driver | Gemini 3.8 Flash conducting on agy | stream-json `usage` × the policy's `driver.pricing` card | **modeled** |
| Gemini workers | Gemini 3.8 Flash on the mechanical phases | bridge `telemetry.jsonl` — the vendor's `usageMetadata` | cash (API key or Vertex) |
| Claude worker | Claude Opus 5 on the judgment phases | bridge `telemetry.jsonl` — the Claude Agent SDK result's `usage` and `modelUsage` | cash on arm A (Anthropic) or arm B (GCP); **modeled** on the seat |

**Modeled** means: the tokens are real counts the runtime reported, and the dollars are what those tokens would cost at the published card. No invoice exists. A conductor on a Google seat, or Claude Code signed in to a claude.ai subscription, draws on a quota that has no per-token bill; the figure describes usage, not spend.

**Cash** means: a vendor metered the tokens and will invoice them — the Anthropic key's dashboard, the GCP project's billing page, or the AI Studio key's.

The rule that follows is stated in the manifest itself (`cost.note`) and enforced by every aggregator: `dispatched_cash_usd` and the modeled figures are different kinds of dollars and are not summed. A single "total" that mixed them would be neither the API bill nor the seat usage. Compare architectures on the cash line and the modeled line side by side, each labeled, or not at all.

### Why the driver line is modeled

agy prints `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}` in its stream-json `result` envelope ([check 8](verification/p1-agy-runtime.md)) and no wallet figure ([check 9](verification/p1-agy-runtime.md)). `plugin/agy/telemetry/event-reader.mjs` prices those counters through the dated price list — thinking at the output rate, cache reads at the cached rate — and writes one line per turn to `driver-cost-modeled.jsonl` with `provenance: "modeled"` and `tier: "orchestrator"`. `usage` is cumulative within one agy process. `run.mjs` resumes a run in a new process, and whether that process continues the counters or restarts them is [check 16](verification/p1-agy-runtime.md), still pending: a resumed run reports the driver line as a range, with the upper bound as the headline figure. An invocation that reports no usage (no `result` event, or only the all-zero error result check 8 recorded) is named in `harness.driver_invocations_without_usage`; the per-invocation figure is missing its tokens, so the true driver figure may be higher.

An interactive session gives the plugin no stream. Its driver line comes from agy's local conversation record instead ([check 18](verification/p1-agy-runtime.md)): one SQLite database per conversation, one protobuf per model call with that call's fresh input, cache reads, output and thinking. `plugin/agy/collect-driver-usage.mjs` reads the calls of this project's conversations inside the run's window (`--since`/`--until` when given, else the run's `run.start`/`run.end` lines in `orchestrator.log`, else from the run folder's creation to now; `driver-collector.json` → `window` names which), prices each on its day, and writes the same modeled lines plus `driver-collector.json`. The record's format is agy's and undocumented; the collector reads it by field number, checks every row against `output = thinking + text`, and refuses a record that breaks it. More than one conversation of the project active in the window are all counted, and the evidence says so. The skills run the collector twice: before `SUMMARY.md`, so the summary has a driver figure, and again after `run.end`, so the final `manifest.json` holds the conductor's calls for the final report and Gate 4 too. When a run has a `run.end` line later than the collection's window, the manifest records `harness.driver_collection_incomplete` and `manifest.mjs` and the report say the driver line stops short. A headless run reads the same record after it ends and records it beside the stream reading as `driver_usage.local_record`: two readers of one conversation, which also settle checks 16 and 17 from any real run.

A metered driver is possible — `billing_mode: gemini-api-key` in the policy's `driver:` block, with `modelProvider: "gemini"` in agy's own settings — but it needs an edit under `~/.gemini/`, which the standing rules exclude. If a study needs it, the manifest records the decision in `harness.provider_source.driver`.

### Why the Claude line is cash on the arms and modeled on the seat

Every Opus call crosses the bridge through the `claude-agent-sdk` adapter (or `claude-cli`, which spawns `claude -p`), which runs Claude Code with the bridge's environment and reads the result's `usage` and `modelUsage`. The tokens are the same whichever wallet paid. The dollars differ:

- **Arm A** — `ANTHROPIC_API_KEY` exported. Anthropic meters and invoices. Cash.
- **Arm B** — `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION=global`. Google Cloud meters and invoices at the Vertex Claude card. Cash — but check the card in `prices.ts` before the first arm-B run; the SDK's own `total_cost_usd` is a check there, not the figure of record.
- **The seat** — nothing exported; Claude Code is signed in to claude.ai (`claude auth status` shows `authMethod: claude.ai`). No invoice. `manifest.mjs` moves the line out of `dispatched_cash_usd` into `claude_seat_modeled_usd` and labels it `kind: "modeled"`.

The manifest's `harness.arm` says which applied. A key and the Vertex variables set at once is refused by `verify` and by the wizard, because the run record could not then say which wallet paid.

The bridge records the wallet on every dispatched event, in its `wallet` field. For the Claude worker the arm comes from what Claude Code reports — the Agent SDK init frame's `apiKeySource` and the result's `modelUsage` provider — with the bridge's environment at dispatch filling in what those leave open. For Gemini it is the door the adapter built. `manifest.mjs` books each line's wallet from those stamps, so rebuilding the manifest from another shell does not move a dollar between cash and modeled. An event without the stamp falls back to the environment of the shell running `manifest.mjs`, and the line says `wallet_source: "env at manifest time"`.

**The cache lifetime is pinned on the model entry.** Left alone, Claude Code caches for 1 hour on the seat and 5 minutes on an API key or Vertex, and a 1-hour write bills at 2× input against 1.25×, so the wallet would set the cache-write rate. The shipped `opus` entry carries `prompt_cache_ttl: 1h`, which the `claude-agent-sdk` adapter sends as the SDK's `settings.promptCacheTtl`; 1 hour because packets that read one another's cached prefix run 13-17 minutes apart. `CLAUDE_CODE_PROMPT_CACHE_TTL` in the bridge's environment overrides the setting, so the pin is also checked: every Opus event records in `prompt_cache_ttl` the lifetime its cache writes used, read from the stream's `cache_creation` split, and sets `mismatch: true` with a `pricing.cache_ttl_mismatch` warning when that differs from the pin. The dollars always price the writes as the API reported them.

## Vendor mode is the only mode

The Claude Code harness offers `--auth=vendor|estimated`, where estimated mode prices the driver's own in-session judgment work by a character-count heuristic. This harness prices no in-session work. Every judgment phase the policy routes — requirements, design or change plan, packet planning, senior review, security review — is a bridge dispatch with a vendor-reported `usage` block, and so is every refinement packet a review returns. Brownfield discovery is the one judgment step the conductor does itself: a local read of your repo, never dispatched, with no rule in the policy. `--auth=vendor` is therefore the only value `/mmo:pass` and `run.mjs` accept; `estimated` aborts with the rule-6 text. Every dispatched event carries `provenance: "vendor"`, stamped server-side by the bridge, and a driver line carries `provenance: "modeled"`, stamped by the event reader.

Anything the conductor does without dispatching — discovery, a phase it completes in-session — is logged at zero with `provenance: "none"` and `task_type: "in_session"`, and a phase the intent skips with `task_type: "skipped"` (`dispatch.mjs --log-phase`). The tokens in-session work uses are the conductor's own: a headless run counts them on the modeled driver line, and an interactive run, which measures no driver usage, has them in no figure. The row is the record that the phase happened and that the conductor did it.

The manifest checks that record instead of trusting it:

| Field | What it lists | `null` when |
|---|---|---|
| `harness.unrecorded_phases` | Judgment phases the run went through — the phase's artifact is in the run folder, a later phase left a row or an artifact, or the run completed — with neither a dispatched event nor a `provenance: "none"` row. A brownfield run expects `discovery` too | never; `[]` when every phase has a row |
| `harness.conductor_edits` | Per planned `artifact_path`: whether the file's last `sha_after` in `provenance.json` differs from the SHA-256 of the last successful worker result for that path (a final-newline difference is not counted). `unplanned` lists written files no packet targets | the run folder has no `provenance.json`, no packet with an `artifact_path`, or no saved worker result (the MCP route returns results in-session). `null` means unknown, never "no edits" |

## The `MMO:` log stream is not telemetry

`telemetry.jsonl` and the `MMO:`-prefixed log stream ([logging.md](logging.md)) record different things and neither replaces the other. Telemetry is cost accounting: one event per dispatch attempt, written once that attempt completes, carrying exactly the fields the report sums. The log stream is an event trace — routing decisions, vendor request/response, worker spawn and exit, write-contract decisions — one `MMO: <timestamp> <LEVEL> <event> key=value…` line per event, to stderr and to the run's `orchestrator.log`. It carries no dollar figures. A dispatch that fails before a vendor call completes emits `dispatch.error` on the log stream but no telemetry event, because there is nothing to bill.

## Where the numbers come from

- **Token counts pass through unchanged from the source.** A dispatched event's counts are exactly what the vendor's `usage` block returned. A driver line's counts are exactly what agy's `result.usage` reported, differenced per turn. Report totals are those per-event counts summed — nothing between measurement and display.
- **Cost is computed and written at the moment of each call.** A dispatched event's `cost_usd` is (its tokens × the model's effective price on the dispatch day) / 1M, stamped into `telemetry.jsonl` at write time with `price_basis` (`list` or `custom`). A driver line's is (its tokens × the `driver.pricing` card) / 1M, stamped when `run.mjs` reads the stream.
- **The manifest is written by code.** `plugin/agy/manifest.mjs` sums the two files, books each worker line's wallet from the bridge's per-event stamp, and writes the pin and the three lines. `tools/report.mjs` renders the same lines from the same code. The conductor's `SUMMARY.md` copies the lines `manifest.mjs` printed, each with its kind; it never computes a figure, and it is not the record.
- **Telemetry covers dispatched work only.** The conductor's own loop is in `driver-cost-modeled.jsonl`, never in `telemetry.jsonl`; `buildManifest` and the report partition any `tier: "orchestrator"` line out of every dispatched sum if the two files are ever concatenated.

To verify any of these, walk the two JSONL files by hand — every line is inspectable.

## How Gemini's token counts are read

Google's `usageMetadata` has two fields that look alike and behave in opposite ways. Both are handled explicitly, because getting either wrong moves the headline number.

**`cachedContentTokenCount` is a *subset* of `promptTokenCount`.** The prompt count is the whole prompt, cached portion included. Cost is computed on disjoint counts — fresh input at the full rate, cached input at the read rate — so the cached count is subtracted from the prompt count before pricing. That subtraction happens exactly once, in the adapter: the `input_tokens` written to telemetry is already the fresh count, and every reader prices the stored buckets as they are and never subtracts again.

**`thoughtsTokenCount` is a *sibling* of `candidatesTokenCount`.** Gemini 3.x reasons before it answers, and Google bills that reasoning at the output rate — but reports it outside the candidate count. Billed output is therefore `candidatesTokenCount + thoughtsTokenCount`. A single-token answer can come with ~100 thinking tokens; reading the candidate count alone would understate precisely the model whose lower cost the multi-model run exists to show.

**The agent door reads input by SDK version.** The Antigravity SDK worker writes a usage sidecar with snake_case counts, and what its `prompt_token_count` means changed between SDK releases: 0.1.9 counts cached input inside it, 0.1.16 counts it on top. Each listed version was checked against Google's own token counter (Cloud Monitoring `aiplatform.googleapis.com/publisher/online_serving/token_count`), and `AGY_USAGE_SEMANTICS` in `plugin/mcp/model-dispatch/src/delegation/workerProcess.ts` records the reading per version. A version not listed is billed on the larger reading (fresh = `prompt_token_count`, cached on top) and logs `agsdk.usage_semantics_unverified`. `worker/requirements.txt` pins `google-antigravity==0.1.16`; raise it only after the same check adds the new version.

The driver line prices agy's `cache_read_tokens` at the cached rate and its `thinking_tokens` at the output rate. Whether agy's `input_tokens` already holds the cache reads, and whether its `output_tokens` already holds the thinking, is not documented, so the event reader decides it per result: it books the layout whose parts sum to agy's own `total_tokens`. When the counters fit no layout, or two layouts that price differently, the dearest is booked and the result is flagged, so an unproven reading can over-state the driver line and never under-state it. On agy 1.3.0 the layout is recorded ([check 17](verification/p1-agy-runtime.md)): `cache_read_tokens` sits beside `input_tokens` and outside `total_tokens`, and `output_tokens` holds the thinking, so a real result fits that one layout and is booked once. The driver is priced through the same dated price list as every dispatched model, on the day each `agy --print` process started; the `driver:` block's card is a declaration checked against the list, not the price, because Gemini 3.8 Flash's introductory card ends 31 Dec 2026.

**The thinking level is set on the model entry.** The shipped `flash-completion` entry carries `reasoning: { tier: low }`, which the bridge sends as `thinkingConfig.thinkingLevel: LOW`: the level the Claude Code harness's completion typists use, so mechanical-tier cost compares across the two harnesses. An entry with no `tier` sends no level, and the model thinks at its default. Every completion request records the level it sent in `thinking_level` (`null` when it sent none) and its `thoughtsTokenCount` in `output_tokens_reasoning`, a share of `output_tokens` that is never priced on its own.

Two consequences worth knowing when reading a report:

- **Thinking tokens count against the packet's output ceiling.** A packet can spend its whole ceiling reasoning and return no text, which the vendor reports as `MAX_TOKENS`. That is a genuine truncation and the doubling loop handles it as one — the attempt is billed, because the reasoning happened. A `MAX_TOKENS` attempt whose `output_tokens_reasoning` is close to its `output_tokens` spent the ceiling thinking, not answering.
- **Gemini also caches implicitly, without being asked.** A packet resembling one sent minutes earlier can come back with a non-zero cached count under no explicit cache. Costs stay correct either way, since the cached count is read from the response. But a cold-vs-warm pair measured back to back understates the gap.

## Output-ceiling doubling

Only the completion adapters apply an output ceiling. Whether an event's ceiling held is on the event itself:

| Adapter | Ceiling sent to the vendor | `ceiling_used` | `budget_enforced` | `budget_declared` |
|---|---|---|---|---|
| `mcp:model-dispatch` (Gemini as a model), `builtin-anthropic` | Yes, doubled on `MAX_TOKENS` | the ceiling of that attempt | absent | absent |
| `claude-agent-sdk` (Opus 5, the judgment tier), `claude-cli` | No output cap, no spend limit | `null` | `false` | the packet's `budget.maxOutputTokens` |
| `antigravity-worker` (Gemini as an agent) | No; an agent session has no ceiling under the bridge's control | `null` | `false` | the packet's `budget.maxOutputTokens` |

On the completion adapters, a packet starts at its `budget.maxOutputTokens`, clamped to the model entry's `max_output_tokens_absolute` (or the adapter's built-in limit when the entry sets none). When the vendor reports `MAX_TOKENS`, the bridge retries with the ceiling doubled, up to the absolute cap, and every attempt is billed and logged with `attempt_number` and `ceiling_used`. The report's **Packets that hit the output cap** section lists them. A packet that exhausts the absolute cap fails and, after two mechanical-tier failures, escalates to Opus 5 under the `debug` rule.

The other adapters make one attempt with no cap, so their `output_tokens` can exceed `budget_declared`; compare the two to see by how much. Judgment output is uncapped on purpose: the Opus entry's `max_output_tokens_absolute` is not applied, and the spend limit that covers judgment phases is the run-wide `hard_cost_cap_usd` (see the [README](../README.md#routing--model-per-phase)). Events written before `budget_enforced` existed carry the packet budget in `ceiling_used` for every adapter, and on these three it was never applied.

## Two doors to the mechanical tier, and how the report tells them apart

The policy declares two ways of reaching Gemini 3.8 Flash. The default calls it as a **model** (`flash-completion`): one request per packet, the conductor reading the files and writing the answer back. The alternative runs it as an **agent** (`flash-agsdk-worker`) through the Antigravity SDK, working in the directory itself. Which one an install uses is chosen once, outside the policy file, by the setup wizard (`--agent` / `--no-agent`) — see [setup.md](setup.md#gemini-as-an-agent--antigravity-sdk).

Both leaves bill the same price-list entry, because they reach the same model at the same published rates. That is why the vendor model name alone cannot tell you which one ran — `gemini-3.8-flash` appears on both. Two fields on every event carry the distinction: **`model_id`** (`flash-completion` or `flash-agsdk-worker`) and **`routing.select`** (the slot that resolved, what it resolved to, and whether the run asked or inherited the default).

**Identical rates do not mean identical cost.** An agent re-sends the accumulated conversation on every tool call, and each of its turns carries the SDK's own instruction preamble. A packet that a single completion call answers in one request can cost an agent several times as much for the same deliverable — entirely in token volume, at unchanged rates. The costs on the report are still exact; a run comparing the two doors is measuring how many tokens each approach needs.

**Door comparisons are only valid with the driver line beside them.** Which door the mechanical tier uses changes how much coordinating the conductor does in-session, and that work is on the modeled line, not the cash line. Compare doors on both lines.

## Pricing table provenance

The rates that turn tokens into dollars live in one dated price list, [`plugin/mcp/model-dispatch/src/prices.ts`](../plugin/mcp/model-dispatch/src/prices.ts). Each policy YAML under `plugin/config/policies/` carries a `pricing:` block per model — and one under `driver:` — as a readable copy of the list: documentation, billed only under `pricing_override: true` (the driver block is the one exception: `run.mjs` prices the driver line from it directly; `tools/test/driver-policy.test.mjs` holds it equal to the policy's Flash leaf, and `plugin/mcp/model-dispatch/test/prices.test.mjs` holds that leaf equal to the list). Beside each block:

- `pricing_source:` — the vendor URL these rates were taken from
- `pricing_last_verified:` — the ISO date the maintainer last checked the source page, which equals the list period's `verified` date

The list gives each model one or more periods (`from`, `to`, the five token rates, `source_url`, `verified`) and prices a model name on a day. `resolveModel(name)` maps an id (optionally with a `-YYYYMMDD` suffix or one bracketed option such as `[1m]`) to the list; `lookupPrice(name, date, {speed, service_tier, inference_geo})` returns the period's rates with fast mode or US-only inference applied, or `unpriced` with the reason. A rate is never borrowed from a similar model.

The Claude rows were verified on 2026-09-14 against [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing). Rates are USD per 1M tokens: a 5-minute cache write is 1.25× input, a 1-hour cache write is 2× input, and a cache read is 0.1× input (0.025× on Fable 5.1). The model this harness ships is:

| Model | Input | Cache read | Cache write, 5 min | Cache write, 1 h | Output | Fast mode (input / output) | US-only inference ×1.1 |
|---|---|---|---|---|---|---|---|
| `claude-opus-5` | 5.00 | 0.50 | 6.25 | 10.00 | 25.00 | 10.00 / 50.00 | yes |

The list carries every other model on Anthropic's page as well; the Claude adapters price a helper or side call on another model at that model's own rate.

The Gemini periods were verified on 2026-09-14 against both of Google's pages, the [AI Studio](https://ai.google.dev/gemini-api/docs/pricing) Standard paid tier and the [Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/pricing) Global rows, which agree on every rate. Gemini has no cache-write premium, so cache writes bill at the input rate.

| Model | Period | Input | Cached input | Output |
|---|---|---|---|---|
| `gemini-3.8-flash` | 2 Sep 2026 – 31 Dec 2026 (introductory) | 0.75 | 0.075 | 3.75 |
| `gemini-3.8-flash` | from 1 Jan 2027 | 1.50 | 0.15 | 7.50 |

Vertex's non-global rows are the rates above ×1.10, the surcharge applied at dispatch: 0.825 / 0.0825 / 4.125 through 31 Dec 2026 and 1.65 / 0.165 / 8.25 from 1 Jan 2027.

`npm test` fails when a shipped card differs from the list for today's date, when today falls outside every period for a card's model, or when a card's `pricing_source` or `pricing_last_verified` does not match that period. The shipped Gemini 3.8 Flash cards — the driver block and both worker leaves — carry the introductory rates, so from 1 Jan 2027 the suite stays red until those cards are changed to match. A run on those days does not halt: a dispatch bills the list's 2027 card and draws a `pricing.policy_mismatch` warning; the driver line, priced from the block directly, keeps the introductory rate until the block is edited.

**Which price a dispatch bills** ([`effectivePrice.ts`](../plugin/mcp/model-dispatch/src/effectivePrice.ts)):

| The policy model entry | Billed at | Event says |
|---|---|---|
| No `pricing:` block, or a block within 0.5% of the list on every rate it declares | The list | `price_basis: "list"` |
| A block more than 0.5% off the list on any rate it declares | The list. A `pricing.policy_mismatch` warning names both prices; `preflight_dispatch` returns it under `price_warnings` | `price_basis: "list"` |
| `pricing_override: true` with a block | The block | `price_basis: "custom"` |
| No list price for the model on that day, and no override | Nothing. `preflight_dispatch` halts the run before it starts | — |

A `claude-agent-sdk` (or `claude-cli`) worker is priced per model from its result's `modelUsage`; Claude Code's own `total_cost_usd` is kept as `cli_reported_cost_usd`, and a difference of more than 0.5% logs `pricing.cli_cost_mismatch`.

Before publishing a study that relies on these numbers, check every `pricing_source`, `pricing_last_verified` and the list's `verified` date against the current vendor page. When a vendor changes a rate, add a new period to `prices.ts` instead of editing the old one, so runs before the change keep their price; update the matching YAML cards in the same PR. Telemetry events already written keep the `cost_usd` stamped at dispatch.

## Before a paid run

The pricing preflight (`preflight_dispatch` with `auth_mode: vendor`, Rule 0 in the conductor prompt) reads the policy back — every model, its adapter, its effective price for today, and any `price_warnings` — and writes `preflight.json` into the run directory before the first dispatch. The list in [SETUP.md](../SETUP.md#8-before-any-paid-run) is the gate; no paid run starts without an explicit go.

## Version notes

### 0.2.0

| Area | Before | From 0.2.0 |
|---|---|---|
| Driver tokens | `input_tokens` taken as holding `cache_read_tokens`, thinking added to output, for every result | Each result booked under the layout whose parts sum to agy's `total_tokens`; unproven results at the dearest layout, flagged |
| Driver price | The `driver:` block's card, whatever the day | The dated price list on the day each agy process started; the block is checked against it. A run on or after 1 Jan 2027 bills Gemini 3.8 Flash's next card |
| Interactive driver | `NOT MEASURED` | Modeled from agy's local conversation record (`collect-driver-usage.mjs`, check 18) |
| Chat's conductor model | Not compared with the pin; a chat started as plain `agy` ran on agy's default, seen only as `pin.verified: false` afterwards | `check-driver-pin.mjs` refuses an off-pin chat before anything is dispatched, and writes the run's `policy_snapshot.yaml` |
| Run scope | Every line in the output directory, every run's | The run's own lines (`pass`); one folder per run by default; the cost cap per run |
| Opus timeout | $0 booked; 300 s default | The usage the stream reported before the stop; 1,740 s default |
| Gemini vendor error | The prompt billed as input | $0 when Google answered with an error status or the request never left the machine |
| Agent-door input (SDK 0.1.16) | Fresh input floored to 0 | Fresh input = `prompt_token_count`, by SDK version |
| Pre-check smoke | Opus, unrecorded | Gemini Flash, on the run's Gemini line |

Figures that move on the same tokens: a driver result whose total says the cache reads sit outside `input_tokens` (the stub's 1,650-token example) rises by the cache reads at the fresh rate; an Opus call stopped by a timeout rises from $0 to its frames' cost; a 4xx/5xx Gemini attempt falls to $0. Telemetry written by 0.1.0 keeps its figures; rebuild a manifest with `node plugin/agy/manifest.mjs <run-dir>` to apply the run-scope filter to it.

### 0.1.0

First harness version. The three-line cost model, the driver pin in the policy's `driver:` block, vendor-only auth mode, the code-written manifest, and the offline smoke run against the stub `agy` under `tools/test/fixtures/fake-agy/`. No measured run has been published; every figure the stub emits is labeled modeled and is not a measurement.
