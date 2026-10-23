# AI-SDLC plugin — documentation

Everything the [main README](../README.md) couldn't fit. Grouped by what you're trying to do — a tutorial to learn, how-to guides to accomplish, reference to look up, concepts to understand.

Start with the tutorial if you have not run the harness before. Skip straight to the how-to guides if you already know what you want to do. New to the codebase itself rather than the plugin's usage? Start with [Repo overview](repo-overview.md).

## Tutorial

Learn by doing. Follow along top to bottom, no prior knowledge assumed.

| Doc | For |
|---|---|
| [Your first `/mmo:greenfield`](tutorial-first-run.md) | Twenty minutes from a fresh setup to a completed greenfield run: the $0 offline smoke run first, then the real thing. |

## How-to guides

Direct, imperative. Each guide gets a specific job done.

| Doc | For |
|---|---|
| [Install & credentials](setup.md) | Setting up a fresh install: prerequisites, the two Claude arms and the seat, both Gemini doors, the per-project policy pick. |
| [Run the harness](running.md) | The interactive skills, every flag on the headless driver, the pin gate, the resume loop, the offline smoke run. |
| [Live tokenomics dashboard](live-dashboard.md) | Running `tools/dashboard-server.mjs` to watch the 3-tier agent roster, Conductor stream, and TaskPacket inspector in real time. |
| [Bring your own brief](brief-template.md) | Writing a project brief in the section layout the requirements phase expects. |
| [Brownfield walkthrough](brownfield.md) | Running `/mmo:brownfield` on an existing repo — the seven job types and the Gate 0 confirmation. |

## Reference

Look things up. Exact answers, exhaustive.

| Doc | For |
|---|---|
| [Troubleshooting](troubleshooting.md) | Symptom → cause → fix, keyed by the error message on screen. |
| [Brownfield setup issues](brownfield-setup-issues.md) | Every install-time issue that has hit real users and how the plugin handles each. |
| [Understanding output](understanding-output.md) | Reading `telemetry.jsonl`, `driver-cost-modeled.jsonl`, `manifest.json`, `provenance.json`, and the cost report. |
| [Logging](logging.md) | The `MMO:` log stream — format, levels, taxonomy, enablement, redaction. |
| [Runtime verification](verification/p1-agy-runtime.md) | The numbered live checks against `agy` that every pin cites. A historical record. |
| [Headless proof runs](verification/headless-proof-runs-2026-10-14.md) | The 14 Oct greenfield and brownfield runs on the fixed code: cost checked line by line, and the defects they found. A historical record. |

## Concepts

Reasoning-forward. Understand why the pieces are shaped the way they are.

| Doc | For |
|---|---|
| [Architecture](architecture.md) | Conductor, bridge, the two dispatch routes, hooks, the three cost lines, the full file inventory. |
| [Methodology](methodology.md) | How tokens and costs are derived; modeled vs cash; the price list and what each version changed about the numbers. |
| [Brownfield write contract](brownfield-write-contract.md) | How the "never touch off-limits" guarantee is enforced at the tool boundary. |
| [Brownfield model routing](brownfield-routing.md) | Which model runs which phase and why the mechanical tier drops cost. |
| [Brownfield coexistence](brownfield-coexistence.md) | Living alongside Cursor, Aider, Copilot, and custom MCP servers. |
| [Brownfield privacy](brownfield-privacy.md) | What leaves the machine, per phase. On-prem routing, PII handling, audit trail. |

## Diagrams

The SVGs under [assets/](assets/) are the pictures the README and the docs embed: [hero.svg](assets/hero.svg) (the two prompts and the cast), [dispatch-routes.svg](assets/dispatch-routes.svg) (interactive vs headless), [phases-and-gates.svg](assets/phases-and-gates.svg) (the state machine), [cost-lines.svg](assets/cost-lines.svg) (modeled vs cash). Each carries a `<desc>` so it reads without rendering.

## For maintainers

- [Contributing](../CONTRIBUTING.md) — style rules, PR process, base branch.
- [AGENTS.md](../AGENTS.md) — the writing conventions and standing rules an agy session editing this repo follows.
- [INSTALL.md](../INSTALL.md) and [SETUP.md](../SETUP.md) — the agent-facing setup manual prompt 1 drives. Not user docs; the style test excludes them.
