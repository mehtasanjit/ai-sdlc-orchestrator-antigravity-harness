# Headless Proof Runs — `ping-1` and `bugfix-1`

Run date 2026-10-14 · `develop` at `18bcdc7` · agy `1.3.5` · policy `antigravity-flash38-plus-opus5` · `--gates=auto-approve`

> **For:** the end-to-end proof the 13 Oct review asked for: one headless greenfield run and one headless brownfield run on the fixed code, with the cost checked. Historical record. **Also see:** [../running.md](../running.md#measured-runs-the-greenfield-and-brownfield-proof-runs) · [p1-agy-runtime.md](p1-agy-runtime.md).

## Verdict

Both runs completed, and both pass every cost check in [running.md](../running.md#measured-runs-the-greenfield-and-brownfield-proof-runs). Each line re-prices from its tokens at the dated list card. The driver line is one figure across a resume and matches agy's own conversation record to the token. Cash and modeled dollars are never summed. The runs found five defects, none in cost: four in the brownfield write guard and one in how a quota stop ends a run.

## Wallets

| Line | Wallet | Kind |
|---|---|---|
| Gemini workers | Vertex ADC, project `temp-genmedia-study`, region `global` | cash |
| Claude worker (Opus 5) | claude.ai team seat through the Claude Agent SDK; no `ANTHROPIC_API_KEY` | modeled |
| Driver (agy) | Google seat; agy signs in with `authMethod=gcp`, quota project `temp-genmedia-study` | modeled |

## Results

| | `ping-1` (greenfield) | `bugfix-1` (brownfield, intent `bugfix`) |
|---|---|---|
| Brief | `examples/quick-demo/brief.md` | `plugin/examples/brownfield-bugfix/intent_brief.md` |
| Window (UTC) | 10:45:13 → 11:17:21 | 11:17:31 → 12:01:02 |
| agy invocations | 1, exit 0 | 2: exit 3 on a quota stop, then exit 0 on `--resume` |
| Completed | yes | yes |
| Dispatches | 11: Opus 7, Flash 4 | 12: Opus 5, Flash 4, no model call 3 |
| Gemini workers (cash) | $0.009301 | $0.037715 |
| Claude worker (modeled) | $1.602555 | $1.516805 |
| Driver (modeled) | $1.607358 | $2.225284 |
| Outcome | Express ping service; its own tests pass 2/2 | `/login` returns 400 with the missing field; the project's tests pass 10/10, including the seeded failing case |

## Cost checks

| Check | `ping-1` | `bugfix-1` |
|---|---|---|
| `cost.lines[]`: three lines, each with its kind | pass | pass |
| Driver basis names the dated period (2026-09-02..2026-12-31); one figure, no range | pass | pass, across the resume |
| `harness.driver_token_readings` all `cache-outside-total+thinking-in-output (adds_up)` | 1 of 1 | 2 of 2 |
| `driver_usage.local_record.agrees` | `true` | `true` |
| `pin.verified` | `true` | `true` |
| `driver_model_mismatch`, `bridge_build_stale`, `other_runs_in_directory` | absent | absent |

Re-priced by hand at the Gemini 3.8 Flash list card ($0.75 input, $0.075 cached, $3.75 output per million):

| Line | Tokens | Re-priced | Booked |
|---|---|---|---|
| `ping-1` Gemini workers | 7.8K in, 911 out | $0.0093 | $0.009301 |
| `ping-1` driver | 755.5K fresh, 10,948.6K cached, 58.6K out | $1.6075 | $1.607358 |
| `bugfix-1` driver, from agy's local record | 1,228.5K fresh, 13,595.4K cached, 75.8K out | $2.2253 | $2.225284 |

The `bugfix-1` driver line is the cumulative counters of both processes differenced, not summed: the stream and agy's local record both hold 14,823,869 input, 13,595,365 cached, 75,801 output and 40,652 thinking tokens.

## Routing

Every `bugfix-1` code packet (`bug_fix_apply`, `existing_file_edit`, `test_add`) went to Flash. Two `ping-1` codegen packets, task types `package_json` and `ignore_file`, matched no rule and fell to Opus ($0.057 modeled); the report lists both. Routing all codegen to Flash by phase is the review's to-do, not a do-now item.

## Defects found

| # | Defect | Seen in | Fix |
|---|---|---|---|
| 1 | The conductor wrote `src/auth.js`, `src/index.js` and `src/auth.spec.js` with `node -e "fs.writeFileSync(…)"`; the hook judged only redirects, `tee`, `touch`, `cp` and `mv`, so it judged 2 of the run's writes while the record read `write_guard: "hook"` | `bugfix-1` | `fix/write-guard-shell-writes` |
| 2 | `npm install`, run for `npm audit`, wrote 616 files under `node_modules/` (off-limits) and a `package-lock.json`; no hook decision, only the after-run check | `bugfix-1` | `fix/write-guard-shell-writes` |
| 3 | After the resume, the after-run check compared against the resume's own snapshot: the final record lists 0 files outside the contract; the first launch had listed 617 | `bugfix-1` | `fix/resume-keeps-write-guard` |
| 4 | The quota stop ended the contract, and `--resume` ran the rest of the run with no contract binding | `bugfix-1` | `fix/resume-keeps-write-guard` |
| 5 | agy's own model got Vertex `RESOURCE_EXHAUSTED (code 429)` and agy exited 3; `run.mjs` resumed only after exit 0, so the run needed a manual `--resume` | `bugfix-1` | `fix/resume-after-quota-error` |

The example project has no `.gitignore`, so its `node_modules/` shows as untracked files rather than one ignored folder.
