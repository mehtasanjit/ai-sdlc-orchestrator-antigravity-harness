# headless-unlogged-calls fixture

The final `result` line of one real headless Claude Code run (`claude -p --output-format stream-json`, Claude Code 2.1.245, 2026-09-10). The session ran on Claude Opus 5 with the 1M context option, so the receipt names it `claude-opus-5[1m]`. Four helpers ran on Claude Opus 4.8.

| Model | in | cache read | cache write | out | Dollars |
|---|---:|---:|---:|---:|---:|
| `claude-opus-5[1m]` | 20 | 327,898 | 20,329 (all 1-hour) | 5,295 | $0.499714 |
| `claude-opus-4-8` | 228 | 12,651,407 | 423,523 | 188,968 | $13.69806225 |

The receipt's tokens at the list come to $14.19777625, which is also Claude Code's own `total_cost_usd`.

The transcripts log 404,585 Opus 4.8 cache writes, all 5-minute; the receipt bills 423,523. The 18,938 writes no transcript line explains are what the ledger prices at the 5-minute rate.

## What was kept

- `pass1/live-run.log`: the capture's last `result` line, reduced to its type, session id, turn count, `total_cost_usd`, the top-level `usage` token counts and each `modelUsage` entry's token counts and `costUSD`.
- `transcripts/`: the session file and its four `subagents/agent-<id>.jsonl` files. Assistant lines keep `type`, `timestamp`, `sessionId`, `agentId`, `uuid`, `parentUuid`, `isSidechain` and `message.{id, model, stop_reason}`, with `usage` reduced to the token counts, the `cache_creation` split, `service_tier`, `speed` and `inference_geo`. Each `agent-<id>.meta.json` keeps `agentType`, `toolUseId`, `parentAgentId` and `spawnDepth`.

Every message text, prompt, tool input and output, path and other line is removed.

The consuming suite is `plugin/mcp/model-dispatch/test/claudeCliPricing.test.mjs`, which prices this result through `claudeCliLedger.ts` with and without the transcripts.
