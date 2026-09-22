# INSTALL.md

Steps from "Set up this plugin from this repo" to a project in which `agy` discovers the `mmo` plugin. Written so an agent can follow them; every command is literal. The folder you started `agy` in is **the project**; the harness is cloned beside it.

## 1. Prerequisites

| Need | Check | Get |
|---|---|---|
| Node.js ≥ 20 | `node --version` | https://nodejs.org |
| Antigravity CLI `agy` ≥ 1.2.3 | `agy --version` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` → `~/.local/bin/agy`; open a new shell |
| Google Sign-In for agy | `agy models` lists models | run `agy` once with no arguments and finish the browser flow. A person does this; do not attempt it headlessly |
| Claude Code (the Opus worker) | `claude --version` | https://code.claude.com/docs — the `claude-cli` adapter spawns `claude -p` |
| git | `git --version` | — |

## 2. Clone the harness beside the project

```bash
git clone --branch feat/antigravity-harness-implementation https://github.com/tl-ai-labs/ai-sdlc-orchestrator-antigravity-harness.git ../ai-sdlc-orchestrator-antigravity-harness
```

If `../ai-sdlc-orchestrator-antigravity-harness` already exists, switch it to the branch and update it instead:

```bash
git -C ../ai-sdlc-orchestrator-antigravity-harness fetch origin
git -C ../ai-sdlc-orchestrator-antigravity-harness checkout feat/antigravity-harness-implementation
git -C ../ai-sdlc-orchestrator-antigravity-harness pull
```

The branch matters until this work is merged to `main`: the wizard in step 3 and the mount step do not exist on `main`. Any location works; the next step records the absolute path.

## 3. Run the wizard against the project

```bash
node ../ai-sdlc-orchestrator-antigravity-harness/tools/setup.mjs --project-root "$(pwd)"
```

It checks Node, `agy`, `claude` and credentials; builds `plugin/mcp/model-dispatch/dist/` (`npm ci && npm run build`, gitignored, rebuilt after every pull that touches the bridge); asks about the Gemini agent path only when Vertex ADC exists; mounts the plugin as `<project>/.agents/plugins/mmo/` (symlinks into the clone); and opens the policy console to pick `.sdlc/project.json` → `default_policy`. The console opens on every run from a terminal — including when a default is already set, so you can review or change it; saving nothing there leaves the current value untouched. Pass `--yes` to take every default (it no longer skips the console), `--policy=<name>` to skip the browser, `--no-agent` to skip the door question.

Report the wizard's output to the user as it stands. An item marked ✗ names what is missing and where to set it; do not work around it.

## 4. Credentials

Export in the shell that launches agy. The bridge inherits them through `plugin/mcp_config.json` (`${VAR}`). If check 5 in [docs/verification/p1-agy-runtime.md](docs/verification/p1-agy-runtime.md) finds agy does not expand them, the headless launcher's `--inline-env` is the fallback.

| Arm | Variables |
|---|---|
| A — Anthropic key | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` |
| B — Vertex | `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID=<gcp-project>`, `CLOUD_ML_REGION=global`, plus ADC (`GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth application-default login`) |

Never write a key into a file in either repo. [SETUP.md](SETUP.md) covers the arms, the doors and the pricing preflight.

## 5. What discovery looks like

`<project>/.agents/plugins/mmo/` — a directory whose entries are symlinks into the clone:

```
plugin.json -> /abs/path/to/ai-sdlc-orchestrator-antigravity-harness/plugin/plugin.json
mcp_config.json, hooks.json, skills/, rules/, mcp/, agy/, config/, scripts/, … likewise
```

agy scans `.agents/plugins/` in a **trusted** workspace and loads `mmo`: its `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/AGENTS.md` and `skills/*` (as `mmo:<name>`). Inside the harness clone itself the committed mount uses relative links. The declared route (`.agents/plugins.json`) did not resolve on agy 1.2.5 and is not used ([docs/verification/p1-agy-runtime.md](docs/verification/p1-agy-runtime.md), check 10).

Two things that silently leave the plugin unloaded: an **untrusted** workspace (agy asks on first open; the stored path must match the folder's spelling exactly), and **print mode** — `agy -p` loads no workspace customization at all, which is why headless runs go through `plugin/agy/run.mjs` and its dispatch script rather than the MCP server.

Do not run `agy plugin install` or `agy plugin import` on this repo: both copy the plugin into `~/.gemini/config/plugins/`, and the standing rules keep everything in the repo.

## 6. Hand over

Tell the user to start a **new** `agy` session in the project — plugins, rules, hooks and MCP servers load when a session begins — answer **yes** to the trust prompt, and then run `/mmo:greenfield` (empty folder + brief) or `/mmo:brownfield` (existing repo). In that session `/skills` lists the `mmo:` entry points.

## 7. Verify later

```bash
cd ../ai-sdlc-orchestrator-antigravity-harness
npm test          # offline, free: 120+ root tests and the bridge suite
npm run verify    # the same checks as the wizard, no questions
```

A headless dry run prints the pinned `agy` invocation with credentials reported as set/unset only:

```bash
node plugin/agy/run.mjs --brief=examples/quick-demo/brief.md --project-root=/path/to/project --output-dir=/path/to/project/.sdlc --gates=auto-approve --dry-run
```

[docs/running.md](docs/running.md) covers the flags and the run directory.
