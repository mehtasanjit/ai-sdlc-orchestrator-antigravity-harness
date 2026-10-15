---
name: brownfield
description: "Run the AI-SDLC pipeline against an existing repository. Extends the plugin from greenfield-only to any real project — describe the job in one line after the command and the job type is proposed from the wording, or pick one of seven job types (docs, bugfix, feature-extend, feature-new, refactor, test, deps); confirm scope at Gate 0, and run with a non-destructive write contract that guarantees off-limits files stay untouched."
argument-hint: "[the job, in one line — optional; the job type is proposed from the wording]"
---


Brownfield entry point. This command takes optional free text: describe the job in one line and
the job type is proposed from the wording and confirmed with one question before the interview.
With no text, everything it needs it asks for. Gate 0 always fires and always re-confirms the
job type and scope before anything is written.

Follow the operating manual in
[plugin/skills/brownfield-guide/SKILL.md](/plugin/skills/brownfield-guide/SKILL.md),
with this handover:

- `intent:` — not set. Step 4a chooses it: proposed from `seed_description` when that is
  non-empty, asked as the seven-option question otherwise. Gate 0 re-confirms it.
- `intent_from_seed: true` — propose the job type from `seed_description` (step 4a's inference
  branch). Inert when `seed_description` is empty.
- `seed_description:` — the text of $ARGUMENTS, verbatim, if non-empty.
  Empty means ask which job type, then run the full step-4b interview.
