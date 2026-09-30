# Troubleshooting

> **For:** symptom → cause → fix, keyed by the message on screen. **Also see:** [setup.md](setup.md) · [running.md](running.md) · [verification/p1-agy-runtime.md](verification/p1-agy-runtime.md).

| Symptom | Cause | Fix |
|---|---|---|
| `run failed: run: the driver pin is not live-verified — checks 1, 2, 4, 5, 6 … are still pending` | The pin gate. The listed checks have not been run in a signed-in `agy` session | Run the checks and record them in `docs/verification/p1-agy-runtime.md`, flip them to `pass` in `plugin/agy/telemetry/fairnessPin.mjs` in the same commit — or pass `--allow-unverified-pin` and accept `pin.verified: false` in the manifest |
| `run: could not launch 'agy'` | Not on PATH in the shell that ran node | `export PATH="$HOME/.local/bin:$PATH"`, or `--agy-bin=$HOME/.local/bin/agy` |
| `driver-stderr.log`: `Waiting for authentication (timeout 60s)…` then `authentication failed or timed out` | agy is not signed in; print mode cannot complete the browser flow | Run `agy` interactively once and finish Google Sign-In. `agy models` must list models before a run |
| `driver-stderr.log` names an allow-rule and a soft-denied tool | `--dangerously-skip-permissions` missing (check 6) | `run.mjs` passes it; if you built the argv by hand, add it |
| `preflight.json` has `ok: false` and the run halts | The bridge cannot build an adapter: a missing credential, a policy naming an adapter with no door | Read `halt_reason`. `npm run verify` names the missing variable and where to set it |
| Every packet routes to Opus, cost several times the estimate | Preflight was skipped and the mechanical tier was unreachable | The conductor prompt's rule 0 forbids this; check `gates.jsonl` and `preflight.json` exist |
| `MCP error -32000: Connection closed` from `dispatch.mjs` | A sandbox that allows children but denies piped stdio (check 2) | Start agy without `--sandbox`; the diagnosis in the error names the headless way out |
| `MCP error -32001: Request timed out` | A client timeout below the adapter's worker timeout | `driverClient.ts` uses 900 s; the test suite checks it exceeds every policy's `worker_timeout_sec` |
| The bridge starts with empty credentials under the MCP route | agy did not expand `${VAR}` in `mcp_config.json` (check 5) | `--inline-env` |
| A write the pipeline instructs is refused | The write contract (`.sdlc/local/write-contract.json`) | Read `.sdlc/local/guard-decisions.jsonl`; re-open Gate 0 to widen the allowlist, or set `strict: false` |
| `manifest.md` appears instead of `manifest.json` | The model wrote its own manifest | `manifest.json` is code-written by `plugin/agy/manifest.mjs`; the model's file is advisory |
| The modeled driver line looks several times too high | `input_tokens` counted inclusive of `cache_read_tokens` | The event reader subtracts cache reads before pricing fresh input; check `driver-cost-modeled.jsonl` |
| The report shows a driver **Range** instead of one figure | The run resumed agy at least once, and check 16 (usage across a resume) is pending | Run `tools/p1/live-checks.sh 16` and record it; until then the headline is the upper bound and `driver_usage.cost_usd_low` the lower |
| `run …: agy invocation(s) N ended without a result event` | agy timed out (`--print-timeout`) or crashed before its final `result` line | That invocation's driver tokens are in no figure. Raise `--print-timeout`, or read `driver-stderr.log` for the crash |
| `npm test` reports the MCP suite NOT RUN | `plugin/mcp/model-dispatch/node_modules` absent | `npm run verify -- --fix` (or `npm run build`), then `npm test` |
