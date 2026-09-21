# Repo overview

A plain-language map of this repository — what it is, how a run works, and where each piece of code lives. If you want to *use* the plugin, start with the [main README](../README.md) instead; this doc is for orienting yourself in the codebase.

## What this repo builds

An Antigravity CLI (`agy`) plugin named `mmo` (Multi-Model Orchestrator). You mount it into a project, point it at a project brief or an existing repo, and it runs a full software-delivery pipeline — requirements, design, code, tests, docs, code review, security review — with Gemini 3.8 Flash conducting, Claude Opus 5 answering the parts that need judgment and Gemini 3.8 Flash answering the parts that don't.

It is the third harness for the same plugin and the same bridge, after the [Claude Code harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness) and the [Codex harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness). What changes per harness is the runtime that conducts, how the plugin is discovered, and how the conductor's own cost is recorded.

Four things ship out of this repo:

| Thing | What it is |
|---|---|
| The plugin | Skills, rules and hooks that agy loads at session start from `.agents/plugins/mmo/`. Lives in [plugin/](../plugin/). |
| The bridge | A small Node/TypeScript MCP server bundled inside the plugin that routes each phase to the right model and records what it cost. Lives in [plugin/mcp/model-dispatch/](../plugin/mcp/model-dispatch/). |
| The headless driver | `run.mjs` and its helpers under [plugin/agy/](../plugin/agy/): the pinned `agy --print` invocation, the dispatch fallback, the modeled driver cost, the code-written manifest. The measured runs go through it. |
| The docs and examples | Everything under [docs/](.) and [examples/](../examples/) — setup guides, architecture notes, the runtime verification record, and the briefs. |

## How a run works, in one paragraph

You type `/mmo:greenfield` (new app) or `/mmo:brownfield` (existing repo). **Gemini 3.8 Flash, conducting on agy**, reads your brief, breaks the work into phases and TaskPackets, and sends every one through the bridge: judgment packets (requirements, design, planning, reviews) to Claude Opus 5 via `claude -p`, mechanical packets (codegen, tests, docs) to Gemini 3.8 Flash as a completion call or, if you chose it, as an Antigravity SDK agent. The conductor authors no shipped content, so every phase has a vendor-metered line in `telemetry.jsonl`. The conductor's own turns are priced from agy's token counters and labeled **modeled** — a Google seat has no invoice — and the two kinds of dollars are never summed. At a few points the run stops and asks you to confirm before continuing (a **HITL gate**).

## Repo layout

| Path | What's there |
|---|---|
| [plugin/skills/](../plugin/skills/) | One directory per skill. Thirteen entry points (`greenfield`, `brownfield`, `pass`, the seven job aliases, `setup`, `policy`, `revert`) and two playbooks (`pipeline`, `brownfield-guide`) the entry points read. |
| [plugin/skills/pipeline/](../plugin/skills/pipeline/) | The pipeline state machine itself: phases, TaskPacket schema, HITL gates, telemetry contract, and the role prompts under `roles/` that become the `instruction` of a judgment dispatch. |
| [plugin/rules/AGENTS.md](../plugin/rules/AGENTS.md) | The conductor rules agy loads with the plugin. |
| [plugin/agy/](../plugin/agy/) | The headless driver (`run.mjs`), the dispatch fallback (`dispatch.mjs`), the manifest writer, the setup check, the pin reader and stream-json event reader under `telemetry/`, and the two hooks under `hooks/`. |
| [plugin/agy/prompts/conductor.md](../plugin/agy/prompts/conductor.md) | The conductor prompt `run.mjs` renders for print mode. |
| [plugin/mcp/model-dispatch/](../plugin/mcp/model-dispatch/) | The bridge: routes a phase to a model per the active policy, calls the adapters (`claude-cli`, Gemini as a model, Gemini as an agent), prices every call from the dated list in `src/prices.ts`, logs telemetry. |
| [plugin/config/policies/](../plugin/config/policies/) | YAML policy files — the `driver:` pin, which model runs which phase, escalation, the cost cap. `antigravity-flash38-plus-opus5.yaml` is the default. |
| [plugin/policy-console/](../plugin/policy-console/) | The local page `/mmo:policy change` and `npm run console` open to pick or author a policy. |
| [plugin/scripts/](../plugin/scripts/) | Node scripts the skills shell out to in an interactive session: the policy console launcher, the brownfield write-contract check, provenance writer, session hydration, discovery refresh, the `MMO:` log CLI. |
| [plugin/hooks.json](../plugin/hooks.json) | agy hooks — the write-contract guard on `PreToolUse` and the bridge-call heartbeat on `PostToolUse`. |
| [plugin/examples/](../plugin/examples/) | The briefs a skill can offer, including six brownfield fixtures. |
| [.agents/plugins/mmo/](../.agents/plugins/mmo/) | The committed discovery mount — symlinks into `plugin/` — so a session opened in this repo loads the plugin. `tools/setup.mjs` builds the same mount in a project. |
| [tools/](../tools/) | Repo-level tooling: `setup.mjs` (the wizard), `report.mjs` (cost report), `logfmt.mjs` (the report's actor gutter), `p1/live-checks.sh`, and the test suite in `tools/test/` with the stub `agy` under `fixtures/fake-agy/`. |
| [docs/](.) | Everything you're reading now — see [docs/README.md](README.md) for the full index. `verification/p1-agy-runtime.md` is the numbered record every pin cites. |
| [examples/](../examples/) | Briefs you can run without reading the plugin: `unit-convert`, `quick-demo`, `workforce-ops`, `travel-ops`. Recorded runs land under `examples/<name>/passes/` once they exist. |

## Key terms

| Term | Meaning |
|---|---|
| **Conductor / driver** | The model that runs the loop — Gemini 3.8 Flash on agy. Reads, plans, dispatches, judges gate output; authors nothing shipped. |
| **Bridge** | The `model-dispatch` MCP server. Every model call crosses it, so every call is priced and recorded. |
| **Policy** | A YAML file saying which model runs which phase, plus the `driver:` pin, escalation and cost-cap rules. Chosen once per project, changeable with `/mmo:policy change`. |
| **Pin** | The conductor's model, effort and billing mode, read from the policy's `driver:` block and asserted against the `agy` invocation before anything is spent. Every pin cites a numbered check in `docs/verification/`. |
| **TaskPacket** | The unit of work the conductor hands to a phase — self-contained instructions plus the context that phase needs. |
| **Tier** | `premium` (Claude Opus 5, judgment), `mechanical` (Gemini 3.8 Flash), `local` (a plain script, no model call — the test run), or `orchestrator` (the conductor's own turns, modeled). |
| **Arm / seat** | Which Claude wallet the bridge ran with: arm A (Anthropic key), arm B (Vertex on a GCP project), or the seat (Claude Code signed in to claude.ai — modeled). |
| **Door** | How the mechanical tier reaches Gemini: `flash-completion` (one call per packet) or `flash-agsdk-worker` (an Antigravity SDK agent session). |
| **Modeled vs cash** | Cash dollars were invoiced by a vendor. Modeled dollars are what real token counts would cost at the published card when no invoice exists. Never summed. |
| **HITL gate** | A stop-and-confirm point. Greenfield has four; brownfield adds Gate 0 (confirming job scope) before the rest. |
| **Provenance** | The record of every file a run touched, with a pre-run hash, so `/mmo:revert` can undo it cleanly. |

## Where to go next

| If you want to… | Read |
|---|---|
| Install and run the plugin | [README.md](../README.md) |
| Walk through your first run | [docs/tutorial-first-run.md](tutorial-first-run.md) |
| Understand the full plugin file inventory | [docs/architecture.md](architecture.md#file-inventory) |
| See which model runs which phase and why | [docs/brownfield-routing.md](brownfield-routing.md) |
| See what has been verified live against `agy` | [docs/verification/p1-agy-runtime.md](verification/p1-agy-runtime.md) |
| Contribute a change | [CONTRIBUTING.md](../CONTRIBUTING.md) |
