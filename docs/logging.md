# Logging

> **For:** watching what a run is actually doing — delegations, model dispatches, routing decisions, AG SDK worker sessions. **Also see:** [understanding-output.md](understanding-output.md) · [methodology.md](methodology.md) · [troubleshooting.md](troubleshooting.md).

Every model dispatch, routing decision, vendor API call, Antigravity SDK worker session and
write-contract decision emits a line prefixed `MMO:`. This is a trace of what a run did, not a cost ledger —
see [methodology.md](methodology.md#the-mmo-log-stream-is-not-telemetry) for how it differs from
`telemetry.jsonl`.

## Turning it on

Default level is `info` — routing decisions, dispatch summaries, AG SDK spawn and exit. Nothing
per-call, nothing at the vendor-API level.

| To get | Set |
|---|---|
| Per-call detail: adapter internals, env/credential resolution | `MMO_VERBOSE=1` or `MMO_DEBUG=1` |
| A specific level | `MMO_LOG_LEVEL=trace\|debug\|info\|warn\|error` |
| Worker stderr passthrough, payload byte counts | `MMO_LOG_LEVEL=trace` |
| One run, without changing the environment | pass `log_level` or `verbose: true` on the MCP tool call |

`MMO_LOG_LEVEL` outranks `MMO_VERBOSE`/`MMO_DEBUG`; the per-call argument outranks everything —
it's the only way a `--verbose` on one run reaches a server process that started when the session
did. Legacy `SDLC_DEBUG=1` still works as an alias for `MMO_DEBUG=1`, with a one-time warning.

For the model-dispatch bridge specifically, `MMO_LOG_LEVEL`, `MMO_VERBOSE`, and
`MMO_LOG_PREFIX` have to reach the server's environment the same way a credential does — a stdio
server inherits nothing from its parent. `plugin/mcp_config.json` forwards all three as `${VAR}`
for the interactive route; the headless route (`plugin/agy/dispatch.mjs` spawning the server through
`driverClient.ts`) passes the shell's environment through, so an export in the shell that runs
`run.mjs` is enough.

## Reading it

```bash
tail -f .sdlc/orchestrator.log
```

or, live on a headless run, since every line also goes to stderr and `run.mjs` captures agy's
stderr into the run directory:

```bash
MMO_VERBOSE=1 node plugin/agy/run.mjs --brief=examples/quick-demo/brief.md --project-root=/tmp/demo --output-dir=/tmp/demo/.sdlc --gates=auto-approve
grep "MMO:" /tmp/demo/.sdlc/driver-stderr.log
```

## Line format

```
MMO: 2026-08-18T11:04:22.418Z INFO  dispatch.end packet_id=tp_codegen_004 model_id=flash-completion ok=true tokens_in=8214 tokens_out=1902 cost_usd=0.0031 latency_ms=4180
```

Greppable by the `MMO:` prefix, parseable as logfmt after it.

| Element | Rule |
|---|---|
| Prefix | `MMO: ` — overridable via `MMO_LOG_PREFIX` |
| Timestamp | ISO 8601, UTC, millisecond precision |
| Level | Upper case, column-padded so `INFO` and `ERROR` align |
| Event name | A dotted verb — `phase.start`, `dispatch.end`, `agsdk.worker.stderr` |
| Field order | Insertion order of the emitting call. Never sorted, so two runs diff meaningfully |
| Values | Bare when they match `^[A-Za-z0-9_./:@+-]+$`; double-quoted with `\`/`"` escaped otherwise |
| Newlines/tabs in a value | Escaped to `\n` / `\t` — a log line is always exactly one line |
| `null` / `undefined` fields | Omitted entirely, never printed as `key=null` |

## Levels

| Level | Emitted | Contents |
|---|---|---|
| `ERROR` | always | dispatch failures, halts, worker crashes |
| `WARN` | always | write-contract denials, preflight warnings, price mismatches and unpriced models, retired names still in use |
| `INFO` | always | phase and gate boundaries, routing decisions, dispatch summaries, AG SDK spawn and exit |
| `DEBUG` | verbose only | per-call detail, adapter internals, env and credential resolution |
| `TRACE` | verbose only, explicit `MMO_LOG_LEVEL=trace` | worker stderr passthrough, payload byte counts, inventory detail |

## Sinks

| Sink | Path | When |
|---|---|---|
| stderr | — | Always. Never stdout — stdout is the MCP stdio JSON-RPC transport, and one stray byte corrupts the framing. |
| Run log — bridge | `<output_dir>/orchestrator.log`, beside the run's `telemetry.jsonl`; in brownfield that is `.sdlc/runs/<run-id>/orchestrator.log` | Once a run directory exists |
| Run log — scripts and hooks | The same file, when a script is given `--run-id` (`write-provenance.mjs`, `mmo-log.mjs`) or a hook resolves the run (`write-contract-check.mjs`) | Once a run id exists |
| Pre-run fallback | `.sdlc/local/debug.log` | Events before a run directory exists: policy load, credential discovery, env bootstrap |

Rotates at 5 MB, keeping one previous file as `.1`. Two processes can write the run log at once
(the long-lived bridge and a one-shot script such as `write-provenance.mjs`) — appends are
atomic, and rotation takes an exclusive lock so the loser of a race keeps appending instead of
corrupting the file.

## What gets redacted

Never logged, at any level, in any field: environment variable values, API keys, tokens, ADC file
contents, prompt text, file contents, model output, diff bodies. Logged instead: names, paths,
byte counts, token counts, 16-character hash prefixes, enum classifications.

Free text that can't be structured (error messages, worker stderr) is scrubbed against the same
secret-pattern registry `dispatch-sanitize.mjs` uses to block a dispatch outright — a match is
replaced with `[redacted:<pattern-name>]` before the line reaches any sink. This is a second,
independent check: redaction runs on the log path even though a secret-shaped input would
normally already have been refused before dispatch.

Check any run for a leak with:

```bash
grep -iE "sk-ant-|AIza|BEGIN PRIVATE KEY|api[_-]?key=[^ ]" .sdlc/runs/*/orchestrator.log .sdlc/local/debug.log
```

This should always return nothing.

## Event taxonomy

Grouped by what emits them. Full field lists live in the source next to each emitter; this is the
event-name index for `grep`.

| Group | Events | Emitted by |
|---|---|---|
| Run lifecycle | `run.start`, `phase.start`, `phase.end`, `phase.skip`, `gate.open`, `gate.resolved`, `run.end` | `plugin/scripts/mmo-log.mjs`. The shipped conductor prompt does not call it — on this harness the phase record is `gates.jsonl` and the `--log-phase` lines in `telemetry.jsonl`; the CLI is kept for a prompt that wants the trace |
| Model dispatch (MCP) | `tool.call.start`, `tool.call.end`, `packet.validate.fail`, `route.decide`, `adapter.construct`, `dispatch.start`, `dispatch.attempt`, `dispatch.end`, `dispatch.error`, `telemetry.append` | `plugin/mcp/model-dispatch/src/server.ts` |
| Vendor / Agent Platform API | `api.anthropic.request`, `api.anthropic.response`, `api.gemini.backend`, `api.gemini.request`, `api.gemini.response`, `api.gemini.cache.create`, `api.gemini.cache.hit` | The adapters under `plugin/mcp/model-dispatch/src/adapters/` |
| AG SDK worker delegation | `agsdk.spawn`, `agsdk.inventory.before`, `agsdk.worker.stderr`, `agsdk.sidecar`, `agsdk.toolcall`, `agsdk.diff`, `agsdk.exit`, `agsdk.record.write` | `AntigravityWorkerAdapter.ts` |
| Policy, preflight, credentials | `policy.load`, `policy.adapter.deprecated`, `preflight.model`, `preflight.result`, `credential.discover`, `env.legacy_name`, `env.placeholder.strip` | `server.ts`, `credential-discovery.mjs`, `envBootstrap.ts` |
| Pricing | `pricing.policy_mismatch`, `pricing.custom`, `pricing.unpriced`, `pricing.cli_cost_mismatch` | `adapters/dispatchPricer.ts`, `adapters/ClaudeCliAdapter.ts`, `server.ts` |
| Write contract and provenance | `write.allow`, `write.deny`, `provenance.before`, `provenance.after`, `provenance.finalize` | `write-contract-check.mjs`, `write-provenance.mjs` |

## Implementation, if you're changing it

Two independent implementations, because the bridge (TypeScript, compiled) and the scripts the
skills and hooks shell out to (plain ESM) cannot import each other:

| Layer | Files |
|---|---|
| Server | `plugin/mcp/model-dispatch/src/log.ts`, `redact.ts` |
| Scripts | `plugin/scripts/lib/log.mjs`, `plugin/scripts/lib/env.mjs`, `plugin/scripts/mmo-log.mjs` |

Changing the line format, a level rule, or a redaction pattern means changing both.
`plugin/mcp/model-dispatch/test/log.test.mjs` covers the server side; the script side has no
separate test here, so check both by hand against the line format above.
