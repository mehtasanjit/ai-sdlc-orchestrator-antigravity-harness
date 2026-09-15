# INSTALL.md

Steps to get this harness from a clone to a plugin that agy discovers. Written so an agent can follow them; every command is literal.

## 1. Prerequisites

| Need | Check | Get |
|---|---|---|
| Node.js ≥ 20 | `node --version` | https://nodejs.org |
| Antigravity CLI `agy` 1.2.3 | `agy --version` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` → `~/.local/bin/agy` |
| Google Sign-In for agy | `agy models` lists models | run `agy` once with no arguments and finish the browser flow |
| Claude Code (for the Opus worker) | `claude --version` | https://code.claude.com/docs — the `claude-cli` adapter spawns `claude -p` |

## 2. Build the bridge

```bash
npm ci
npm run build
```

`npm run build` installs and compiles `plugin/mcp/model-dispatch` into `dist/`, which `plugin/mcp_config.json` points at. `dist/` is gitignored; rebuild after every pull that touches the bridge.

## 3. Credentials

Export in the shell that launches agy. The bridge inherits them through `plugin/mcp_config.json` (`${VAR}` — see check 5 in `docs/verification/p1-agy-runtime.md` for the fallback if agy does not interpolate).

| Arm | Variables |
|---|---|
| A — Anthropic key | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` |
| B — Vertex | `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID=<gcp-project>`, `CLOUD_ML_REGION=global`, plus ADC (`GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth application-default login`) |

Arm B needs Claude enabled in Model Garden on the project. See [SETUP.md](SETUP.md).

## 4. Discover the plugin

Open agy in the repo root. `.agents/plugins.json` registers `plugin/` as a plugin named `mmo`; `/plugins` in the session lists it, `/mcp` shows `model-dispatch` connected, `/skills` lists `greenfield`, `pass`, `brownfield` and the rest.

Do not run `agy plugin install` or `agy plugin import` on this repo: both copy the plugin into `~/.gemini/config/plugins/`, and the standing rules keep everything in the repo.

## 5. Verify

```bash
npm test
```

Offline and free. Then, inside an agy session in the repo, call the bridge's `load_policy` tool with `policy_name: antigravity-flash38-plus-haiku45` — it makes no vendor call and proves the MCP path.
