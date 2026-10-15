---
name: pass
description: "Run the AI-SDLC workflow end-to-end. Reads a project brief and drives requirements, design, codegen, tests, docs, and reviews under the loaded policy. Premium-judgment phases stay on the subagent's own tier; mechanical phases dispatch to the policy's mechanical model. Configurable via --auth, --policy, --study, --run-id."
argument-hint: "--auth=vendor [--policy=<name>] [--study=<study-id>] [--run-id=<run-id>] <path-to-brief.md>"
---


Invoke the `orchestrator` subagent to execute one full SDLC run.

**Arguments:** $ARGUMENTS

**Argument parsing (the orchestrator must do this):**
- `--auth=vendor` — **required**, and `vendor` is the only value this runtime accepts: every LLM call dispatches via the MCP server so telemetry carries real vendor-reported tokens. `estimated` (a char-count heuristic for direct-tier calls) belongs to the Claude Code harness. If the flag is missing or carries any other value, abort — see rule 6 in the orchestrator's system prompt for the exact abort text.
- `--policy=<name>` — routing policy name. When absent, resolves to the current project's `default_policy` field from `.sdlc/project.json` (written by the setup-time policy console — see [SETUP.md](../../SETUP.md) §5b), or `antigravity-flash38-plus-opus5` if no project default is set. A `routing-policy.yaml` at the project root outranks both (see Policy resolution below).
- `--study=<study-id>` — case-study identifier. Defaults to `workforce-ops`. Set this to a project-specific id when running against a brief other than the shipped `examples/workforce-ops/brief.md`, so telemetry and packets stay grouped by project.
- `--run-id=<run-id>` — run identifier within the study. Defaults to `pass1`.
- The remaining positional argument is the path to the brief file. Any markdown brief on disk works — see `docs/brief-template.md` for the section layout the requirements phase expects.

**Output paths:**
- `pass_id`: `<run-id>`
- `output_dir`: `examples/<study-id>/passes/<run-id>/`
- `telemetry_path`: `examples/<study-id>/passes/<run-id>/telemetry.jsonl`
- `manifest_path`: `examples/<study-id>/passes/<run-id>/manifest.json`
- `cache_context`: `<run-id>:<study-id>` (used to key the mechanical-tier prompt cache)

If `examples/<study-id>/passes/<run-id>/` already exists, its contents will be overwritten. Use a new `--run-id` to preserve prior data.

**Single-model runs** — to author every phase with one model (e.g. an "Opus only" baseline), pass a policy whose `rules:` list has only a default rule routing to that model. The same command flow runs; the routing table just does not fork.

**Policy resolution:** every policy tool on the MCP server (`execute_with_model`,
`preflight_dispatch`, `load_policy`, `simulate_policy`) resolves through one loader with one
precedence, and the orchestrator's job is to pass the arguments that express what the user asked
for:

1. **A repo-local `<project root>/routing-policy.yaml` wins over any name.** Pass
   `policy_name: <resolved name>` plus `project_root: $(pwd)`; the loader prefers the project
   file whenever it exists. Omitting `project_root` is the historical bug: the run silently fell
   back to the shipped preset while the project's own policy sat unread. If the user also passed
   `--policy=<name>` and it names another policy, say that `routing-policy.yaml` is in force and
   the flag is not used. The headless launcher (`plugin/agy/run.mjs`) resolves the same way.
2. **Otherwise an explicit `--policy=<name>` flag** names the preset
   `plugin/config/policies/<name>.yaml` (a policy saved from the console lives there too).
3. **Otherwise the project's `default_policy`** from `.sdlc/project.json`, or
   `antigravity-flash38-plus-opus5` when none is set.

Pass the same policy arguments on **every** call, `simulate_policy` included — a what-if priced
under a different policy than the run used is worse than no what-if.

**Requirements before starting:**
- Gemini credentials must be present when the policy uses any Gemini model — either Google Cloud credentials for Gemini Enterprise Agent Platform, formerly Vertex AI (`gcloud auth application-default login`, no key), or `GEMINI_API_KEY` for AI Studio. If neither is available, abort with a clear message naming both.
- A Claude wallet must be present in the shell that launched agy: arm A `ANTHROPIC_API_KEY`, or arm B `CLAUDE_CODE_USE_VERTEX=1` + `ANTHROPIC_VERTEX_PROJECT_ID` + `CLOUD_ML_REGION=global`. `--auth=estimated` is not available on this runtime; if it is passed, abort with the rule-6 text.
- `CLAUDE_CODE_SUBAGENT_MODEL` does not apply on this runtime: the conductor is agy's own model, pinned by the policy's `driver:` block and asserted by `plugin/agy/run.mjs` before a headless run starts.
- The MCP server `model-dispatch` must be registered (it is, via the plugin manifest).

**HITL gates active:** Gate 1 (requirements), Gate 2 (design), Gate 3 (security review), Gate 4 (final acceptance).

When invoked headlessly (`plugin/agy/run.mjs`, which wraps `agy --print … --output-format stream-json` with the pinned invocation), the launcher requires `--gates=auto-approve` or `--gates=auto-abort`: `auto-approve` accepts all four HITL gates so the session completes without prompts, and `auto-abort` stops at the first one. `prompt` is refused there, because print mode has no one to answer it.

---

## Brownfield-mode flags (added in v1)

When `--mode=brownfield` is set, the pipeline uses the brownfield entry (equivalent to
``/mmo:brownfield`` but flag-driven for scripted / CI use). Additional required + optional
flags:

| Flag | Purpose |
|---|---|
| `--mode=brownfield` | Switch to brownfield mode. Default is greenfield. |
| `--intent=<docs\|bugfix\|feature-extend\|feature-new\|refactor\|test\|deps>` | Required in brownfield. The job type. Adds a `Gate 0` before Gate 1. |
| `--brief=<path>` | Optional: pre-written intent brief (replaces the interview). Any markdown file with the section layout in [docs/brownfield.md](../../docs/brownfield.md) works. |
| `--gates=<prompt\|auto-approve\|auto-abort>` | Gate behavior. `prompt` (default) is interactive; `auto-approve` accepts every gate (headless friendly); `auto-abort` **v1.5** — approves only when the run's fingerprint matches `.sdlc/project.json`, aborts otherwise. Recommended for CI so drift never silently proceeds. |
| `--from-config=<path>` | **v1.5** — read gate answers from a committed team config file. Combined with `--gates=auto-abort`, this is the CI-safe flow. |
| `--policy=<name>` | Same as greenfield. Overrides the setup-time project default (`.sdlc/project.json.default_policy`). A repo-local `routing-policy.yaml` still wins, in the bridge and in the headless launcher alike (see **Policy resolution** above). |
| `--strict-write=off` | Downgrade the write-contract PreToolUse hook from HARD-BLOCK to WARN. Every off-limits or not-in-allowlist write is logged but not refused. Use with care — this defeats the plugin's main safety guarantee. |
| `--allow-dirty` | Bypass the git-clean check when the git contract's `commit_strategy != none`. |
| `--recheck` | Force pre-check re-run even when the cached status is still valid. Useful after a plugin version bump. |
| `--adaptive-profile` | Force Tier 2b adaptive stack profile even when a matching pre-authored adapter exists. Useful when the shipped adapter's conventions don't match this repo. |
| `--refresh-profile` | Force stack-profile re-scan (implies `--recheck`). Use after a substantial repo restructure. |

**Brownfield output paths:**
- `run_id`: `<YYYYMMDD-HHMMSS>-<intent>-<slug>`
- `output_dir`: `.sdlc/runs/<run_id>/`
- `telemetry_path`: `.sdlc/runs/<run_id>/telemetry.jsonl`
- `manifest_path`: `.sdlc/runs/<run_id>/manifest.json`
- `provenance_path`: `.sdlc/runs/<run_id>/provenance.json`

**Brownfield requirements before starting:**
- Everything greenfield requires, PLUS:
- `.sdlc/local/write-contract.json` gets written after Gate 0 approval (before any packet
  dispatches). The PreToolUse hook reads it on every `Write`/`Edit`.
- The current directory MUST be a git repo (or an ancestor is). Brownfield refuses on non-git
  folders with a clear message.
- The pipeline pre-check (§7.4) must have passed or been skipped-with-user-consent for this
  run's inputs.

See [plugin/skills/brownfield/SKILL.md](../brownfield/SKILL.md) for the interactive equivalent
of these flags (the 7-step operating manual Claude follows in the interactive flow).

Begin now.
