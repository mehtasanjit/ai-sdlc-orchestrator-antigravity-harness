# Methodology

> **For:** understanding how tokens and costs are counted — which figures are vendor-metered, which are modeled, and why the two are never added. **Also see:** [understanding-output.md](understanding-output.md) · [architecture.md](architecture.md#three-cost-lines) · [logging.md](logging.md).

![Three cost lines — the driver (Gemini 3.8 Flash on agy, modeled from stream-json usage), the Gemini workers (mechanical phases, cash on a key or Vertex) and the Claude worker (Opus 5 through claude -p, cash on arm A or B, modeled on the seat) — with the manifest's note that the two kinds of dollars are not summed](assets/cost-lines.svg)

How the tokens and costs on the report are derived, in plain terms.

## Three cost lines

A run on this harness produces three cost lines, and the report, the manifest and every doc keep them apart:

| Line | Who | Source | Kind |
|---|---|---|---|
| Driver | Gemini 3.8 Flash conducting on agy | stream-json `usage` × the policy's `driver.pricing` card | **modeled** |
| Gemini workers | Gemini 3.8 Flash on the mechanical phases | bridge `telemetry.jsonl` — the vendor's `usageMetadata` | cash (API key or Vertex) |
| Claude worker | Claude Opus 5 on the judgment phases | bridge `telemetry.jsonl` — `claude -p`'s result `usage` | cash on arm A (Anthropic) or arm B (GCP); **modeled** on the seat |

**Modeled** means: the tokens are real counts the runtime reported, and the dollars are what those tokens would cost at the published card. No invoice exists. A conductor on a Google seat, or Claude Code signed in to a claude.ai subscription, draws on a quota that has no per-token bill; the figure describes usage, not spend.

**Cash** means: a vendor metered the tokens and will invoice them — the Anthropic key's dashboard, the GCP project's billing page, or the AI Studio key's.

The rule that follows is stated in the manifest itself (`cost.note`) and enforced by every aggregator: `dispatched_cash_usd` and the modeled figures are different kinds of dollars and are not summed. A single "total" that mixed them would be neither the API bill nor the seat usage. Compare architectures on the cash line and the modeled line side by side, each labeled, or not at all.

### Why the driver line is modeled

agy prints `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}` in its stream-json `result` envelope ([check 8](verification/p1-agy-runtime.md)) and no wallet figure ([check 9](verification/p1-agy-runtime.md)). `plugin/agy/telemetry/event-reader.mjs` prices those counters at the `driver:` block's card — thinking at the output rate, cache reads at the cached rate — and writes one line per turn to `driver-cost-modeled.jsonl` with `provenance: "modeled"` and `tier: "orchestrator"`. `usage` is cumulative within one agy process. `run.mjs` resumes a run in a new process, and whether that process continues the counters or restarts them is [check 16](verification/p1-agy-runtime.md), still pending: a resumed run reports the driver line as a range, with the upper bound as the headline figure. An invocation that ends without a `result` event (a timeout or crash) reports no usage at all; the manifest names it in `harness.driver_invocations_without_usage`, and its driver tokens are missing from every figure.

A metered driver is possible — `billing_mode: gemini-api-key` in the policy's `driver:` block, with `modelProvider: "gemini"` in agy's own settings — but it needs an edit under `~/.gemini/`, which the standing rules exclude. If a study needs it, the manifest records the decision in `harness.provider_source.driver`.

### Why the Claude line is cash on the arms and modeled on the seat

Every Opus call crosses the bridge through the `claude-cli` adapter, which spawns `claude -p` with the bridge's environment and reads the result's `usage` and `modelUsage`. The tokens are the same whichever wallet paid. The dollars differ:

- **Arm A** — `ANTHROPIC_API_KEY` exported. Anthropic meters and invoices. Cash.
- **Arm B** — `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION=global`. Google Cloud meters and invoices at the Vertex Claude card. Cash — but check the card in `prices.ts` before the first arm-B run; `claude -p`'s own `total_cost_usd` is a check there, not the figure of record.
- **The seat** — nothing exported; Claude Code is signed in to claude.ai (`claude auth status` shows `authMethod: claude.ai`). No invoice. `manifest.mjs` moves the line out of `dispatched_cash_usd` into `claude_seat_modeled_usd` and labels it `kind: "modeled"`.

The manifest's `harness.arm` says which applied. A key and the Vertex variables set at once is refused by `verify` and by the wizard, because the run record could not then say which wallet paid.

## Vendor mode is the only mode

The Claude Code harness offers `--auth=vendor|estimated`, where estimated mode prices the driver's own in-session judgment work by a character-count heuristic. This harness has no in-session judgment work: every judgment phase is a bridge dispatch with a vendor-reported `usage` block, and the conductor's own loop is priced from agy's counters. `--auth=vendor` is therefore the only value `/mmo:pass` and `run.mjs` accept; `estimated` aborts with the rule-6 text. Every dispatched event carries `provenance: "vendor"`, stamped server-side by the bridge, and a driver line carries `provenance: "modeled"`, stamped by the event reader. A phase the conductor completes without dispatching is logged at zero with `provenance: "none"` (`dispatch.mjs --log-phase`), so a report never shows an unexplained gap in the state machine.

## The `MMO:` log stream is not telemetry

`telemetry.jsonl` and the `MMO:`-prefixed log stream ([logging.md](logging.md)) record different things and neither replaces the other. Telemetry is cost accounting: one event per dispatch attempt, written once that attempt completes, carrying exactly the fields the report sums. The log stream is an event trace — routing decisions, vendor request/response, worker spawn and exit, write-contract decisions — one `MMO: <timestamp> <LEVEL> <event> key=value…` line per event, to stderr and to the run's `orchestrator.log`. It carries no dollar figures. A dispatch that fails before a vendor call completes emits `dispatch.error` on the log stream but no telemetry event, because there is nothing to bill.

## Where the numbers come from

- **Token counts pass through unchanged from the source.** A dispatched event's counts are exactly what the vendor's `usage` block returned. A driver line's counts are exactly what agy's `result.usage` reported, differenced per turn. Report totals are those per-event counts summed — nothing between measurement and display.
- **Cost is computed and written at the moment of each call.** A dispatched event's `cost_usd` is (its tokens × the model's effective price on the dispatch day) / 1M, stamped into `telemetry.jsonl` at write time with `price_basis` (`list` or `custom`). A driver line's is (its tokens × the `driver.pricing` card) / 1M, stamped when `run.mjs` reads the stream.
- **The manifest is written by code.** `plugin/agy/manifest.mjs` sums the two files and stamps the wallet, the pin and the three lines. The conductor's `SUMMARY.md` quotes telemetry rows; it never computes a figure, and it is not the record.
- **Telemetry covers dispatched work only.** The conductor's own loop is in `driver-cost-modeled.jsonl`, never in `telemetry.jsonl`; `buildManifest` partitions any `tier: "orchestrator"` line out of every dispatched sum if the two files are ever concatenated.

To verify any of these, walk the two JSONL files by hand — every line is inspectable.

## How Gemini's token counts are read

Google's `usageMetadata` has two fields that look alike and behave in opposite ways. Both are handled explicitly, because getting either wrong moves the headline number.

**`cachedContentTokenCount` is a *subset* of `promptTokenCount`.** The prompt count is the whole prompt, cached portion included. Cost is computed on disjoint counts — fresh input at the full rate, cached input at the read rate — so the cached count is subtracted from the prompt count before pricing. That subtraction happens exactly once, in the adapter: the `input_tokens` written to telemetry is already the fresh count, and every reader prices the stored buckets as they are and never subtracts again.

**`thoughtsTokenCount` is a *sibling* of `candidatesTokenCount`.** Gemini 3.x reasons before it answers, and Google bills that reasoning at the output rate — but reports it outside the candidate count. Billed output is therefore `candidatesTokenCount + thoughtsTokenCount`. A single-token answer can come with ~100 thinking tokens; reading the candidate count alone would understate precisely the model whose lower cost the multi-model run exists to show.

The same two rules apply to the driver line: agy's `cache_read_tokens` is priced at the cached rate and its `thinking_tokens` at the output rate.

Two consequences worth knowing when reading a report:

- **Thinking tokens count against the packet's output ceiling.** A packet can spend its whole ceiling reasoning and return no text, which the vendor reports as `MAX_TOKENS`. That is a genuine truncation and the doubling loop handles it as one — the attempt is billed, because the reasoning happened.
- **Gemini also caches implicitly, without being asked.** A packet resembling one sent minutes earlier can come back with a non-zero cached count under no explicit cache. Costs stay correct either way, since the cached count is read from the response. But a cold-vs-warm pair measured back to back understates the gap.

## Output-ceiling doubling

Every model entry carries `max_output_tokens_absolute`. A packet starts at the policy's default ceiling; when the vendor reports `MAX_TOKENS`, the bridge retries with the ceiling doubled, up to the absolute cap, and every attempt is billed and logged with `attempt_number` and `ceiling_used`. The report's **Packets that hit the output cap** section lists them. A packet that exhausts the absolute cap fails and, after two mechanical-tier failures, escalates to Opus 5 under the `debug` rule.

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

The list carries every other model on Anthropic's page as well; `claude-cli` prices a helper or side call on another model at that model's own rate.

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

A `claude-cli` worker is priced per model from its result's `modelUsage`; Claude Code's own `total_cost_usd` is kept as `cli_reported_cost_usd`, and a difference of more than 0.5% logs `pricing.cli_cost_mismatch`.

Before publishing a study that relies on these numbers, check every `pricing_source`, `pricing_last_verified` and the list's `verified` date against the current vendor page. When a vendor changes a rate, add a new period to `prices.ts` instead of editing the old one, so runs before the change keep their price; update the matching YAML cards in the same PR. Telemetry events already written keep the `cost_usd` stamped at dispatch.

## Before a paid run

The pricing preflight (`preflight_dispatch` with `auth_mode: vendor`, Rule 0 in the conductor prompt) reads the policy back — every model, its adapter, its effective price for today, and any `price_warnings` — and writes `preflight.json` into the run directory before the first dispatch. The list in [SETUP.md](../SETUP.md#8-before-any-paid-run) is the gate; no paid run starts without an explicit go.

## Version notes

### 0.1.0

First harness version. The three-line cost model, the driver pin in the policy's `driver:` block, vendor-only auth mode, the code-written manifest, and the offline smoke run against the stub `agy` under `tools/test/fixtures/fake-agy/`. No measured run has been published; every figure the stub emits is labeled modeled and is not a measurement.
