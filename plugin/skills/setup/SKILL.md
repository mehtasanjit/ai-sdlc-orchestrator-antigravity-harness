---
name: setup
description: "Re-verify or re-configure the SDLC plugin for this project. Runs the mechanical setup steps silently (MCP server build, environment check, credential probe), pauses only when a human decision is genuinely needed (missing credentials, Gemini door choice, policy pick). Idempotent — safe to re-run any time after `/plugin update` or when a credential changes."
argument-hint: "[--policy=<name>] [--gemini-door=enterprise|antigravity] [--user]"
---


Re-verify the SDLC plugin for this project. Auto-by-default: run the mechanical steps silently and
pause only when a human decision is genuinely required.

**Arguments:** $ARGUMENTS

**Argument parsing:**
- `--policy=<name>` — pre-answer the policy pick (skips the browser). Must match a file in
  `plugin/config/policies/<name>.yaml` — the directory listing is the authoritative preset set
  (`antigravity-flash38-plus-opus5` is the study policy and the default; a wrong name makes the loader print the live
  list).
- `--gemini-door=<enterprise|antigravity>` — pre-answer the Gemini door choice. `enterprise` is the
  API-key / ADC path (default); `antigravity` opens the Antigravity SDK worker (requires ADC).
- `--user` — accepted for compatibility and ignored: this runtime keeps every setting in the
  project (`.sdlc/local/mmo-select.json`); nothing is written under `~/.gemini/`.

# Scope

This is the RE-VERIFY / RE-CONFIGURE command. First-time install (marketplace add + `/plugin
install`) still lives in [SETUP.md](../../SETUP.md) — the plugin has to exist before its slash
commands do. ``/mmo:setup`` covers everything from step 3 of SETUP.md onward: MCP server build,
environment check, credential probe, Gemini door, policy pick, and the hand-over banner.

Every step below auto-runs unless it hits a genuine decision. Print one line per completed step,
so the user can see progress. Pause only when a step actually needs a human answer.

# 1. Build / rebuild the MCP server (silent)

```bash
node "${MMO_PLUGIN_ROOT}/agy/verify-setup.mjs" --fix --project-root "$(pwd)"
```

`--fix` installs the MCP server's npm deps and TypeScript-compiles it. Idempotent — no-op if the
build is already current. Report the one-line result and continue.

If the script exits non-zero, print the error, its `fix:` field, and STOP. This is a blocking
issue (Node < 20, `agy` or `claude` missing, a build error) and must be resolved before anything
downstream can work.

# 2. Read the verify result and pause only for missing credentials

The script reports three kinds of finding:

- `✗` **blocking** — already handled by step 1 above (STOP).
- `!` **warning** — usually a missing credential. **Pause here.** For each warning, print the
  finding and ask the user for the value. Do not fabricate; do not proceed to the next step until
  the credential is either supplied or explicitly skipped.
  - A Claude wallet — arm A `ANTHROPIC_API_KEY`, or arm B `CLAUDE_CODE_USE_VERTEX=1` +
    `ANTHROPIC_VERTEX_PROJECT_ID` + `CLOUD_ML_REGION=global`. Required by every policy that
    routes judgment work through `claude-agent-sdk`.
  - Gemini access — required by any policy that routes mechanical phases to Gemini. Two doors,
    see step 3 below.
- `✓` **ok** — no action, continue.

Do not write a supplied credential anywhere. Tell the user to export it in the shell that launches
agy (or run `gcloud auth application-default login` for the Google Cloud path — no env var
involved) and to start a new session with the start command from step 5. Never write `MMO_SELECT`
by hand; step 3 handles it.

# 3. Gemini door — auto-pick if only one works, ask only if both are available

The mechanical tier has two doors to the same model:

- **Gemini Enterprise Agent Platform (API)** — signs with `GEMINI_API_KEY` or Google Cloud ADC.
  This is what an untouched install already uses. No flag needed.
- **Antigravity SDK worker** — signs with Google Cloud ADC only (no API-key door). Enables
  agentic delegation with a working directory.

Decision matrix:

| `--gemini-door=` supplied? | ADC present? | `GEMINI_API_KEY` present? | Action |
|---|---|---|---|
| yes | any | any | Honor the flag. If it can't work (`antigravity` without ADC), print why and STOP. |
| no | no | no | No Gemini creds at all. Print the one-liner from SETUP.md §5 explaining how to open either door, and continue — the policy pick in step 4 can still run against Anthropic-only. |
| no | no | yes | Silently use `enterprise` (the only door that works). Continue. |
| no | yes | no | Silently use `enterprise` still (default behavior; the user can flip to `antigravity` later by re-running with `--gemini-door=antigravity`). Continue. |
| no | yes | yes | Ambiguous — **ask** which door. Two options only, no descriptions: (a) Gemini Enterprise Agent Platform (API), (b) Antigravity SDK worker. |

When switching to Antigravity:

```bash
node "${MMO_PLUGIN_ROOT}/agy/verify-setup.mjs" --enable-agent --project-root "$(pwd)"
```

Add `--user` if the caller passed `--user`. This writes `MMO_SELECT=gemini-flash=flash-agsdk-worker`
to the settings file and builds the Python environment the agent path needs.

# 4. Policy pick

Read the current default: `node "${MMO_PLUGIN_ROOT}/scripts/setup-policy.mjs" --print-only
--project-root "$(pwd)"`. If it prints a policy name, the project already has one — print
`current policy: <name>` and skip to step 5.

If `--policy=<name>` was supplied, honor it silently — no prompt, no browser:

```bash
node "${MMO_PLUGIN_ROOT}/scripts/setup-policy.mjs" --policy=<name> --project-root "$(pwd)"
```

**Otherwise, use the same terminal picker as ``/mmo:policy` change` Shape 2.** Skip the mid-run
guard here (no brownfield run has started yet in setup); everything else applies:

1. Enumerate policies:
   ```bash
   node "${MMO_PLUGIN_ROOT}/scripts/setup-policy.mjs" --list-json --project-root "$(pwd)"
   ```
2. Ask via `AskUserQuestion`:
   - question: `Which policy do you want as this project's default?`
   - header: `Policy`
   - multiSelect: `false`
   - options: one per policy from step 1 (`label` = policy name, `description` = `""`), plus a
     final `Author a new policy (opens browser)` option with description
     `Opens the local policy console to create a custom YAML.`.
3. Handle the pick:
   - Policy name → run `--check-creds --policy=<chosen>`.
     - `ok: true` → persist with `--policy=<chosen>` and print `Policy set: <chosen>`.
     - `ok: false` → print each `missing` entry with its `fix`, then re-ask via `AskUserQuestion`
       (options: `Retry (I fixed them)`, `Pick a different policy`). Retry → re-run `--check-creds`
       with the same policy. Pick different → loop back to step 1.
   - `Author a new policy (opens browser)` → run
     `node "${MMO_PLUGIN_ROOT}/scripts/setup-policy.mjs" --project-root "$(pwd)"`. The script
     starts the local server, opens the browser, and detects the save automatically via `fs.watch`.

Do not suggest "Type something" as a hidden option — the user's typed name may not match a
shipped preset, which fails downstream. The picker above covers every real path.

# 5. Print the next-steps banner

The script from step 1 already prints this at the end of a successful run. If for any reason it
did not (e.g. the run stopped short earlier), print it explicitly. Get the start command first; it
derives the slug from this project's policy (its `driver:` block) the way `run.mjs` derives
`--model`, and prints `agy --model gemini-3.8-flash-high` for the default policy:

```bash
node "${MMO_PLUGIN_ROOT}/agy/start-command.mjs" --project-root "$(pwd)"
```

```
✓ Setup complete for this project.

Start a NEW session in this folder with exactly this command:

  <start command>

Then try one of these:

  `/mmo:greenfield`          — generate a new app from a brief (empty folder)
  `/mmo:brownfield`   — work on this existing repo (docs, bugfix, feature, refactor, …)
  `/mmo:policy`       — change this project's model policy
  `/mmo:pass`         — the same run with every answer given up front as flags

Current policy: <policyName>   (change: `/mmo:policy` change)
```

Give the start command exactly as printed, never plain `agy`. Say plainly why, in one sentence:
without `--model` the chat runs on agy's default model, and the run's first step
(`check-driver-pin.mjs`) refuses a chat whose model is not the policy's driver pin. If the script
exits non-zero, print its error and STOP: the policy has no usable driver pin, and no run can
start on it.

Say plainly why a NEW session is required: agy loads a plugin's skills, rules, hooks and MCP
servers when a session begins. In this session the setup changes are on disk but not live.

# Idempotency

Every step is safe to re-run:
- The MCP build is a `tsc` no-op if nothing changed.
- The credential probe reads env / settings; it never writes.
- The Gemini-door flip is a plain write of `.sdlc/local/mmo-select.json`.
- The policy pick reads `.sdlc/project.json` first and skips the browser if a policy is already set.

Re-run ``/mmo:setup`` after `/plugin update` (the update wipes `dist/`; `--fix` restores it), or
whenever a credential changes.
