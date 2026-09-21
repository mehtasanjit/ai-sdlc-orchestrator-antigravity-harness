# AGENTS.md

Rules for Antigravity CLI (`agy`) sessions editing this repo. The full contributor guide is [CONTRIBUTING.md](CONTRIBUTING.md); this file states the writing conventions plainly so you don't have to fetch it.

## Writing style — user-facing docs (`README.md`, `docs/*.md`, `CONTRIBUTING.md`)

- **Second person, present tense.** `You configure X in Y.` Never `the user should configure X in Y.`
- **Statement of fact.** No `we explored`, no `as demonstrated by`, no `here's how we proved it`.
- **No AI slop.** Never use: `seamless`, `powerful`, `leverage`, `unlock`, `elegant`, `production-grade`, `battle-tested`, `robust`, `thoughtful`, `graceful`, `as demonstrated`, `in summary`.
- **No throat-clearing intros or trailing summaries.** Say the thing, stop.
- **Tables over prose for reference material.** Config keys, env vars, failure modes, phases — table first, prose only when a table can't carry the meaning.
- **Copy-paste-runnable code.** Real paths, real commands, real env vars. No `<placeholder>` unless labelled and explained.

## Writing style — source comments and docstrings (`plugin/**`, `tools/**`)

- **Default to no comment.** Only write one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug.
- **Don't explain WHAT the code does** — well-named identifiers already do that.
- **No essay-length block comments.** A narrative belongs in `docs/architecture.md`, not above a function.
- **No incident narratives.** Dates and what-broke belong in the commit message and PR description.
- **Same slop rules as above.**

## Enforcement

`npm test` runs `tools/test/style.test.mjs`, which greps for the slop terms and third-person patterns above. Regressions fail the test.

**Do-not-touch surfaces.** `SETUP.md` and everything under `plugin/{agents,skills}/` are agent-instruction files where `the user` is the correct third-person reference — the style test excludes them.

## Antigravity runtime notes

- **Model cast:** Gemini 3.8 Flash conducts on agy; Opus 5 answers judgment phases through the Claude Agent SDK (`claude -p`, the `claude-cli` bridge adapter); Gemini 3.8 Flash answers mechanical phases. agy's built-in Claude (Opus 4.6 / Sonnet 4.6) is never used. Google's `google-antigravity` SDK is never the driver and never carries a Claude call.
- **Every model call goes through the bridge** (`plugin/mcp/model-dispatch`), including judgment work, so per-phase cost attribution survives. The conductor authors no shipped content.
- **Two Claude wallets, one adapter.** Arm A: `ANTHROPIC_API_KEY` in the bridge env. Arm B: `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION=global`. `ClaudeCliAdapter` spawns `claude` with the bridge's environment, so the policy file is identical across arms.
- **The driver pin lives in the policy's `driver:` block** (`plugin/config/policies/antigravity-flash38-plus-opus5.yaml`), read by `plugin/agy/run.mjs`. It is not a `models[]` entry: preflight builds an adapter for every model.
- **Headless runs need `--dangerously-skip-permissions`.** Print mode soft-denies any tool that would prompt. `--gates=auto-approve` is the pass skill's gate mode, a different layer.
- **Driver cost is modeled, never presented as spend.** Seat billing has no invoice; the event reader prices `usage` from the driver block's card and labels the line `modeled`.
- **Never edit `~/.gemini/`.** The plugin is discovered from the `.agents/plugins/mmo/` mount in the repo (the declared `.agents/plugins.json` route did not resolve — check 10). `agy plugin install`, `agy plugin import` and `agy mcp add` all write under your home directory; do not use them for this repo.
- **Every capability claim cites a check** in `docs/verification/p1-agy-runtime.md`. A check marked pending pins nothing. `plugin/agy/telemetry/fairnessPin.mjs` mirrors the pending set; flip an entry only in the commit that records the live result.
- **Two dispatch routes, one contract.** The conductor calls the bridge's MCP tools directly (pattern a); `plugin/agy/dispatch.mjs` is the fallback when a session binds none (pattern b). Both go through the same five tools and the same TaskPacket.
- **`manifest.json` is code-written** (`plugin/agy/manifest.mjs`), never by the model. The driver's own line lives in `driver-cost-modeled.jsonl`, `provenance: "modeled"`, `tier: "orchestrator"`.

## Standing rules

- Generic engine only: no campaign values, seeds or study ids in code.
- Never commit keys, credential files, run databases, run folders, or `dist/`.
- Every change ships its tests, offline and free, reachable from `npm test`.
- Pricing preflight before any paid run; no paid run without an explicit go.
- The `google-antigravity` SDK is never the driver and never carries a Claude call. agy's built-in Claude is never used.
- Nothing under `~/.gemini/` or `~/.claude/` is edited; everything lives under `.agents/` in the repo.
- Modeled dollars (the driver line) and cash dollars (bridge dispatches) are never summed into one figure.

## Other conventions

- **No `Co-Authored-By:` trailers for AI assistants** in commit messages. See CONTRIBUTING.md.
- **One topic per PR**, focused diff.
- **Run `npm test` before you submit.** It is offline and free.
