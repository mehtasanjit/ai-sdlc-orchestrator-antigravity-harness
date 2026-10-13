# Architecture

> **For:** understanding how a request flows through the harness — conductor, bridge, dispatch routes, hooks, records — and finding any file. **Also see:** [running.md](running.md) · [methodology.md](methodology.md) · [repo-overview.md](repo-overview.md).

![Two routes to the same bridge — an interactive agy session calls the model-dispatch tools through call_mcp_tool; a headless run.mjs invocation shells out to dispatch.mjs, which speaks MCP to the same server; both reach the same five tools, adapters and telemetry.jsonl](assets/dispatch-routes.svg)

The conductor shape: a cheap conductor runs the loop, every model call goes through the bridge, the harness around the conductor writes the records.

```
node plugin/agy/run.mjs
  │  builds the pinned argv, renders the conductor prompt and skills
  ▼
agy --print <conductor.md> --output-format stream-json --model gemini-3.8-flash-high
  │  print mode loads no plugin: the rendered conductor prompt tells Gemini to dispatch through dispatch.mjs
  │  Gemini conducts: reads the brief, builds TaskPackets, runs dispatch.mjs, writes artifacts
  ▼
model-dispatch (MCP, stdio)             ← execute_with_model / preflight_dispatch / load_policy / …
  │  policy rules → adapter → model; appends telemetry.jsonl
  ├─ claude-agent-sdk → Claude Agent SDK, in-process → claude-opus-5, effort high  (judgment phases; arm A key, arm B Vertex, or the claude.ai seat)
  └─ mcp:model-dispatch → Gemini 3.8 Flash (flash-completion)      (mechanical phases)
       or antigravity-worker → Antigravity SDK agent on Vertex ADC
  ▼
run.mjs reads the stream: models the driver's cost, checks for a pin rejection, writes the driver manifest
plugin/agy/manifest.mjs builds manifest.json from telemetry.jsonl + the driver files
```

## Who does what

| Piece | Owns | Never does |
|---|---|---|
| `run.mjs` | The invocation, the pins, the resume loop, the records | Decide pipeline order, author content |
| The conductor (Gemini on agy) | Reading the brief, building packets, judging results, gates | Author a requirements doc, design, code, test or review |
| The bridge | Routing, adapters, pricing, `telemetry.jsonl` | Anything agy-specific |
| The hooks | The write contract, the bridge-call heartbeat | Block on a bug — they fail open |

## Two dispatch routes

**(a) MCP route — interactive.** In a trusted workspace agy loads the plugin's `mcp_config.json`, starts the bridge, and exposes its tools under the namespaced server `mmo_model-dispatch` through the generic `call_mcp_tool` (no per-tool binding). The rules name the server and tools.

**(b) Dispatch script — headless.** `agy -p` loads no plugin at all (check 1), so the conductor prompt `run.mjs` renders tells the model to run `node plugin/agy/dispatch.mjs --packet=… --out=…`, which spawns the same server as a stdio subprocess through `plugin/mcp/model-dispatch/src/driverClient.ts` and speaks MCP to it. When `--out` already holds a result, the script moves it to `<name>.1.json` (then `.2`, ...) before writing, so a packet dispatched twice keeps both results. Same tools, same TaskPacket contract; only who opens the socket differs. agy's sandbox does not kill it (check 2).

## Three cost lines

| Line | Source | Kind |
|---|---|---|
| Driver (Gemini on agy) | Headless: stream-json `usage`; interactive: agy's local conversation record (`collect-driver-usage.mjs`). Priced at the dated list; thinking at the output rate, cache reads at the cached rate | modeled |
| Gemini workers | bridge `telemetry.jsonl` | cash (API key or Vertex) |
| Opus 5 | bridge `telemetry.jsonl`, from the Claude Agent SDK's result (`claude-agent-sdk` adapter) | cash (Anthropic on arm A, GCP on arm B); modeled on the seat |

The modeled line lives in `driver-cost-modeled.jsonl` with `tier: "orchestrator"` and `provenance: "modeled"`, so `buildManifest` partitions it out of dispatched sums if the two files are ever concatenated. Nothing adds modeled and cash dollars into one figure.

## The pin, in one place

The policy's top-level `driver:` block carries `model_name`, `reasoning.effort`, `billing_mode` and the card. `fairnessPin.mjs` reads it, derives the slug, and asserts the argv before anything is spent. It is not a `models[]` entry because preflight builds an adapter for every model.

## Plugin discovery

`.agents/plugins/mmo/` — symlinks into `plugin/` — is what agy discovers in a trusted workspace (check 10; the declared `.agents/plugins.json` route did not resolve). `tools/setup.mjs` builds the same mount in a project. Nothing is written under `~/.gemini/`. Headless runs do not depend on discovery at all (print mode loads nothing), so `--inline-env` is only relevant if a future agy loads plugins in print mode without expanding `${VAR}`.

## Hook mapping from the Claude Code harness

agy has five hook events (`hooks.md`): `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. No `SessionStart`, no `UserPromptSubmit`.

| Claude Code hook | Purpose there | Here |
|---|---|---|
| `PreToolUse` on `Write\|Edit` | Brownfield write contract | `PreToolUse` on the file-writing step types and `run_command`, `plugin/agy/hooks/write-contract-check.mjs`, reply `{"decision": …}` |
| `PostToolUse` on `mcp__…execute_with_model` | Heartbeat beside the bridge's own telemetry | `PostToolUse` on `mcp_tool`, `plugin/agy/hooks/heartbeat.mjs` |
| `Stop` → auto-ship (governance store) | Ship the run record when the loop ends | `Stop` maps directly; the shipping command is the store's, not this repo's, and is added to `plugin/hooks.json` when the store's hook lands |
| `SessionStart`, `UserPromptSubmit` | Session hydration, prompt-time checks | `PreInvocation` (fires before every model call; use `injectSteps` with an `ephemeralMessage`) |

Hook commands run with cwd = the directory containing `hooks.json` (the plugin dir), so `plugin/hooks.json` names scripts relative to it and no `${CLAUDE_PLUGIN_ROOT}` exists.

## File inventory

| Path | What |
|---|---|
| `plugin/plugin.json`, `plugin/mcp_config.json`, `plugin/rules/AGENTS.md` | The agy plugin manifest, its bridge registration, and the conductor rules |
| `plugin/skills/<name>/SKILL.md` | The 13 entry points (`greenfield`, `pass`, `brownfield`, the seven job aliases, `setup`, `policy`, `revert`) plus the two playbooks `pipeline` and `brownfield-guide` |
| `plugin/skills/pipeline/roles/*.md`, `plugin/skills/brownfield-guide/discovery.md` | The role prompts, carried as content: architect, senior reviewer and security reviewer are the `instruction` body of their phase's bridge dispatch; discovery is the conductor's own local read |
| `plugin/mcp/model-dispatch/` | The bridge: routing policy → adapter → model, with its own telemetry ledger. `dist/` is gitignored; `npm run build` produces it |
| `plugin/mcp/model-dispatch/src/prices.ts` | The dated price cards every policy's pricing block must match (`prices.test.mjs` enforces it) |
| `plugin/mcp/model-dispatch/worker/gemini_worker.py` | The Antigravity SDK agent worker — the only Python file, installed only on machines that chose the agent path |
| `plugin/config/policies/` | The one routing policy this harness ships, `antigravity-flash38-plus-opus5.yaml`: Gemini 3.8 Flash conducts, Opus 5 judges, Flash executes. The Claude harness's presets are bridge test fixtures only |
| `plugin/agy/run.mjs` | The headless driver: builds the pinned `agy --print` invocation, captures stream-json, runs the resume loop, writes the driver's modeled cost and the manifest |
| `plugin/agy/prompts/conductor.md` | The conductor prompt: state machine, TaskPacket contract, gates, the MCP route and the dispatch fallback |
| `plugin/agy/telemetry/` | `fairnessPin.mjs` reads the pin off the policy's `driver:` block; `event-reader.mjs` prices stream-json `usage` as a labeled modeled line |
| `plugin/agy/dispatch.mjs` | Pattern (b): the conductor shells out to this when its session binds no bridge tool; it speaks MCP via `mcp/model-dispatch/src/driverClient.ts` |
| `plugin/agy/hooks/`, `plugin/hooks.json` | The write-contract PreToolUse guard and the bridge-call heartbeat, in agy's hook format |
| `plugin/agy/verify-setup.mjs`, `plugin/agy/env-checks.mjs` | Offline setup check and repair (`npm run verify -- --fix`) |
| `plugin/agy/manifest.mjs` | Writes `manifest.json` from the run directory: the bridge's rollups plus `harness`, `usage` and `cost` (three labeled lines) |
| `plugin/agy/runRoot.mjs`, `plugin/agy/mmoSelect.mjs` | The `--inline-env` per-run root, and the `MMO_SELECT` door choice read from `.sdlc/local/mmo-select.json` |
| `plugin/scripts/` | Scripts the skills call in an interactive session: `setup-policy.mjs` (the console), `write-provenance.mjs`, `write-contract.mjs` (freezes and ends a brownfield contract), `session-hydrate.mjs`, `mmo-log.mjs` and the rest |
| `plugin/policy-console/` | The one UI: a local page (`npm run console`, then http://127.0.0.1:3000) to pick or customize a routing policy. Shows the agy driver pin on every card and carries it into saved policies |
| `plugin/examples/` | The briefs the skills can offer, including the six brownfield fixtures |
| `.agents/plugins/mmo/` | The discovery mount: symlinks into `plugin/`, which is how agy finds the plugin in a trusted workspace (check 10). Nothing is written under `~/.gemini/` |
| `docs/verification/p1-agy-runtime.md` | Numbered runtime checks. Every pin cites one |
| `examples/*/brief.md` | Briefs. `quick-demo` is the first paid run |
| `tools/setup.mjs` | The setup wizard prompt 1 drives: checks, build, project registration, policy pick |
| `tools/report.mjs` | Cost report over a run directory |
| `tools/logfmt.mjs` | The actor gutter the report prints — who produced each line (conductor, judgment worker, mechanical worker, handoff) |
| `tools/p1/live-checks.sh` | The scripted half of the runtime checks |
| `tools/test/` | The offline suite `npm test` runs, including the stub `agy` under `fixtures/fake-agy/` |
