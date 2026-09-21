# Contributing

## In scope

- **Bug fixes** in the setup wizard, report tool, or plugin code.
- **Documentation improvements** — typos, unclear phrasing, additional troubleshooting entries.
- **Additional policies** under `plugin/config/policies/`. Include a short comment header describing what the policy demonstrates and what keys it needs, keep the `driver:` block (the launcher refuses a policy without one), and make every pricing block match `plugin/mcp/model-dispatch/src/prices.ts` — `prices.test.mjs` fails otherwise.
- **Portability fixes** for Windows/WSL, non-mac Linux distributions, or other environments.

## Discuss first

- Wholesale rewrites of the driver/conductor or the state machine.
- New model adapters — review welcome, but the shipped adapters cover the shipped policies. Additional adapters add dependency weight and maintenance surface.
- Changes that add reporting or telemetry surface without a corresponding entry in `docs/methodology.md`.

Open an issue before writing a large PR.

## Branching model

Two long-lived branches, one direction:

- **`main`** — release / stable. Every commit on `main` is assumed to be a working release. Direct pushes are not allowed. `main` only receives merges from `develop` — one PR per release cut.
- **`develop`** — integration. Every feature branch lands here first. Point-in-time snapshots may be broken; that is what `develop` is for. When a batch of features is ready to ship, a single `develop → main` PR promotes them.

Feature and fix branches:

- `feat/<short-name>` — new features, new adapters, new policies.
- `fix/<short-name>` — bug fixes.
- `docs/<short-name>` — doc-only changes.
- `chore/<short-name>` — plumbing, tooling, refactors with no user impact.

All of the above open PRs targeting **`develop`**, never `main` directly.

## How to submit

1. Fork the repo (or branch directly if you have write access), create a feature branch off `develop`.
2. Make your change. Keep the diff focused; one topic per PR.
3. Run `npm test` from the repo root. It runs the tooling suite and then the MCP server's own, and every one of them is offline and free — no credential is read and no API call is made, so there is no reason not to run it.
4. Run `npm run verify` on a clean clone to confirm it still passes.
5. If you touched the driver, the bridge or the hooks, run the offline smoke run (`npm run smoke`, see [docs/running.md](docs/running.md#offline-smoke-run)) and confirm `node tools/report.mjs` still renders the result sensibly. A paid run needs the study owner's go first.
6. Open a pull request. Describe what changed and why in one or two paragraphs.

## Commit messages

Sentence case, present tense, no emojis. The body wraps at 72 characters and explains *why*, not *what* — the diff shows the what. Keep them short and readable.

Do not add `Co-Authored-By:` trailers for AI assistants. The committer identity is a bot on purpose; AI-attribution trailers add noise on a public repo. This applies to all commits, whether or not an agy / Claude Code / other AI session helped author the change.

## Code style

The tooling scripts under `tools/` (`setup.mjs`, `report.mjs`, `logfmt.mjs`, and the tests beside them in `tools/test/`) are plain ES modules. No TypeScript there, no build step; keep them that way so someone can read and modify them without a compiler.

The same goes for `plugin/agy/` (`run.mjs`, `dispatch.mjs`, `verify-setup.mjs`, `manifest.mjs`, the hooks) and `plugin/scripts/`, and there the reason is stronger than preference: those files run on a machine that mounted the harness from a clone, and the hooks run with the plugin directory as cwd, so none of them can assume `tools/` or a build output. Anything they import has to be either a Node builtin or something they can find inside the plugin (the compiled bridge under `plugin/mcp/model-dispatch/dist/` counts, and `run.mjs` refuses to start when it is missing). Their tests still live in `tools/test/`, where `npm test` picks them up — a test file may import from `plugin/agy/` or `plugin/scripts/`, but not the other way round.

The MCP server (`plugin/mcp/model-dispatch/`) is TypeScript with a build step. Follow the existing conventions in that directory.

There is one Python file, `plugin/mcp/model-dispatch/worker/gemini_worker.py`, because the Antigravity SDK it drives is a Python package and there is no other way to reach it. It is deliberately the only one, and it is only ever installed on machines that opted into the agent path — a harness that quietly required Python of everyone would be a worse trade than the feature is worth. Keep it that way: new work belongs in TypeScript unless it, too, can only be done from Python.

## Writing style

The user-facing docs (`README.md`, `docs/*.md`, this file) and the source comments and docstrings under `plugin/` and `tools/` follow the same voice conventions. They are held by `tools/test/style.test.mjs`, which runs as part of `npm test`.

**User-facing docs**

- Second person, present tense. `You configure X in Y`, never `the user should configure X in Y`.
- Statement of fact. Not narrative. Not `we explored`, not `as demonstrated by`, not `here's how`.
- No AI-slop vocabulary. The banned set is `seamless`, `powerful`, `leverage`, `unlock`, `elegant`, `production-grade`, `battle-tested`, `robust`, `thoughtful`, `graceful`, `as demonstrated`, `in summary` (plus their common inflections). The style test greps for every one of them.
- Tables over prose for reference material. Config keys, env vars, failure modes, phase lists — table first; use prose only where a table cannot carry the meaning.
- Any code block a reader might run has a real command, real path, real env var. No `<placeholder>` unless it is labelled and immediately explained.

**Source comments and docstrings**

- Default to no comment. Only write one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug.
- Do not explain what the code does — a well-named identifier already does that.
- Do not write essay-length block comments. If you find yourself typing "WHY THIS EXISTS / WHAT IT BROKE / THE FIX", that belongs in `docs/architecture.md`, not above a function.
- Do not embed incident narratives ("this broke on 2026-08-04…") in the code. They belong in the commit message and the PR description.
- The slop-word ban applies to comments and docstrings too.

**Do-not-touch surfaces.** `SETUP.md`, `INSTALL.md`, `plugin/agy/prompts/` and everything under `plugin/skills/` are agy-instruction files where `the user` is the correct third-person reference — those files describe what the user's experience should be to another agent that will drive it. The style test excludes these paths on purpose. Historical records (`docs/verification/`, `examples/*/passes/`) are also excluded.

Antigravity CLI (`agy`) sessions see the same rules in [AGENTS.md](AGENTS.md), which lives at the repo root so it loads automatically at session start.
