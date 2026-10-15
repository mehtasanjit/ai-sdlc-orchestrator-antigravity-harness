# P1 — Antigravity CLI runtime verification

> **For:** the numbered live checks every pin in `plugin/agy/` and every policy `driver:` block cites. Historical record — the results stay as recorded. **Also see:** [../running.md](../running.md#the-pin-gate) · [../architecture.md](../architecture.md).

Numbered checks against the real `agy` binary and its bundled documentation, run before the driver
layer is built. Every pin in `plugin/agy/` and every policy driver block cites a check number here.
A check marked **pending** has not been exercised live; nothing may be pinned on it.

Port-plan reference: `ANTIGRAVITY-HARNESS-PORT-PLAN.md` v4 (15 Sep 2026), section 10 P1.

## This machine

| Item | Value |
|---|---|
| `agy` | `1.2.3`, installed 2026-09-15 by `https://antigravity.google/cli/install.sh` to `~/.local/bin/agy` (181 MB Go binary; the installer appended a PATH export to `~/.zshrc`, `~/.zprofile`, `~/.bash_profile`) |
| Antigravity app | `2.0.6` at `/Applications/Antigravity.app` (the IDE; not used by this harness) |
| Claude Code | `2.1.89` (`claude --version`). The plan pins 2.1.270; re-pin after the machine that ran the 15 Sep Vertex one-liner reports its version |
| Node.js | v25.6.1 |
| Platform | macOS 24.6.0 (Darwin), arm64 |
| agy auth | **not signed in** as of the offline checks below. Every live check needs Google Sign-In first (`agy` with no arguments, browser flow). Headless `-p` tries a Playwright-driven sign-in, whose driver download 404s on this machine, then waits 60 s for a pasted code and exits `authentication failed or timed out` |

Sources consulted, in order of authority: the binary's own `--help`, `agy changelog`, and the built-in
skill docs at `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/*.md` (plugins, MCP,
hooks, skills, rules, JSON configs); then `strings` over the binary; then `antigravity.google/docs/cli/*`
(which lists v1.2.0 as current — the binary is ahead of the public page).

## Checks

| # | Check | Result | Confirms |
|---|---|---|---|
| 1 | Can the model in an agy session call the bridge's tools (pattern a), and what is the tool prefix | **SPLIT — 2026-09-17, agy 1.2.5.** Print mode (`agy -p`) loads **no** workspace customization: no plugin, no MCP server, no hook, no skill (`loaded 0 named hooks`, `empty component: prompt section "mcp_servers"`, the model reports no MCP tools) — so on the headless path the answer is *no*, and `run.mjs` uses the dispatch fallback (check 2). Interactive: the plugin loads (check 10) and MCP tools are reached through the generic `call_mcp_tool` tool, not per-tool bindings; **the bridge does start and connect interactively** — agy wrote its tool cache to `~/.gemini/antigravity-cli/mcp/mmo_model-dispatch/{execute_with_model,preflight_dispatch,load_policy,simulate_policy,log_telemetry}.json` during two `agy -i` sessions on 2026-09-17, so the server name is the namespaced **`mmo_model-dispatch`** (changelog 1.2.2 `<plugin>_<server>`); a subagent asking for the bare `model-dispatch` was refused *"server model-dispatch is not allowed in this context"*. What is still **pending** is a call that returns: in both `-i` sessions the main agent's toolset had no `call_mcp_tool` and no MCP tools at the moment the prompt was sent (the model listed its 15 built-in tools), while the tool cache was written seconds later — so either the server connects after the first turn's toolset is fixed, or MCP tools are only reachable from a subagent with `enable_mcp_tools`. Settle it with the pause-first prompt in "How to run the pending checks" | Driver-layer pattern (a) vs (b): **(b) headless, (a) interactive** |
| 2 | Does the bridge subprocess survive without `--sandbox` | **PASS — 2026-09-17, agy 1.2.5.** `dispatch.mjs --preflight` run by the model's `run_command` from a print-mode session reached the bridge and wrote the preflight result, both with the default (no `--sandbox`) **and with `--sandbox`**: agy's terminal sandbox does not kill a piped child, unlike Codex's. `run.mjs` still passes no `--sandbox` | Bridge connectivity on the headless path |
| 3 | Are imported agents' `tools:` lists ignored or rejected | **MOOT — 2026-09-17.** agy's plugin format has no agents component (`plugins.md`: skills, rules, hooks, MCP), and `agy plugin validate` on the mount reports `agents: skipped (not found)`. The role prompts therefore port as content, the Codex way: `plugin/skills/pipeline/roles/{architect,senior-reviewer,security-reviewer}.md` are the `instruction` body of their phase's bridge dispatch, and `plugin/skills/brownfield-guide/discovery.md` is the conductor's own local read. `plugin/agents/` is gone; no frontmatter `tools:` list reaches agy | Role prompts port as content |
| 4 | Does `--print "/pass …"` reach the imported skill, and under what slash name | **PASS — 2026-09-17, agy 1.2.5.** Interactive `/skills` lists the plugin's skills as `mmo:<name>` — `/mmo:greenfield`, `/mmo:brownfield`, `/mmo:pass`, `/mmo:policy` … — so the Claude harness's vocabulary is the live one. Print mode expands **no** workspace skill (`agy -p "/mmo:policy"` made the model search the web for the phrase), so the headless entry is the conductor prompt `run.mjs` renders, never a slash command | Skill invocation form |
| 5 | `${VAR}` interpolation in `mcp_config.json` | **Not on the headless path — pending interactive.** Headless, `dispatch.mjs` spawns the bridge itself and it inherits the launching shell's environment directly, so no interpolation is involved. Interactive, the plugin's `mcp_config.json` is what launches the server; whether `${GEMINI_API_KEY}` expands there is the same one-line interactive test as check 1 | Secrets stay out of the committed config |
| 6 | `--gates=auto-approve` under agy | **PASS — 2026-09-17, agy 1.2.5.** Without `--dangerously-skip-permissions`, `run_command` failed `permission check failed for command …` and stderr said: *a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json … Alternatively, re-run with --dangerously-skip-permissions*. `run.mjs` passes it | Headless run shape |
| 7 | Opus effort through `claude -p` | **PASS — offline.** `claude --help` on 2.1.89 lists `--effort <level>` ("low, medium, high, max"). `ClaudeCliAdapter.runClaudeCli` spawns `claude -p --model <name> --output-format json` with no effort flag and no `env` override (inherits the bridge's environment — the arm-A/arm-B mechanism the plan relies on). P3 adds it: `claudeCliArgs()` in `ClaudeCliAdapter.ts` appends `--effort <policy reasoning.effort>` when the model entry carries one (`claudeCliAdapter.test.mjs`); Haiku 4.5 rejects the effort parameter, so the wiring-proof policy carries none | Opus thinking-matched to the Claude Code runs |
| 8 | Is agy `usage` cumulative | **PASS — documented; envelope observed 2026-09-16.** `agy -p "say ok" --output-format stream-json` on this signed-out machine printed exactly one line, `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}` — so the event key is `event` (not `type`), the envelope sits under `result`, and the five usage counters are as documented. `plugin/agy/telemetry/event-reader.mjs` parses that shape and differences consecutive results of one conversation. `antigravity.google/docs/cli/headless`: "Token usage counters cumulative per session; response text per-turn". The `json` envelope carries `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}` (observed verbatim in the auth-failure envelope this machine printed). `stream-json` emits `init`, `step_update`, `result`; the `result` event matches the envelope. The event reader must difference consecutive `result.usage` values when a session is kept open with `--input-format stream-json`, and take the single `result` as the total for a one-shot `-p` | Driver cost line |
| 9 | Driver billing mode | **PASS — offline.** Two modes exist. Seat: Google Sign-In, quota on the account, no per-token invoice → the driver line is **modeled**. Metered: `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json` plus `GEMINI_API_KEY` (changelog 1.1.13; binary string: "modelProvider is set to %q in settings.json, but the %s environment variable is not set"). The binary also reads `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI` and an `AGY_ADC_AUTH` switch ("To log out, please run `unset AGY_ADC_AUTH`") — an ADC door for the driver that the plan did not know about; not needed for arm A. Metered mode requires editing a file under `~/.gemini/`, which rule 13 forbids, so seat mode is the default and the only mode the launcher configures nothing for | `billing_mode` in the policy driver block |
| 10 | Plugin discovery from the repo, no global edits | **PASS — 2026-09-17, agy 1.2.5, interactive.** Two preconditions found live: (a) the workspace must be **trusted** under the exact path spelling — `~/.gemini/antigravity-cli/settings.json` held `…/Documents/Github/…` while agy resolves `…/Documents/GitHub/…`, and nothing under `.agents/` loaded until agy re-asked and the correct spelling was accepted; (b) the **declared** route `.agents/plugins.json` → `{path: ".", include_only: ["^plugin$"]}` did **not** resolve, while a plugin directory `.agents/plugins/mmo/` did: `/skills` listed `mmo:*` and the log read `loaded 2 named hooks from 1 hooks.json file(s)`. The repo therefore commits `.agents/plugins/mmo/` as relative symlinks into `plugin/`, and `tools/setup.mjs` builds the same mount in a project with absolute links. Print mode loads none of it (check 1) | Definition of done 1 |
| 11 | `agy plugin import` on the mmo 0.7.3 plugin | **PASS — offline, 2026-09-15.** `agy plugin import ai-sdlc-orchestrator-claude-code-harness/plugin` → `skills: 2 processed · agents: 5 processed · commands: 13 processed (converted to skills) · mcpServers: skipped (not found) · hooks: 1 processed`, staged to `~/.gemini/config/plugins/mmo` (then uninstalled). The staged `hooks.json` is the Claude file byte-for-byte (`{"hooks":{"PreToolUse":[{"matcher":"Write\|Edit", … "${CLAUDE_PLUGIN_ROOT}/…"}]}}`), which is not agy's format (`hooks.md`: top-level keys are hook names, handlers run with cwd = the directory containing `hooks.json`, payload keys camelCase, PreToolUse replies `{"decision": "allow\|deny\|ask\|force_ask"}`). So the plan's "only the MCP server config is hand-written" undercounts by one: `hooks.json` is hand-written too | What the import does and does not convert |
| 12 | Plugin MCP server working directory | **PASS — documented.** Changelog 1.2.0: plugin MCP servers "now resolve against the plugin's own directory so plugin-bundled scripts run correctly". `plugin/mcp_config.json` therefore uses the relative `args: ["mcp/model-dispatch/dist/server.js"]` and no `${PLUGIN_ROOT}`-style variable | `mcp_config.json` shape |
| 13 | Hook events and tool names | **PASS — documented.** Events: `PreToolUse`, `PostToolUse` (grouped, regex `matcher` on tool name), `PreInvocation`, `PostInvocation`, `Stop` (flat). No `SessionStart` / `UserPromptSubmit`. Tool names are lowercased step types; the binary's step types include `run_command`, `view_file`, `grep_search`, `list_directory`, `mcp_tool`, `code_action`, `propose_code`, `file_change`, `write_blob`, `invoke_subagent`, `finish`. Which of `code_action` / `propose_code` / `file_change` fires for a file write in the CLI is a live check (matcher `"*"` hook that logs `toolCall.name`); the write-contract shim is not pinned until then | Hook shim design |
| 14 | Model slugs | **PASS — live list recorded 2026-10-13, agy 1.3.0, seat (`agy models`):** `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, the same three for `gemini-3.7-flash` and `gemini-3.6-flash`, `gemini-3.1-pro-low`, `gemini-3.1-pro-high`; no Claude or GPT slug is offered on the seat. The pinned slug `gemini-3.8-flash-high` is on the list. A `--print` run with `--model gemini-3.8-flash-high` names that slug in its `init` event (`init.model`), and the conversation's local record (check 18) names `gemini-3.8-flash`, so the pin is verified from what agy reports (`pinVerification`, both checks 16 and 17's runs). Earlier, from binary strings: `gemini-3.8-flash`, `gemini-3.8-flash-medium`, "Gemini 3.8 Flash (High)", `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`, `gemini-3.1-flash-lite`, `gpt-oss-120b-maas`, `gpt-oss-20b-maas`, `claude-sonnet-`… Effort is baked into the slug (`--model gemini-3.8-flash-high`) and `--effort low\|medium\|high` is a separate session override (`--help`). The plan's section 8 passes both; the launcher passes the slug only, derived from the driver block, so the pin lives in one place | Driver pin form |
| 15 | Built-in Claude on agy | **PASS — binary strings + public docs.** Opus 4.6 / Sonnet 4.6 only, Google-seat routed, no cost figures, no provider control for them. Never used by this harness (rule 13) | Opus 5 is a bridge worker, never agy's model |
| 16 | Do `usage` counters carry over when `run.mjs` resumes a conversation in a new process (`agy --print --conversation <id>`) | **PASS — recorded 2026-10-13, agy 1.3.0, seat, `tools/p1/live-checks.sh 16`: counters are cumulative across a resume.** First call (about 300 words): `status: "SUCCESS"`, conversation `e3a29ee2-1763-40b0-98d6-bdaf628791a6`, `usage` `{input_tokens: 15686, output_tokens: 1128, thinking_tokens: 793, cache_read_tokens: 0, total_tokens: 16814}`. Resume in a new `--print --conversation` process (reply `ok`): `status: "SUCCESS"`, same conversation, `usage` `{input_tokens: 32734, output_tokens: 1153, thinking_tokens: 817, cache_read_tokens: 0, total_tokens: 33887}`. The resume's 1,153 output tokens are the first call's 1,128 plus 25, so a resumed process reports the conversation's running total. `RESUME_USAGE.state` is `"cumulative"`: `event-reader.mjs` differences consecutive results of one conversation across processes, and a resumed run's driver line is one figure. agy 1.3.0 reports `SUCCESS` where earlier builds reported `OK`; `check16.mjs` accepts both | Resumed runs' driver line: one figure instead of a range |
| 17 | How agy's `usage` counters nest: does `input_tokens` hold `cache_read_tokens`, and does `output_tokens` hold `thinking_tokens` | **PASS — recorded 2026-10-13, agy 1.3.0, seat: `cache-outside-total+thinking-in-output`.** A read-only `--print` run that read four files one at a time (five model calls, conversation `57809ecf-83fb-44a5-b2b2-794464ba1e8a`) reported `usage` `{input_tokens: 50394, output_tokens: 2649, thinking_tokens: 2002, cache_read_tokens: 114232, total_tokens: 53043}`. `total_tokens` is `input_tokens` + `output_tokens`, so the cache reads are outside the total; they exceed `input_tokens`, so they are not inside it either; and `output_tokens` holds `thinking_tokens`, as check 16's two results also showed. None of the four readings the reader knew before fit this result, so it would have booked the dearest one, adding the thinking a second time. `tokenLayouts.mjs` now carries the two `cache-outside-total` readings, and a result with cache reads and thinking fits exactly the recorded one. The conversation's local record (check 18) sums to the same five counters: fresh 50,394, cache 114,232, output 2,649, thinking 2,002 | Which layout a real run books; whether `results_with_unproven_reading` can appear on a real run |
| 18 | Does agy's local conversation record hold the driver's usage, for an interactive run | **PASS — read 2026-10-13, agy 1.3.0, offline from the record on this machine.** Each conversation is a SQLite database `~/.gemini/antigravity-cli/conversations/<conversation-id>.db`; table `gen_metadata` holds one protobuf per model call. Field `.1.19` is the model (`gemini-3.8-flash`); `.1.17.2` is the call's usage: `2` fresh input, `5` cache reads (on top of field 2: a call reported 2,882 fresh beside 11,238 cached), `3` output, `9` thinking, `10` text. In all 1,043 calls of one 2,112-step conversation `3 = 9 + 10`, and the values rise and fall per row, so a row is one call, not a running total. `.1.20` (key/value pairs) carries `last_step_index`, and table `steps` dates each step (`.1.1`, epoch seconds): 1,038 of 1,043 calls dated directly, the rest from the neighbouring call. `conversation_summaries.db` names each conversation's `workspace_uris`. Read by field number: agy publishes no schema. `plugin/agy/telemetry/conversationUsage.mjs` pins the map (`LOCAL_RECORD_FIELDS.verified_on`) and refuses a record whose rows break `3 = 9 + 10` Cross-checked 2026-10-13 against a headless run: the record of check 16's conversation `e3a29ee2-…` holds two `gen_metadata` rows, (fresh 15,686, cache 0, output 1,128 = 793 thinking + 335 text) and (fresh 17,048, cache 0, output 25 = 24 + 1), both `gemini-3.8-flash`. They sum to 32,734 input, 1,153 output and 817 thinking, exactly agy's own cumulative `usage` on the resume. Check 17's cache-reading run proves the cache field the same way: its record's five rows sum to 50,394 fresh, 114,232 cache, 2,649 output and 2,002 thinking, agy's own `usage` exactly. Every field the collector reads is now proven against agy's own count | Interactive driver line (`plugin/agy/collect-driver-usage.mjs`); the headless cross-check `driver_usage.local_record` |
| 19 | Does an interactive chat started with `agy --model <slug>` conduct on that slug | **PASS — 2026-10-15, agy 1.3.5, seat.** A chat started with `agy --model gemini-3.8-flash-high` conducts on that slug: the brownfield run `20261015-113821-bugfix-login-password`, conversation `f70d8c75-df7e-49ab-8da8-7d558a6159b5`, read by `collect-driver-usage.mjs` from the local record (check 18), holds 233 calls in the run's window, every one naming `gemini-3.8-flash` (`driver-collector.json` → `reported_models: ["gemini-3.8-flash"]`, no `model_mismatch`), and its manifest recorded `pin.verified: true` with the driver line priced at the `gemini-3.8-flash` card. The whole conversation, decoded row by row, holds 260 calls, all `gemini-3.8-flash`. `check-driver-pin.mjs` read the chat's first 6 calls on the pin and passed before anything was dispatched. The other half, 2026-10-14: a chat started with plain `agy` conducts on agy's default model, the brownfield run `20261014-154942-bugfix-login-500`, conversation `4e7395bd-af8d-4497-b616-77fe91627f63`, 104 calls, every one `gemini-4-argon`, `pin.verified: false`, `model_mismatch`. The local record names the model, never the effort: field `.1.19` reads `gemini-3.8-flash` on `-high` runs, so this check cannot see a chat started at another effort | The interactive start command (`plugin/agy/start-command.mjs`, setup's hand-over) |

## Findings that change the plan

1. **`--dangerously-skip-permissions` is mandatory for a headless run** (check 6). `--gates=auto-approve` alone leaves every `run_command` and MCP call soft-denied.
2. **The driver pin is a top-level `driver:` block in the policy**, not a `models[]` entry with a pseudo-adapter (`preflight.ts::assessModels` builds an adapter for every model and, under `--auth=vendor`, every one is required). Codex could put its pin on `models[].id = gpt` only because GPT was also its judgment worker.
3. **`hooks.json` is hand-written**, not imported (check 11).
4. **Slash names were expected to differ from Claude Code's** — they do not (check 4): interactive `/skills` lists the plugin's skills as `/mmo:<name>`, so the `/mmo:*` references in `plugin/skills/**` stand. What did change in the re-word is the mechanism: the playbooks describe the conductor (dispatch every phase, author nothing), never a subagent or a direct tier (check 3).
5. **`agy mcp add` is not the interpolation fallback** (check 5): it edits the user-level config.
6. **Model slug carries the effort** (check 14): pass `--model gemini-3.8-flash-high`, not `--model … --effort high`.
7. **A metered driver means editing `~/.gemini/antigravity-cli/settings.json`** (check 9). Seat mode is the default; a metered study needs Ravi's sign-off on that one global edit, recorded in the run's manifest.

## Findings from the live checks (2026-09-17, agy 1.2.5)

8. **Print mode is plugin-less.** `agy -p` loads no workspace customization — no plugin, MCP server, hook or skill. Every measured run therefore dispatches through `plugin/agy/dispatch.mjs` (pattern b), and the write-contract hook does not fire on a headless run (greenfield needs none; a headless brownfield run has no guard — say so in its record).
9. **Trust is a hard gate, and it compares strings.** An untrusted workspace, or one trusted under a differently-cased path, loads nothing and says nothing.
10. **`.agents/plugins.json` did not resolve; `.agents/plugins/<name>/` did.** The repo mounts the plugin that way.
11. **Interactive MCP tools go through `call_mcp_tool`, on the namespaced server `mmo_model-dispatch`.** There is no per-tool binding; the conductor rules name the server and tool. Whether the main agent or only a subagent holds `call_mcp_tool` is the open half of check 1.
12. **The sandbox does not kill the bridge.** Codex's finding does not carry over.

## Re-check on agy 1.3.5 (2026-10-14)

agy `1.3.5` at `/opt/homebrew/bin/agy`, signed in on the seat (agy's log: `authMethod=gcp`). Every call `--model gemini-3.8-flash-high --dangerously-skip-permissions`, run from the harness repo, outputs under `.sdlc/p1/` (gitignored). No bridge call reached a vendor.

| # | Result on 1.3.5 |
|---|---|
| 1 | **Changed: print mode loads the plugin mount.** agy's own log for the run (`~/.gemini/antigravity-cli/cli.log`, or the file `--log-file` names) reads `loaded 2 named hooks from 1 hooks.json file(s)`, the count `.agents/plugins/mmo/hooks.json` holds (the log does not name them; the probes below show the write hook is one). The model's toolset holds `call_mcp_tool`, and it called `load_policy` on server `mmo_model-dispatch`: the bridge started and answered (conversation `b8b9d30e-81fa-49da-a2bc-ed10a524aecf`). Its first two calls failed with `Policy … not found at /Users/…/AI%20studies%20TL/…`, the clone-path-with-a-space bug that `fileURLToPath` in `policy.ts` fixes. The write hook fires and its refusal holds: a `write_to_file` onto `.sdlc/p1/.env.probe` came back `tool call denied by pre-tool hook: … matches always-off-limits pattern ".env.*"`, the file was not written, and `.sdlc/local/guard-decisions.jsonl` recorded the deny. Under a frozen contract (run `probe1`, allowlist `src/**`, off-limits `secrets/**`) in a separate git project passed with `--add-dir`, `src/ok.txt` was allowed and written and `secrets/no.txt` refused and not written, both logged with `run_id: "probe1"` in that project's decision log. Whether print mode expands `/mmo:*` skills was not re-checked (check 4). |
| 14 | **PASS.** `agy models` lists `gemini-3.8-flash-high`, `-medium`, `-low`, the same for 3.7 and 3.6 Flash, `gemini-3.1-pro-low` and `-high`, and new on this version `gemini-4-argon-high`, `-medium`, `-low`. The pinned slug is listed; `init.model` names it. |
| 16 | **PASS, cumulative.** `tools/p1/live-checks.sh 16`, conversation `442b168f-5c80-46d4-bae5-6734e9049d34`: first call `{input 15593, output 2045, thinking 1658, cache_read 0, total 17638}`, resume `{input 18288, output 2070, thinking 1682, cache_read 15147, total 20358}`. The resume's output is the first call's plus 25. |
| 17 | **PASS, `cache-outside-total+thinking-in-output`.** Check 1's run reported `{input 78818, output 8390, thinking 7171, cache_read 327474, total 87208}`: `total = input + output`, the cache reads exceed `input`, and `readingsThatFit` returns that one reading only. |
| 18 | **PASS.** The local record matches agy's own `usage` exactly: conversation `b8b9d30e-…` 13 calls, fresh 78,818, cache 327,474, output 8,390, thinking 7,171; conversation `442b168f-…` 2 calls, fresh 18,288, cache 15,147, output 2,070, thinking 1,682; both rows name `gemini-3.8-flash`. `LOCAL_RECORD_FIELDS.verified_on` is now `1.3.5`. |

13. **Print mode on 1.3.5 carries the plugin.** A headless run now has the bridge's MCP tools and the write hook. `run.mjs` still routes dispatch through `dispatch.mjs`; the conductor can also reach `execute_with_model` directly. A headless brownfield run is guarded while it runs, and `harness.write_guard.state` reads `hook` when the hook logged a decision naming the run.

## Pins chosen

The headless pin is live-verified: checks 2, 4, 6 and 10 pass, and `LIVE_PIN_CHECKS` in
`plugin/agy/telemetry/fairnessPin.mjs` records exactly those four. `run.mjs` no longer needs
`--allow-unverified-pin`. Checks 1 and 5 concern the interactive MCP route only and gate nothing
headless; their one remaining test is below. The pin: `gemini-3.8-flash`, effort `high`, seat
billing, in the policy's `driver:` block.

## How to run the pending checks

Checks 1 and 5 (interactive MCP route) need an **interactive** `agy` session in the repo root — print
mode loads no plugin, and `agy -i "<prompt>"` sends the prompt before the bridge has connected (both
2026-09-17 attempts). $0: `load_policy` and `preflight_dispatch` make no vendor call.

1. In a shell with `GEMINI_API_KEY=probe-value-123` exported, start a plain `agy` in the repo root.
2. **Wait ~30 seconds** at the `>` prompt (the bridge is a Node process agy spawns; its tools join
   the toolset once it answers `tools/list`), then paste:

```
Using the call_mcp_tool tool, call load_policy on the MCP server named mmo_model-dispatch with {"policy_name":"antigravity-flash38-plus-opus5"} and print the policy name and the model ids it returned. Then call preflight_dispatch on the same server with {"auth_mode":"vendor","policy_name":"antigravity-flash38-plus-opus5"} and print its full JSON result verbatim. If call_mcp_tool is not in your toolset, list every tool you have whose name contains mcp, mmo or dispatch. Do not run any shell command, do not read files, do not create subagents.
```

3. If the main agent still reports no `call_mcp_tool`, ask it once more to do the same through a
   subagent it defines with MCP tools enabled for `mmo_model-dispatch` — that tells us whether the
   interactive route is main-agent or subagent-only.

Pass for check 1: both calls return; record which route answered and the exact server/tool names.
Pass for check 5: the preflight result shows the Gemini door configured (the shell's `GEMINI_API_KEY`
reached the server through `mcp_config.json`); a missing-credential verdict with the key exported
in the shell means `${VAR}` did not expand, and interactive use needs the key set another way.
Neither check gates a headless run.

### Check 16 — usage across a resume

Seat quota only, no cash. From a terminal whose `agy` is signed in, in the repo root:

```bash
tools/p1/live-checks.sh 16
```

The script makes two `--print` calls on the pinned slug: one that writes about 300 words, then a resume of the same conversation that replies `ok`. `tools/p1/check16.mjs` prints each call's exit code, `result.status`, conversation id and `usage`, then a verdict. Both calls must exit 0 with `status: "SUCCESS"` (agy 1.3.0; earlier builds printed `"OK"`); otherwise the verdict is `INVALID` and the run answers nothing. The verdict reads `output_tokens` on the resume:

| Resume `output_tokens` | Reading | Set `RESUME_USAGE.state` to |
|---|---|---|
| At least the first call's `output_tokens` (hundreds) | Counters carry over | `"cumulative"` |
| A handful | Counters restart per process | `"per-invocation"` |

The same run prints a **check 17** verdict: the one layout of `input_tokens`, `cache_read_tokens`, `output_tokens` and `thinking_tokens` that sums to `total_tokens` in both results. A result with no cache reads and no thinking fits every layout and settles nothing; if the verdict is `INCONCLUSIVE` for that reason, run any longer prompt the same way. Record the usage blocks and the layout in the check 17 row.

Record the two usage blocks in the check 16 row, flip the row to **PASS**, and change `RESUME_USAGE.state` in `plugin/agy/telemetry/event-reader.mjs` in the same commit. `tools/test/telemetry.test.mjs` fails if the row and the constant disagree. A real resumed run settles it only one way: a resumed invocation whose `driver_usage.invocations[].cumulative_usage.output_tokens` is below the previous invocation's means the counters restarted. A larger value fits both readings and settles nothing.

### Check 19 — the interactive start command

Seat quota only, no cash. Run the commands in the harness clone except where a `cd` says otherwise.

1. Make an empty run folder before the chat starts; its creation time opens the collector's window:

```bash
mkdir -p /tmp/check19
```

2. In a trusted project folder with the plugin mounted, start the chat on the default policy's slug, send one turn (`say ok`), and quit:

```bash
cd /path/to/your/project && agy --model gemini-3.8-flash-high
```

3. Read agy's local record for that window:

```bash
node plugin/agy/collect-driver-usage.mjs /tmp/check19 --project-root=/path/to/your/project
```

Pass: `/tmp/check19/driver-collector.json` → `reported_models` is `["gemini-3.8-flash"]` and has no `model_mismatch`. Record the conversation id and the call count in the check 19 row and flip it to **PASS**. A `reported_models` that names agy's default model means `--model` does not reach an interactive chat, and the start command needs another route.
