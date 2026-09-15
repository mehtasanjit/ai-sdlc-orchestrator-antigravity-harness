# AI-SDLC Orchestrator — Antigravity CLI harness

The third runtime harness for the multi-model AI-SDLC pipeline, after the [Claude Code harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness) and the [Codex harness](https://github.com/tl-ai-labs/ai-sdlc-orchestrator-codex-harness). The same `mmo` plugin, the same `model-dispatch` bridge, ported to Google's Antigravity CLI (`agy`).

| Role | Model | Path |
|---|---|---|
| Conductor (driver) | Gemini 3.8 Flash, effort high | `agy` itself, on your Google seat |
| Judgment phases | Claude Opus 5 | bridge → `claude-cli` adapter → `claude -p` (the Claude Agent SDK engine). Arm A bills an Anthropic key; arm B bills a GCP project through Vertex |
| Mechanical phases | Gemini 3.8 Flash | bridge → `flash-completion` on `GEMINI_API_KEY`, or the Antigravity SDK worker on Vertex ADC |

The conductor authors no shipped content. Every requirements document, design, packet result, review and test comes back from a bridge dispatch, where it is priced and recorded in `telemetry.jsonl`.

## Status

**P2 — skeleton.** The plugin, bridge, policies and prompts are in place and the offline test suite passes. The driver layer (`plugin/agy/`), the hook shim and the agy re-wording of the prompts land in P3, after the live checks in [docs/verification/p1-agy-runtime.md](docs/verification/p1-agy-runtime.md) settle which dispatch pattern the runtime supports. No measured run has been made.

## Layout

| Path | What |
|---|---|
| `plugin/plugin.json`, `plugin/mcp_config.json`, `plugin/rules/AGENTS.md` | The agy plugin manifest, its bridge registration, and the conductor rules |
| `plugin/skills/<name>/SKILL.md` | The 13 entry points (`greenfield`, `pass`, `brownfield`, …) plus `pipeline` and `brownfield-guide` |
| `plugin/agents/*.md` | The five role prompts, carried as content: each becomes the system prompt of a bridge dispatch |
| `plugin/mcp/model-dispatch/` | The bridge: routing policy → adapter → model, with its own telemetry ledger. `dist/` is gitignored; build it |
| `plugin/config/policies/` | Routing policies. `antigravity-flash38-plus-opus5.yaml` is the study policy; `antigravity-flash38-plus-haiku45.yaml` proves the wiring for cents |
| `plugin/agy/` | The driver layer (P3): `run.mjs`, the conductor prompt, the stream-json event reader, the fairness pin |
| `.agents/plugins.json` | Registers `plugin/` with agy from the repo. Nothing is written under `~/.gemini/` |
| `docs/verification/p1-agy-runtime.md` | Numbered runtime checks. Every pin cites one |
| `examples/*/brief.md` | Briefs. `quick-demo` is the first paid run |
| `tools/report.mjs` | Cost report over a run directory |

## Quick start

See [INSTALL.md](INSTALL.md) for the steps an agent (or you) can follow verbatim, and [SETUP.md](SETUP.md) for credentials and the two Claude arms.

```bash
npm ci
npm run build
npm test
```

## Standing rules

- Generic engine only: no campaign values, seeds or study ids in code.
- Never commit keys, credential files, run databases, run folders, or `dist/`.
- Every change ships its tests, offline and free, reachable from `npm test`.
- Pricing preflight before any paid run; no paid run without an explicit go.
- The `google-antigravity` SDK is never the driver and never carries a Claude call. agy's built-in Claude is never used.
- Nothing under `~/.gemini/` or `~/.claude` is edited; everything lives under `.agents/` in the repo.
- Modeled dollars (the driver line) and cash dollars (bridge dispatches) are never summed into one figure.

## Licence

MIT — see [LICENSE](LICENSE).
