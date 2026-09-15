# SETUP.md

Credentials, arms and the pricing preflight. INSTALL.md gets the plugin discovered; this file gets a run paid for correctly.

## The two Claude arms

Both arms run the same policy file and the same `claude-cli` adapter. The arm is the environment the bridge is launched with.

| | Arm A | Arm B |
|---|---|---|
| Wallet | Anthropic API key | GCP project, Google's invoice, Google's published Claude rates |
| Env | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_USE_VERTEX=1` `ANTHROPIC_VERTEX_PROJECT_ID` `CLOUD_ML_REGION=global` + ADC |
| Cost of record | `claude -p` result priced from the dated price list (Anthropic card) | tokens from the same result × the Vertex Claude card; the GCP invoice is the receipt |
| Gate | key present | project active, Claude enabled in Model Garden (24–48 h approval), `roles/aiplatform.user`, quota in region |

Re-test arm B with `claude -p --model claude-opus-5 'say ok'` under the arm-B env. A `403` names the project state; a `404 model not found` means Model Garden has not enabled Claude yet.

## Gemini worker doors

| Door | Adapter | Credential |
|---|---|---|
| `flash-completion` | `mcp:model-dispatch` | `GEMINI_API_KEY`, or Vertex ADC when unset |
| `flash-agsdk-worker` | `antigravity-worker` | Vertex ADC only |

Pick one per study with `SDLC_SELECT=gemini-flash=<door>` and pin it in the run record. While the GCP project is suspended only `flash-completion` on `GEMINI_API_KEY` runs.

## Driver billing

The conductor runs on your Google seat by default: no invoice exists, so its cost line is **modeled** from agy's `usage` counters at the driver block's card and labeled so. A metered driver (`modelProvider: "gemini"` + `GEMINI_API_KEY`) requires editing `~/.gemini/antigravity-cli/settings.json`, which the standing rules exclude; if a study needs it, record the decision in the run manifest.

## Before any paid run

1. `npm test` passes.
2. `preflight_dispatch` with `auth_mode: vendor` reports `ok: true` for the policy.
3. The pricing blocks in the policy match `plugin/mcp/model-dispatch/src/prices.ts` (test/prices.test.mjs enforces it).
4. An explicit go from the study owner.

First paid run: `examples/quick-demo/brief.md` under `antigravity-flash38-plus-haiku45` to prove the wiring, then under `antigravity-flash38-plus-opus5`.
