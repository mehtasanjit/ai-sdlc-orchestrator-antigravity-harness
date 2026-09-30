# Setup

> **For:** setting up a fresh install, or adding a wallet or a Gemini door. **Also see:** [tutorial-first-run.md](tutorial-first-run.md) · [running.md](running.md) · [troubleshooting.md](troubleshooting.md).

Everything you need to prepare your machine for a run. [INSTALL.md](../INSTALL.md) is the literal command sequence an agent follows for prompt 1; [SETUP.md](../SETUP.md) is what it tells you at each step. Failure modes and repair commands are in [troubleshooting.md](troubleshooting.md).

## Prerequisites

| Item | Verify with | Notes |
|---|---|---|
| Node.js 20+ | `node --version` | The bridge, the driver and the setup scripts. |
| Antigravity CLI `agy` ≥ 1.2.3 | `agy --version` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` installs to `~/.local/bin/agy`; open a new shell. |
| Google sign-in for agy | `agy models` lists models | Run `agy` once with no arguments and finish the browser flow. A person does this; it cannot be done headlessly. |
| Claude Code `claude` | `claude --version` | The `claude-cli` adapter spawns `claude -p` for every Opus call. |
| git | `git --version` | Brownfield needs ≥ 2.30. |
| macOS, Linux, or WSL2 | — | POSIX bash. |

## Where credentials must live

The bridge is a stdio subprocess and inherits nothing on its own. `plugin/mcp_config.json` forwards every variable it needs as `${VAR}` from the environment agy was launched with, so **export in the shell that starts `agy`** (or `run.mjs`). A variable set inside an agy session runs in a child shell and never reaches the bridge.

Nothing is written under `~/.gemini/` or `~/.claude/`; there is no global install. Never write a key into a file in either repo.

Headless, if a future agy stops expanding `${VAR}` ([check 5](verification/p1-agy-runtime.md)), `run.mjs --inline-env` materialises a per-run root under the OS temp dir with the values inlined and deletes it afterwards.

## What setup produces

| Where | What | Written by |
|---|---|---|
| `<harness>/plugin/mcp/model-dispatch/dist/` | The compiled bridge `mcp_config.json` points at | `npm run build` |
| `<project>/.agents/plugins/mmo/` | Symlinks into the clone's `plugin/`, which is how agy discovers the plugin in a trusted workspace | `tools/setup.mjs` |
| `<project>/.sdlc/project.json` | `default_policy`, the off-limits defaults | `plugin/scripts/setup-policy.mjs` (the policy console) |
| `<project>/.sdlc/local/mmo-select.json` | `MMO_SELECT` when the agent path is chosen | `tools/setup.mjs --agent`, `npm run verify -- --enable-agent` |

`node tools/setup.mjs --project-root <project>` prints eight numbered steps. ✓ is done, ! is advisory (a run works, with a limit named), ✗ is blocking (a run would halt at preflight or the first dispatch). `npm run verify` runs the same checks with no questions; `--fix` builds the bridge.

## Providers

The pipeline reaches three surfaces: the conductor's Google seat (agy's own sign-in), one Claude wallet for the judgment phases, and one Gemini door for the mechanical phases.

### The conductor — agy on your Google seat

No variable. agy signs in with your Google account and the conductor runs on that quota; its cost is modeled, never invoiced ([methodology.md](methodology.md#why-the-driver-line-is-modeled)). A metered driver (`billing_mode: gemini-api-key`) needs `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json`, which the standing rules exclude.

### The Claude wallet — two arms and the seat

Every wallet runs the same policy file and the same `claude-cli` adapter. The wallet is the environment the bridge is launched with, or, with nothing exported, Claude Code's own sign-in.

| | Arm A | Arm B | Seat |
|---|---|---|---|
| Wallet | Anthropic API key | GCP project, Google's invoice, Google's published Claude rates | A claude.ai subscription (Pro / Max) that Claude Code is signed in to |
| Env | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_USE_VERTEX=1` `ANTHROPIC_VERTEX_PROJECT_ID=<gcp-project>` `CLOUD_ML_REGION=global` + ADC | nothing — `claude auth status` shows `authMethod: claude.ai` |
| Cost of record | tokens from the `claude -p` result × the Anthropic card — cash | tokens from the same result × the Vertex Claude card; the GCP invoice is the receipt — cash | tokens × the Anthropic card — **modeled**; no invoice exists |
| Gate | key present | project active, Claude enabled in Model Garden (24–48 h approval), `roles/aiplatform.user`, quota in region | signed in once with `claude` |
| Study use | yes | yes | wiring and development runs; a study cost of record on it needs the owner's sign-off |

A key or the Vertex variables win over the seat when both are present. Arm A and arm B set at once is refused by `verify` and by the wizard: the run record could not say which wallet paid. `manifest.json` records the wallet as `harness.arm` (`A`, `B` or `seat`) and, on the seat, moves the Claude line out of `cost.dispatched_cash_usd` into `cost.claude_seat_modeled_usd`.

**Verify arm B** with `claude -p --model claude-opus-5 'say ok'` under the arm-B env. A `403` names the project state; a `404 model not found` means Model Garden has not enabled Claude yet.

The adapter probes `claude --version` at startup and refuses the model with an actionable error if the binary is missing. The CLI surfaces its own auth errors; the plugin does not probe OAuth state beyond `claude auth status`. Each call spawns a fresh `claude` process, which re-sends its session context; that overhead shows up as cache-write tokens in the telemetry, priced at the cache-write rate for its TTL. The CLI's own `total_cost_usd` is kept on the event as `cli_reported_cost_usd` and is never the cost.

### Gemini as a model — AI Studio key

| Variable | Type | Default | Required when | Description |
|---|---|---|---|---|
| `GEMINI_API_KEY` | string | — | AI Studio door | API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). |

A key present is a deliberate local choice, so it outranks ambient Vertex credentials — set `GEMINI_BACKEND=vertex` to override.

### Gemini as a model — Vertex (ADC) {#gemini-as-a-model--vertex-adc}

| Variable | Type | Default | Required when | Description |
|---|---|---|---|---|
| — | file | `~/.config/gcloud/application_default_credentials.json` | ADC door | Written by `gcloud auth application-default login`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | path | — | service-account file | Full path to a service-account JSON. Outranks the gcloud ADC file. |
| `GOOGLE_CLOUD_PROJECT` | string | project recorded inside the credentials file | account with more than one project | Billing project for Gemini calls. A project ID alone is not a credential. |
| `GOOGLE_CLOUD_LOCATION` | string | `global` | pinning a region | Non-global endpoints bill **+10%** on every token class for Gemini 3+. The bridge applies the surcharge to the reported cost; the policy YAML keeps the flat global rates. |
| `GEMINI_BACKEND` | `vertex` \| `api-key` | auto-detected | forcing a door | Explicit override of the credential-precedence logic. |

On the default (unset region) the cost the bridge reports is the cost Google bills. Pin a region only when you need quota or latency the global endpoint cannot give you.

### Gemini as an agent — Antigravity SDK

The mechanical tier can be reached either as a model (one completion call per packet) or as an agent that opens the working directory itself, runs commands, and edits files. Both bill the same project at the same published rates; the difference is token volume and evidence.

| Variable | Type | Default | Required when | Description |
|---|---|---|---|---|
| `MMO_SELECT` | `slot=option,...` | unset (→ `flash-completion`, the model path) | selecting the agent | Written by `npm run verify -- --enable-agent` (or the wizard's question) as `gemini-flash=flash-agsdk-worker` into `.sdlc/local/mmo-select.json`. Do not set by hand — writing just the option (`flash-agsdk-worker`) passes offline checks and throws at policy load, after premium phases are billed. |
| `GEMINI_WORKER_PYTHON` | path | plugin-built venv at `plugin/mcp/model-dispatch/worker/.venv/bin/python` | using your own interpreter | Python ≥ 3.10 with `google-antigravity` installed. Skips the built-in venv. |

**Constraints.**

- **ADC only.** The Antigravity SDK signs with Application Default Credentials and has no API-key door. `GEMINI_API_KEY` cannot reach this path. While a GCP project is suspended only `flash-completion` on `GEMINI_API_KEY` runs.
- **Python 3.10+.** `google-antigravity` declares that minimum. macOS ships 3.9 as `/usr/bin/python3`, so the default interpreter is the one that will not work. `--enable-agent` searches by explicit version name (`python3.13`, `python3.12`, …) rather than trusting the bare `python3`.
- **Cost.** Several times more per packet than the model path. The SDK re-sends the full conversation on every tool call plus its identity preamble every turn. Same rates, many more tokens.
- **Never the driver.** The `google-antigravity` SDK is never the conductor and never carries a Claude call.

**Choosing it.** The wizard asks only when the setup check finds a usable Vertex ADC — offering it otherwise would offer something that cannot work. `--agent` / `--no-agent` pre-answer the question. The choice lands in `.sdlc/local/mmo-select.json`, which the dispatch fallback reads; for the interactive MCP route also export `MMO_SELECT=gemini-flash=flash-agsdk-worker` in the shell that launches agy. Pin the door in the run record.

Toggle it at any time from the clone:

```bash
npm run verify -- --enable-agent
npm run verify -- --disable-agent
```

**Confirming the choice took effect.** A run that used the agent path leaves evidence a run that did not, does not: `node tools/report.mjs <run-dir>` prints a **Delegated to an agent worker** section, and the run directory contains `delegation/`. If neither appears, the run went through the model path regardless of what the variable says.

**Confirming reachability before a real run.** The offline check cannot see entitlement (403), region (404) or credential liveness (401); all three surface at the first delegated packet, after the premium phases are billed. One trivial delegation settles them, for about two cents:

```bash
node plugin/scripts/probe-agent-worker.mjs
```

## Per-project policy pick

The console (`plugin/policy-console/`, opened by `plugin/scripts/setup-policy.mjs`) shows the shipped presets with the agy driver pin on every card. Picking one, or saving a customized copy, writes `default_policy` to `<project>/.sdlc/project.json`; the skills and the headless driver read it.

| Preset | Use |
|---|---|
| `antigravity-flash38-plus-opus5` | The study policy. Gemini 3.8 Flash conducts; Opus 5 at high effort on judgment phases; Flash on mechanical. Cap $50 |

The Claude harness's `opus-*` / `flash-*` presets are not shipped here; they live under `plugin/mcp/model-dispatch/test/fixtures/policies/` as routing-engine test fixtures.

Scripted: `node tools/setup.mjs --policy=<name>`, or `node plugin/scripts/setup-policy.mjs --policy=<name> --project-root <project>`. In a session, `/mmo:policy` shows the active policy and `/mmo:policy change` reopens the console.

## Install from the clone

```bash
git clone --branch main https://github.com/tl-ai-labs/ai-sdlc-orchestrator-antigravity-harness.git
cd ai-sdlc-orchestrator-antigravity-harness
npm ci && npm run build && npm test
node tools/setup.mjs --project-root /path/to/your/project
```

`npm test` is offline and free. `npm run build` compiles the bridge under `plugin/mcp/model-dispatch/dist/`, which is gitignored and must be rebuilt after every pull that touches the bridge. The wizard's `--yes` takes every default, `--policy=<name>` skips the browser, `--no-agent` skips the door question.

## Before any paid run

1. `npm test` passes and `npm run verify` is green.
2. The headless checks in [verification/p1-agy-runtime.md](verification/p1-agy-runtime.md) (2, 4, 6, 10) pass — recorded 2026-09-17 on agy 1.2.5.
3. `preflight_dispatch` with `auth_mode: vendor` reports `ok: true` for the policy, and its models and rates are read back to you.
4. The pricing blocks in the policy match `plugin/mcp/model-dispatch/src/prices.ts` (`prices.test.mjs` enforces it).
5. An explicit go from the study owner.

First paid run: `examples/quick-demo/brief.md` under `antigravity-flash38-plus-opus5`.
