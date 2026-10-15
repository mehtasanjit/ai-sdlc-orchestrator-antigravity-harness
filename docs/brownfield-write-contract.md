# Brownfield write contract

> **For:** understanding how the "never touch off-limits" guarantee is enforced at the tool boundary. **Also see:** [brownfield.md](brownfield.md) · [brownfield-privacy.md](brownfield-privacy.md).

The plugin's promise for brownfield mode is: **nothing outside a confirmed file-scope gets
touched.** This document explains how that promise is enforced and answers common "will this
touch X?" questions.

## The contract

**The orchestrator MAY NOT write to any path unless:**

- The path is in the run's `allowlist` (confirmed by you at Gate 0), OR
- The path did not exist at discovery time (a new file), OR
- You re-opened Gate 0 to explicitly expand scope.

**Off-limits paths are hard-rejected** at the tool boundary — before any file-system change
happens.

## Three enforcement layers

The contract is enforced at three layers. Each has different strength and different failure
modes.

| # | Layer | Strength | What it protects against |
|---|---|---|---|
| 1 | Orchestrator prompt gate | **Soft** — instruction to the AI | AI diligence (drops if the model drifts) |
| 2 | Packet validator | **Schema-level** — `TaskPacket.artifact_path` check | Planned writes with bad paths |
| 3 | PreToolUse hook | **HARD** — refused at the tool boundary | Everything, including ad-hoc writes |

Only layer 3 is unbreakable. If the AI ever tries to write outside the allowlist — via a
planned packet OR a spur-of-the-moment file write — the hook refuses it at the tool boundary.
agy declines the tool call. The file system is never touched.

## The hook

Implemented in [`plugin/agy/hooks/write-contract-check.mjs`](../plugin/agy/hooks/write-contract-check.mjs).
Registered as a `PreToolUse` matcher on the file-writing step types (`write_to_file`,
`replace_file_content`, `multi_replace_file_content`, `file_change`, `write_blob`, `code_action`,
`propose_code`) and `run_command` in [`plugin/hooks.json`](../plugin/hooks.json). The hook runs with
the plugin directory as its cwd, replies `{"decision": …}`, fails open on its own errors, and appends
every refusal to `.sdlc/local/guard-decisions.jsonl` — the only record a denial leaves, since agy's
stream-json output does not carry it.

Behavior, in order:

1. On every file-writing tool call, agy invokes the hook.
2. The hook scans the content the call would write for a credential literal — deny if hit (see
   [Credential literals](#credential-literals)). This step needs no contract.
3. **Which contract.** Only the contract at the root of the git project that holds the target counts:
   the nearest folder at or above the target with a `.git`, and `.sdlc/local/write-contract.json` under
   it. A `write-contract.json` anywhere else binds nothing. While the session's own project has a
   binding contract, a target outside that project — as written, or once links are followed — is
   refused as a cross-project write.
4. **Whether it binds.** A contract binds while its run is live: `active: true`, and no
   `.sdlc/runs/<run-id>/run-end.json`. With none binding (greenfield, a project that never ran a
   brownfield job, or a run that has ended), only the always-off-limits list is refused: `.env`,
   `.env.*`, `.mcp.json`, `.cursor/rules/**`, `.claude/settings.local.json`, `.git/**`, at any depth.
5. **The freeze record decides first.** `write-contract.mjs --freeze` records the SHA-256 of the
   contract's bytes in `.sdlc/runs/<run-id>/contract.lock.json`, with the test commands Gate 0
   confirmed (`test_commands`, empty for `none`). While that run is live, a contract that no longer
   matches — widened, switched off, deleted, replaced — refuses every write, with the reason. So do
   two live freeze records.
6. **A live run's contract binds:**
   - The contract file, the run's `contract.lock.json`, its `run-end.json` and its test record
     `test-run.json` are refused to file tools, whatever the allowlist says. Only
     `write-contract.mjs` and `test-run.mjs` write them.
   - The always-off-limits list is refused, under every contract, `strict: false` included.
   - The run's own folder `.sdlc/runs/<run-id>/` is allowed: its requirements, design, packets and
     reports.
   - A package manager's own `node_modules/` is allowed. `node_modules/**` in `off_limits` keeps
     file tools and redirects out of installed code; it does not stop the project's install. A
     redirect or file tool naming the same path is judged as itself.
   - The contract's `off_limits` — deny with the reason if hit. This covers a lockfile a package
     command rewrites (`npm install` with no `--no-package-lock`, `yarn install` with no
     `--frozen-lockfile`), when you named it at Gate 0.
   - A package manager's lockfile, otherwise — allow. `package.json` is judged like any other path.
   - The `allowlist` — allow if hit.
   - Otherwise — deny.
7. Off-limits patterns (the always list and the contract's) match in any letter case: on macOS's
   default disk `.ENV` is `.env`. The allowlist matches exactly. A path is judged as written and as it
   resolves through links: both must pass, and a link that leads out of the project is a write
   outside it.
8. `contract.strict = false` (`--strict-write=off`, passed by you at the start) downgrades the
   contract's off-limits and allowlist refusals to warnings. It never opens the always-off-limits
   list or the contract's own files, and does not lift step 2.

Fail-safe: a bug in the hook itself (an input it cannot parse, a field it cannot read) → allow. A
contract that does not parse is not such a bug: under a live freeze record it refuses every write
(step 5); with none, it binds nothing.

## The contract's life

All three files are written by [`plugin/scripts/write-contract.mjs`](../plugin/scripts/write-contract.mjs), never by the model:

| When | Command | Writes |
|---|---|---|
| Gate 0 approved | `write-contract.mjs --freeze --run-id <id> --allowlist '<JSON>' --off-limits '<JSON>' --test-command '<command>'` (once per package command in a monorepo, or `--test-command none`) | `.sdlc/local/write-contract.json`, `.sdlc/runs/<id>/contract.lock.json` |
| Close-out, after Gate 4 is accepted | `write-contract.mjs --close --run-id <id>` | `.sdlc/runs/<id>/run-end.json` (`completed`), then `active: false`. Refused unless `.sdlc/runs/<id>/test-run.json` records a passing run of a frozen test command, from the project root, and the hook allowed no project write after that run started; or Gate 0 froze `none` |
| A gate answered `abort` after the freeze | `write-contract.mjs --close --run-id <id> --outcome=aborted` | the same, `aborted` |
| Phase 7 stops the run: its tests cannot run, or still fail after the debug retries | `write-contract.mjs --close --run-id <id> --outcome=stopped --reason "<what failed>" --needs "<what you must do>"` | the same, `stopped`, with `reason` and `needs` |
| A headless run's driver loop ends | `plugin/agy/run.mjs`, for the run it launched | the same, `completed` (`SUMMARY.md` and a passing test record) or `stopped`. A run that recorded its own end is not resumed |
| A run that will never end by itself (its chat closed, it crashed) | `write-contract.mjs --abandon --run-id <id> --reason "<why>"` — your decision | the same, `aborted` |

`--freeze` refuses a project root that is not a git project's root, a run that already froze or
ended, a project another live run holds, and a freeze with no `--test-command`. Ending a run never
deletes its folder.

## Headless runs

On agy 1.3.5, `agy -p` loads the plugin's hooks, and the write-contract hook refuses a write during
a headless brownfield run as it does interactively. agy 1.2.5 loaded none
([check 1](verification/p1-agy-runtime.md)). The run record says which held: `driver-manifest.json`
and `manifest.json` carry `harness.write_guard.state: "hook"` when the hook logged a decision naming
the run (`hook_decisions` counts the writes it judged and refused), and `"off"` with the reason when
it logged none. An interactive run records `"hook"`. After the run, `run.mjs` compares a snapshot taken at launch with one taken at the end —
every file `git status` lists as changed, untracked or ignored, with its mtime and size — and lists
in `write_guard.after_run_check.outside_contract` every file the run changed that its contract does
not allow, and warns on stderr. A file already modified before the run and written again shows;
so does an ignored `.env`. An ignored folder (`dist/`, `node_modules/`) is one entry, and shows
when an entry directly inside it is added or removed. That check detects; it does not prevent.
Review the diff before you keep a headless brownfield change.

A run that stops before its `SUMMARY.md` (a quota error, a kill) ends its contract. `--resume`
binds it again when the launcher's own stop ended it and the contract still matches its freeze
fingerprint, and keeps the stop's record as `run-end.stopped-<time>.json`; a run you ended with
`--close` or `--abandon` stays ended. The launch snapshot is kept in the run folder
(`git-status-at-launch.json`), so the after-run check of a resumed run covers every launch.

## Credential literals

The hook runs the secret patterns in
[`plugin/scripts/dispatch-sanitize.mjs`](../plugin/scripts/dispatch-sanitize.mjs) over every
string argument of a file-writing call and over the whole `run_command` command line, so
`echo GEMINI_API_KEY=AIza… > x.cjs` and `export GEMINI_API_KEY=AIza…` are both refused. The
reason names the pattern and the target file, never the value. Text a replace expects to find on
disk (`TargetContent`) is not scanned, so an edit that removes a committed key goes through. The
`KEY=value` assignment pattern is left out because it also matches `process.env.GEMINI_API_KEY`
and `$GEMINI_API_KEY`, the form you want. A headless run is covered when agy loads the hook (agy
1.3.5, [check 1](verification/p1-agy-runtime.md)); its `harness.write_guard.state` says whether it did.

## Off-limits, two tiers

Off-limits paths come from two sources merged into the run's write contract:

| Tier | Source | Written when | Examples |
|---|---|---|---|
| **Project defaults** | `.sdlc/project.json.off_limits_default` | Once at setup by `/mmo:setup` — a fixed list every run in this folder inherits. | `.env*`, `.mcp.json`, `.cursor/`, `.aider*`, `.continue/`, `.github/copilot-instructions.md`, `.roo/`, `node_modules/**`, `dist/**`, LFS-marked files, submodules. |
| **Per-run additions** | Gate 0's off-limits list | Each brownfield run, on top of the defaults. | Anything ticket-specific — a directory you know shouldn't move for this particular change. |

The merge happens at Gate 0. The write contract at `.sdlc/local/write-contract.json` holds the merged result. The PreToolUse hook reads it and never sees the two tiers as distinct — a hit in either denies the write.

Change the project defaults by editing `.sdlc/project.json.off_limits_default` in a PR (committed, team-shared). Change per-run additions by editing Gate 0's proposal before approving.

## Merge semantics for sensitive files (deep-merge, never overwrite)

Even when a file is in the allowlist, the plugin uses deep-merge semantics for anything
sensitive:

| File | Rule |
|---|---|
| `package.json` | Add missing deps/scripts; never remove; never downgrade; new script names must not shadow existing |
| `.env` / `.env.example` | Append missing KEY names only; never rewrite values; **never `cp .env.test .env` when `.env` exists** |
| `AGENTS.md` | Never touch (only append one import line at first setup, via mini-gate with diff preview) |
| `.agents/` | The plugin mount only; nothing else under it is written |
| `.sdlc/project.json` | Read → parse → deep-merge → write, with diff at mini-gate |
| `routing-policy.yaml` | **Never touched if pre-existing** (surfaced at Gate 0 so its presence is visible) |
| `.cursor/rules`, `.aider*`, `.continue/`, `.github/copilot-instructions.md` | Default off-limits (from `project.json.off_limits_default`); only editable if explicitly moved into allowlist at Gate 0 |

## Diff-preview mini-gate for pre-existing files

Any packet targeting a file that existed at discovery time triggers a diff-preview:

1. Packet dispatches → returns proposed content.
2. Orchestrator computes a unified diff between the current file and the proposed content.
3. Diff is shown to you inline.
4. Approve → write. Revise → dispatch again with your comments. Abort → skip this packet.

This is the concrete answer to the "the plugin doesn't know how you use Gemini / Cursor / your own tooling" problem — even if discovery misclassified a file's role, the diff appears before the write lands.

## FAQ

| Question | Answer | Escape hatch |
|---|---|---|
| Will this touch my `.env`? | No, ever. `.env*` is in `.sdlc/project.json.off_limits_default` — the write contract refuses writes there regardless of intent. If codegen introduces a new required env var, the KEY name (not the value) is appended to `.env.example` and a mini-gate asks you to populate `.env` before Phase 7 tests run. | None. `.env` values are yours. |
| Will this touch my Cursor rules (`.cursor/`)? | No. Default off-limits. | Move `.cursor/` into the allowlist at Gate 0 by editing the proposal. |
| Will this touch my `package.json`? | Only to add missing dependencies (deep-merge, append-only) and only when a codegen packet explicitly requires it. Never removes, downgrades, or shadows existing scripts. | None needed — the merge rules already enforce safety. |
| Will a run install my dependencies? | Only for its tests, when the test folder has a `package.json` and no `node_modules/`: `npm ci` with a `package-lock.json`, `yarn`, `pnpm` or `bun install --frozen-lockfile` with their lockfiles, and `npm install --no-package-lock` with none. Each leaves the lockfile and `package.json` as they are and writes only `node_modules/`. | Put `package.json` in the allowlist at Gate 0 when the job itself changes dependencies (a `deps` run). |
| Can a run finish with failing tests? | No. It ends `stopped`, with `reason` and `needs` in `run-end.json` and `manifest.json` → `harness.stop`, when its tests cannot run or still fail after the debug retries. `write-contract.mjs --close` refuses `completed` without a passing `test-run.json`, and the manifest records such a run as `incomplete`. A pass counts only for a command Gate 0 froze, run from the project root; `test-run.mjs` refuses any other before it runs. A project write the hook allows after the test run started voids the pass, so a Gate 3 or Gate 4 revision runs the tests again. | Answer `none` for the test command at Gate 0: the run completes without a test run. |
| What if I have `commit_strategy: per-gate`? | The plugin refuses to run on a dirty tree so your uncommitted work does not tangle with the plugin's commits. Defaults are safe: `branch_strategy: current`, `commit_strategy: none`, `pr: off`. | `--allow-dirty` bypasses the git-clean check. |
| Can the AI bypass the hook? | Interactive: not through a file tool. The hook is an agy `PreToolUse` matcher, refusals happen before the tool executes, and editing the frozen contract refuses every later write. A shell command is checked for redirects, `tee`, `touch`, `cp` and `mv`, for the literal paths an inline `node -e` / `python -c` script writes through `fs`, `open()` or `Path`, and for package commands (`npm`, `pnpm`, `yarn`, `bun`), judged in every project whose contract binds. The project's own install (`npm ci`, and `install` naming no package) writes `node_modules/` and the lockfile, which a live contract allows unless its `off_limits` names the lockfile. A named install, `add`, `update` or `remove` is also a `package.json` write, judged by the contract. The quoted values of `--reason` and `--needs` are prose, not commands, and are not judged, unless the shell expands them (`$`, a backtick). While a contract binds, an inline script write whose path is not a literal is refused. Any other shell write is not seen; the run record's `after_run_check.unjudged_changes` lists every changed file no hook decision named. A command that rewrites the contract changes its bytes and locks the run. Headless: on agy 1.3.5 `agy -p` loads the hook and refuses the same writes ([check 1](verification/p1-agy-runtime.md)); the record's `write_guard.state` is `hook` when it judged the run's writes and `off` when it judged none, and the after-run check lists what the run changed outside the contract either way. | `--strict-write=off` at run start, passed by you. Mid-run: none; a wider scope is a new run with its own Gate 0. |
| A run stopped after Gate 0 and the project stays held | `node plugin/scripts/write-contract.mjs --abandon --run-id <run-id> --reason "<why>"` records the run's end (aborted) and switches its contract off. Deleting the contract does not free it: under the live freeze record that refuses every write. | Your decision. |
| How do I override off-limits for one specific run? | Re-open Gate 0 with `revise:` and move the specific path from `off_limits` to `allowlist`. Ephemeral — applies to this run only. | None. `.sdlc/project.json.off_limits_default` is unchanged by this. |
| My repo has files with unusual characters — will pattern matching work? | Yes. The hook uses glob-style pattern matching (`*`, `**`, `?`, literal `/`). No shell-out, no eval on paths. Unicode, spaces, and exotic characters all work. | None needed. |
| What if I run `git checkout` or `git reset --hard` mid-run? | The plugin observes git state between phases via `git status`. If HEAD moved unexpectedly, it halts with a clear message before continuing. | None. The halt is the safety guarantee — better to stop than write against a repo that changed under it. |
