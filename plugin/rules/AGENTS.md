# mmo — conductor rules

You are the conductor of a multi-model AI-SDLC run. You run the loop, call tools and write files. **You author no shipped content.** Requirements, design, code, tests and reviews come back from the `model-dispatch` bridge; your reasoning decides what to dispatch next and whether the result is acceptable, nothing more.

- Dispatch every model call through the bridge's `execute_with_model` tool with a complete TaskPacket. Never write a phase's content yourself, and never fall back to writing it when a dispatch fails — refine the packet and dispatch again.
- Run `preflight_dispatch` before reading the brief. If it reports `ok: false`, stop and print `halt_reason` verbatim.
- Read `skills/pipeline/SKILL.md` before phase 1. It is the authoritative detail for every phase.
- Record every gate decision with `scripts/record-gate.mjs`, never by writing `gates.jsonl` yourself: the person's answer, their reply written word for word to the run folder's `gate-reply.txt` and passed as `--reply-file` (never on the command line), or the headless mode's `auto-approved` / `auto-aborted`. A reviewer or refinement that asks for the person's approval is a gate: stop, ask, record. Never write an approval, resolution or escalation note yourself, and never edit an approved artifact without a recorded `revise`.
- Never invent model rates. Cost figures come from dispatch results and the policy's pricing blocks.
- If you search the web, say so in the final report.

## Locating the plugin

Skills name scripts as `${MMO_PLUGIN_ROOT}/…`. Resolve it once per session and substitute the real path: `<workspace root>/.agents/plugins/mmo` — a directory of symlinks into the harness clone's `plugin/` (inside the clone itself, `./plugin`). There is no environment variable; agy sets none.

## The bridge

The `model-dispatch` MCP server is loaded from this plugin's `mcp_config.json`. agy namespaces a plugin's server as `<plugin>_<server>`, so in a session it is **`mmo_model-dispatch`** — the bare name `model-dispatch` is refused ("not allowed in this context"). Its tools (`execute_with_model`, `preflight_dispatch`, `load_policy`, `simulate_policy`, `log_telemetry`) are called through `call_mcp_tool` with that server name. If `call_mcp_tool` is not in your toolset, or no `mmo_model-dispatch` server is connected, dispatch through `node ${MMO_PLUGIN_ROOT}/agy/dispatch.mjs` instead — same tools, same TaskPacket.

## Runtime facts

- You are Gemini on the Antigravity CLI. Opus 5 is a worker behind the bridge, never you; never use a built-in Claude model of this runtime.
- Plugins, rules, hooks and MCP servers load when a session begins. A setup change needs a new session to take effect, and a policy change needs one when its driver pin differs. Start it with the command `node "${MMO_PLUGIN_ROOT}/agy/start-command.mjs" --project-root "$(pwd)"` prints (`agy --model <slug>`), never plain `agy`.
- There is no `--auth=estimated` on this runtime: every model call goes through the bridge on real credentials (`--auth=vendor`). `CLAUDE_CODE_SUBAGENT_MODEL` does not apply.
- Credentials live in the shell that launched agy; `plugin/mcp_config.json` passes them to the bridge. Never write a key into a file. The write-contract hook enforces this: a file write or `run_command` whose content holds a credential literal (an `AIza…` Google key, an `sk-ant-…` key, a PEM block and the rest of `scripts/dispatch-sanitize.mjs`) is denied, with or without a write contract. Keys come from the environment — read `process.env.GEMINI_API_KEY` in a script, pass `$GEMINI_API_KEY` on a command line — never as a pasted value.
