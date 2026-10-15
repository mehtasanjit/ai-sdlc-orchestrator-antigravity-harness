# SETUP.md

The shepherd's manual for setup, and the reference for credentials, the two Claude arms, the Gemini doors and the pricing preflight. [INSTALL.md](INSTALL.md) is the literal command sequence; this file says what each step means and what to tell the user.

## 1. What setup produces

| Where | What | Written by |
|---|---|---|
| `<harness>/plugin/mcp/model-dispatch/dist/` | The compiled bridge `plugin/mcp_config.json` points at | `npm run build` |
| `<project>/.agents/plugins/mmo/` | Symlinks into the clone's `plugin/`, which is how agy discovers the plugin in a trusted workspace | `tools/setup.mjs` |
| `<project>/.sdlc/project.json` | `default_policy`, the off-limits defaults | `plugin/scripts/setup-policy.mjs` (the policy console) |
| `<project>/.sdlc/local/mmo-select.json` | `MMO_SELECT` when the agent path is chosen | `tools/setup.mjs --agent` |

Nothing under `~/.gemini/` or `~/.claude/` is written. There is no global install.

## 2. Reading the wizard's result

`node tools/setup.mjs --project-root <project>` prints eight numbered steps. Relay them as they stand:

| Mark | Meaning | What to do |
|---|---|---|
| ✓ | Done or already true | Nothing |
| ! | Advisory — a run works, with a limit named | Say what the limit is |
| ✗ | Blocking — a run would halt at preflight or the first dispatch | Name the variable or tool and where it goes; do not try to fix credentials yourself |

`npm run verify -- --project-root=<project>` runs the same checks with no questions and ends with the project's start command; `--fix` builds the bridge. Without `--project-root` it checks the harness clone, not a project, and prints no start command.

## 3. The Claude wallets — two arms and the seat

Every wallet runs the same policy file and the same `claude-agent-sdk` adapter (the Claude Agent SDK, in-process). The wallet is the environment the bridge is launched with — the shell that starts `agy` — or, with nothing exported, Claude Code's own sign-in.

| | Arm A | Arm B | Seat |
|---|---|---|---|
| Wallet | Anthropic API key | GCP project, Google's invoice, Google's published Claude rates | A claude.ai subscription (Pro / Max) that Claude Code is signed in to |
| Env | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_USE_VERTEX=1` `ANTHROPIC_VERTEX_PROJECT_ID` `CLOUD_ML_REGION=global` + ADC | nothing — `claude auth status` shows `authMethod: claude.ai` |
| Cost of record | the SDK result's `modelUsage` priced from the dated price list (Anthropic card) — cash | tokens from the same result × the Vertex Claude card; the GCP invoice is the receipt — cash | tokens priced at the Anthropic card — **modeled**; no invoice exists |
| Gate | key present | project active, Claude enabled in Model Garden (24–48 h approval), `roles/aiplatform.user`, quota in region | signed in once with `claude` |
| Study use | yes | yes | wiring and development runs; a study cost of record on it needs the owner's sign-off |

A key or the Vertex variables win over the seat when both are present. Arm A and arm B set at once is refused by `verify` and by the wizard: the run record could not say which wallet paid. `manifest.json` records the wallet as `harness.arm` (`A`, `B` or `seat`) and, on the seat, moves the Claude line out of `cost.dispatched_cash_usd` into `cost.claude_seat_modeled_usd`.

Re-test arm B with `claude -p --model claude-opus-5 'say ok'` under the arm-B env (the CLI and the SDK read the same environment, so this still probes the arm). A `403` names the project state; a `404 model not found` means Model Garden has not enabled Claude yet.

## 4. Gemini doors

| Door | Adapter | Credential | When |
|---|---|---|---|
| `flash-completion` | `mcp:model-dispatch` | `GEMINI_API_KEY`, or Vertex ADC when unset | The default. One completion call per packet |
| `flash-agsdk-worker` | `antigravity-worker` | Vertex ADC only | An Antigravity SDK session with tools; reads and edits the workspace itself. Needs Python 3.10+ |

The wizard offers the agent path only when a usable Vertex ADC exists; `--agent` / `--no-agent` pre-answer it. The choice lands in `.sdlc/local/mmo-select.json` (read by the dispatch fallback) and must also be exported as `MMO_SELECT=gemini-flash=flash-agsdk-worker` in the shell that launches agy for the MCP route. Pin the door in the run record. While the GCP project is suspended only `flash-completion` on `GEMINI_API_KEY` runs.

## 5. Choosing the policy

The console (`plugin/policy-console/`, opened by `plugin/scripts/setup-policy.mjs`) shows the shipped presets with the agy driver pin on every card. Picking one, or saving a customized copy (written to `plugin/config/policies/<name>.yaml`), writes `default_policy` to `<project>/.sdlc/project.json`; the skills and the headless launcher read it.

Every entry point resolves the policy in one order, the bridge's:

| Order | Source | Note |
|---|---|---|
| 1 | `<project>/routing-policy.yaml` | The bridge always routes by it when present; `run.mjs` warns if `--policy` names another |
| 2 | `--policy=<name>` | A preset or a console-saved policy under `plugin/config/policies/` |
| 3 | `<project>/.sdlc/project.json` → `default_policy` | Setup's choice |
| 4 | `antigravity-flash38-plus-opus5` | The shipped default |

`run.mjs` takes the driver pin, the driver's price and the cost cap from that one file, refuses a policy with no `driver:` block (a headless run cannot start without the pin), and validates the file with the bridge's own loader before agy starts, so a misspelt adapter id fails at launch rather than at the first paid dispatch. `driver-manifest.json` records `policy_source`.

`tools/setup.mjs` opens the console on every run that has a terminal attached, whether or not `default_policy` is already set — close the browser or press Ctrl-C to keep the current value. Two ways to bypass it: `--policy=<name>` writes the name directly, and a run with no TTY (CI, piped stdin) skips the console and warns that the launcher will fall back to `antigravity-flash38-plus-opus5`.

| Preset | Use |
|---|---|
| `antigravity-flash38-plus-opus5` | The study policy. Gemini 3.8 Flash conducts; Opus 5 at high effort on judgment phases; Flash on mechanical. Cap $50 |
| (nothing else) | The Claude harness's `opus-*` / `flash-*` presets are not shipped here; they live under `plugin/mcp/model-dispatch/test/fixtures/policies/` as routing-engine test fixtures. This harness runs Gemini 3.8 Flash and Claude Opus 5, nothing else |

Scripted: `node tools/setup.mjs --policy=<name>`, or `node plugin/scripts/setup-policy.mjs --policy=<name> --project-root <project>`.

## 6. Driver billing

The conductor runs on your Google seat by default: no invoice exists, so its cost line is **modeled** from agy's `usage` counters at the driver block's card and labeled so in `driver-cost-modeled.jsonl` and `manifest.json`. A metered driver (`modelProvider: "gemini"` + `GEMINI_API_KEY`) requires editing `~/.gemini/antigravity-cli/settings.json`, which the standing rules exclude; if a study needs it, record the decision in the run manifest (`billing_mode: gemini-api-key` in the policy's `driver:` block).

## 7. Hand over

Setup ends by telling the user to start a **new** `agy` session in the project with the `agy --model …` command the wizard prints after "Setup complete", and to answer **yes** to the trust prompt. Plugins, rules, hooks and MCP servers load when a session begins, only in a trusted workspace; the setup session has none of them. Then `/mmo:greenfield` or `/mmo:brownfield`.

| Policy | Start command |
|---|---|
| `antigravity-flash38-plus-opus5` (the default) | `agy --model gemini-3.8-flash-high` |
| Any other | `node plugin/agy/start-command.mjs --project-root <project>` prints it: the slug from the policy's `driver:` block, derived the way `run.mjs` derives `--model` |

Tell the user why in one sentence: without `--model` the chat runs on agy's default model, while the run prices the conductor at the pin's rates and checks the model it ran on against the pin's model, so the model check fails (`pin.unverified_reason: model_mismatch`). agy's local record names the model, not the effort, so a chat started at another effort passes that check: give the slug exactly as printed.

## 8. Before any paid run

1. `npm test` passes and `npm run verify` is green.
2. The headless checks in [docs/verification/p1-agy-runtime.md](docs/verification/p1-agy-runtime.md) (2, 4, 6, 10) pass — recorded 2026-09-17 on agy 1.2.5.
3. `preflight_dispatch` with `auth_mode: vendor` reports `ok: true` for the policy, and its models and rates are read back to the user.
4. The pricing blocks in the policy match `plugin/mcp/model-dispatch/src/prices.ts` (`prices.test.mjs` enforces it).
5. An explicit go from the study owner.

First paid run: `examples/quick-demo/brief.md` under `antigravity-flash38-plus-opus5`.

## Brownfield addendum

Brownfield runs add a write contract: `<project>/.sdlc/local/write-contract.json`, confirmed at Gate 0, enforced by the `PreToolUse` hook in `plugin/hooks.json` (`plugin/agy/hooks/write-contract-check.mjs`). A refused write names the path and the rule; the decision is recorded in `.sdlc/local/guard-decisions.jsonl`. `npm run verify -- --brownfield-check` runs the brownfield prerequisites (Node, git ≥ 2.30, `.sdlc/` writable, skill-name conflicts).
