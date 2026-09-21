# Your first `/mmo:greenfield`

Twenty minutes end to end. You set up the plugin, prove the whole chain offline for $0, run it against the shipped one-endpoint demo brief, and end with a small Express app in `./src/`, per-phase telemetry, and a cost report with three labeled lines.

**For:** anyone who has not run the harness before. Follow along top to bottom, no branching.

## What you'll need

- **Node.js 20+**, the **Antigravity CLI** (`agy` ≥ 1.2.3, signed in to a Google account) and **Claude Code** (`claude`). Verify with `node --version`, `agy models` and `claude --version`.
- **A Claude wallet.** Cheapest for a first run: Claude Code signed in to a claude.ai subscription (`claude auth status` shows `authMethod: claude.ai`). The Opus line is then modeled, not billed. An `ANTHROPIC_API_KEY` with a few dollars of budget works too and makes it cash.
- **A Gemini door.** A `GEMINI_API_KEY` from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), or Application Default Credentials from `gcloud auth application-default login`. There is no all-Claude preset on this harness — the conductor itself is Gemini, and so is the mechanical tier.

Export the key(s) in the shell you will start `agy` from. The bridge inherits them from there and nowhere else.

## 1. Set up the plugin

Make an empty folder, open `agy` in it, and paste this exact prompt:

```bash
mkdir first-run && cd first-run && agy
```

```
Set up this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-antigravity-harness, branch feat/antigravity-harness-implementation
```

agy follows [INSTALL.md](../INSTALL.md): it clones the harness next to your folder, builds the bridge, checks `agy`, `claude` and your credentials, asks about the Antigravity SDK agent path only if Vertex ADC is present (say no on a first run), mounts the plugin into your folder as `.agents/plugins/mmo/`, and opens a browser tab for the policy pick. Click **Save** on `antigravity-flash38-plus-opus5` — the one shipped policy: Gemini 3.8 Flash conducts, Opus 5 judges, Flash executes, capped at $50.

Total time: about three minutes on a fresh laptop. Nothing has been spent yet.

## 2. Prove the chain for $0

From the harness clone, run the offline smoke run. It drives the whole thing — the launcher, the resume loop, the dispatch fallback, one real bridge call, the manifest — against a stub `agy` that speaks the recorded stream-json shapes:

```bash
cd ../ai-sdlc-orchestrator-antigravity-harness
mkdir -p /tmp/smoke && cp examples/quick-demo/brief.md /tmp/smoke/brief.md
npm run smoke -- --project-root=/tmp/smoke --output-dir=/tmp/smoke/.sdlc --run-id=smoke1
node tools/report.mjs /tmp/smoke/.sdlc
```

The report prints a **Dispatched work — vendor-metered** table with one zero-cost row, and a **Driver loop — modeled, not measured** section with two turns and a few tenths of a cent. Every figure is made up by the stub and labeled so; what you have proved is that nothing in the chain is missing. Read [understanding-output.md](understanding-output.md) with `/tmp/smoke/.sdlc/manifest.json` open if you want to see the three-line `cost` block before a real run fills it.

## 3. Open a NEW session in the folder

Skills, rules, hooks and the bridge load when a session starts, in a trusted workspace. The session that set up the plugin does not see `/mmo:greenfield`. Open a fresh one:

```bash
cd ../first-run && agy
```

Answer **yes** when agy asks whether you trust the folder. `/skills` now lists the `mmo:` entries.

## 4. Kick off the run

At the agy prompt:

```
/mmo:greenfield
```

The skill takes no arguments — it asks. It checks the install first, then:

1. **Which brief?** Pick the shipped **quick-demo** brief (a one-endpoint ping service on Express, no database). It is the cheapest and fastest option and the best way to see every phase, both tiers and all four gates.
2. **Where does the output go?** Confirm `./src/` for the app and `./.sdlc/` for the record.
3. **Telemetry mode.** There is one on this runtime: `vendor`. Every call goes through the bridge on real credentials and the numbers are what the vendor reports.

Before any money is spent, the conductor shows you the phase list, the model each phase will run on and the effective prices (the pricing preflight). Confirm to proceed. This is the last free moment.

## 5. Approve at the human-in-the-loop gates

The pipeline pauses at four points:

- **Gate 1** — after `requirements.md` is written (by Opus 5, through the bridge).
- **Gate 2** — after `design.md` is written.
- **Gate 3** — after `security_review.md` is written.
- **Gate 4** — after the final report.

At each gate, the artifact prints on screen. Read it, then approve to continue or type feedback to redirect the phase. For the quick-demo brief you can approve every gate as-is. Each decision is appended to `.sdlc/gates.jsonl`.

**Wall-clock for the whole run:** minutes for quick-demo. Longer briefs (`workforce-ops`, `travel-ops`) take an hour or more.

## 6. When it finishes

The record lives under `.sdlc/` and the app under `./src/`. From the harness clone, render the report:

```bash
node tools/report.mjs ../first-run/.sdlc
```

Then rebuild the manifest with the wallet stamped (the conductor prints this command as its last step in an interactive run):

```bash
node plugin/agy/manifest.mjs ../first-run/.sdlc --policy=antigravity-flash38-plus-opus5
```

What you are looking at:

- **Dispatched work — vendor-metered** — one row per phase, tokens in / out, cost. The judgment rows ran on Opus 5 through `claude -p`; the mechanical rows on Gemini 3.8 Flash. On the seat the Opus tokens are real and the dollars are modeled — `manifest.json` → `cost.claude_seat_modeled_usd` says so.
- **Driver loop — modeled, not measured** — on an interactive run this section reads _No driver turns recorded._, because agy exposes no `usage` counters to a plugin. Headless runs through `run.mjs` fill it.
- **`manifest.json` → `cost.lines`** — the three lines, each with `kind: "cash"` or `"modeled"`, and the note that they are not summed.

Every dispatched call is in `.sdlc/telemetry.jsonl` for audit. Every field is documented in [understanding-output.md](understanding-output.md).

## 7. Try the generated app

The `./src/` tree is a runnable Express project. From `first-run`:

```bash
cd src
npm install
npm start
```

Then `curl http://localhost:3000/ping` — `{ "status": "ok", "time": "…" }` is what the brief asked for.

## 8. The measured version

An interactive run has no driver line. The run of record goes through the headless launcher, which pins the conductor's model and effort, answers the gates itself, and prices every conductor turn from the stream:

```bash
node plugin/agy/run.mjs --brief=examples/quick-demo/brief.md --project-root=/tmp/demo --output-dir=/tmp/demo/.sdlc --gates=auto-approve --run-id=quick-demo-1 --dry-run
```

`--dry-run` prints the pinned invocation with every credential reported as set/unset. Drop it to run. [running.md](running.md) has every flag, the pin gate and the resume loop.

## What next

- **Understand the numbers.** [understanding-output.md](understanding-output.md) walks every field in the two JSONL files, the manifest and the report.
- **Understand the cost model.** [methodology.md](methodology.md) explains the three lines and why modeled and cash dollars are never added.
- **Tune the policy.** `/mmo:policy change` opens the console; a copy you save there keeps the driver pin and can change the per-phase routing or the cap.
- **Run on an existing repo.** [brownfield.md](brownfield.md) covers `/mmo:brownfield`, which extends real code with a non-destructive write contract.

**See also:** [setup.md](setup.md) · [running.md](running.md) · [troubleshooting.md](troubleshooting.md)
