/**
 * An interactive run's driver line, read from agy's local conversation
 * record. The fixture is a synthetic agy home (lib/agy-record.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decodeRaw } from "../../plugin/agy/telemetry/protobufRaw.mjs";
import { readConversationRecord, collectConversationUsage } from "../../plugin/agy/telemetry/conversationUsage.mjs";
import { collectDriverUsage } from "../../plugin/agy/collect-driver-usage.mjs";
import { buildHarnessManifest, describeManifest } from "../../plugin/agy/manifest.mjs";
import { agyHomeWith, bytes, generation, msg, str, T } from "./lib/agy-record.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the raw reader finds nested fields by number", () => {
  const f = decodeRaw(generation({ fresh: 5208, cached: 7434, thinking: 32, text: 61, step: 4 }));
  const get = (p) => f.find((x) => x.path === p)?.value;
  assert.equal(get(".1.17.2.2"), 5208);
  assert.equal(get(".1.17.2.5"), 7434);
  assert.equal(get(".1.17.2.3"), 93);
  assert.equal(get(".1.19"), "gemini-3.8-flash");
});

test("each model call's usage is read, dated through its step, and checked: output = thinking + text", async () => {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const home = agyHomeWith(project, [{ id: "c1", lastModified: "2026-10-13T10:30:00Z", steps: [T("2026-10-13T10:00:00Z"), T("2026-10-13T10:05:00Z")],
    gens: [{ fresh: 10639, thinking: 198, text: 68, step: 0 }, { fresh: 5208, cached: 7434, thinking: 32, text: 61, step: 1 }, { fresh: 10, thinking: 1, text: 1, step: 99 }] }]);
  try {
    const calls = await readConversationRecord(join(home, "conversations", "c1.db"));
    assert.deepEqual(calls.map((c) => [c.fresh, c.cached, c.output, c.thinking]), [[10639, 0, 266, 198], [5208, 7434, 93, 32], [10, 0, 2, 1]]);
    assert.equal(calls[1].at, "2026-10-13T10:05:00.000Z");
    assert.equal(calls[2].at_inferred, true, "a call whose step has no time takes the previous call's");
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test("a record whose output is not thinking + text is refused, never guessed at", async () => {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const home = agyHomeWith(project, [{ id: "c1", lastModified: "2026-10-13T10:30:00Z", steps: [T("2026-10-13T10:00:00Z")], gens: [{ fresh: 1, thinking: 10, text: 5, output: 99, step: 0 }] }]);
  try {
    await assert.rejects(() => readConversationRecord(join(home, "conversations", "c1.db")), /layout differs from the one check 18 read/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test("only this project's conversations, and only their calls inside the run's window, count", async () => {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "other-"));
  const home = agyHomeWith(project, [
    { id: "mine", lastModified: "2026-10-13T11:00:00Z", steps: [T("2026-10-12T09:00:00Z"), T("2026-10-13T10:10:00Z")], gens: [{ fresh: 999, thinking: 1, text: 1, step: 0 }, { fresh: 100, cached: 50, thinking: 5, text: 5, step: 1 }] },
    { id: "theirs", workspace: elsewhere, lastModified: "2026-10-13T11:00:00Z", steps: [T("2026-10-13T10:10:00Z")], gens: [{ fresh: 7, thinking: 1, text: 1, step: 0 }] },
    { id: "old", lastModified: "2026-10-01T00:00:00Z", steps: [T("2026-10-01T00:00:00Z")], gens: [{ fresh: 7, thinking: 1, text: 1, step: 0 }] },
  ]);
  try {
    const { conversations, calls } = await collectConversationUsage({ home, projectRoot: project, since: "2026-10-13T10:00:00Z", until: "2026-10-13T12:00:00Z" });
    assert.deepEqual(conversations.map((c) => c.id), ["mine"]);
    assert.deepEqual(calls.map((c) => c.fresh), [100], "yesterday's call in the same conversation is not this run's");
  } finally { for (const d of [home, project, elsewhere]) rmSync(d, { recursive: true, force: true }); }
});

test("the collected calls become the interactive run's modeled driver line, priced at the dated list", async () => {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const runDir = join(project, ".sdlc", "runs", "i1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "telemetry.jsonl"), "");
  const home = agyHomeWith(project, [{ id: "c1", lastModified: "2026-10-13T11:00:00Z", steps: [T("2026-10-13T10:10:00Z")], gens: [{ fresh: 1_000_000, cached: 1_000_000, thinking: 500_000, text: 500_000, step: 0 }] }]);
  try {
    const { modeled, evidence } = await collectDriverUsage({ runDir, runId: "i1", projectRoot: project, since: "2026-10-13T10:00:00Z", until: "2026-10-13T12:00:00Z", home, version: "1.3.5" });
    assert.equal(modeled.length, 1);
    assert.deepEqual([modeled[0].input_tokens, modeled[0].input_tokens_cached, modeled[0].output_tokens, modeled[0].output_tokens_reasoning], [1_000_000, 1_000_000, 1_000_000, 500_000]);
    assert.equal(modeled[0].cost_usd, 0.75 + 0.075 + 3.75, "the Gemini 3.8 Flash card in force on 2026-10-13");
    assert.equal(evidence.calls, 1);
    assert.equal(evidence.model_mismatch, undefined);
    writeFileSync(join(runDir, "driver-cost-modeled.jsonl"), modeled.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(join(runDir, "driver-collector.json"), JSON.stringify(evidence));
    const m = buildHarnessManifest({ runDir, runId: "i1", policyName: "antigravity-flash38-plus-opus5", env: {} });
    assert.equal(m.cost.lines[0].kind, "modeled", "measured from the record, no longer NOT MEASURED");
    assert.match(m.cost.lines[0].basis, /agy's local conversation record/);
    assert.equal(m.cost.driver_modeled_usd, 4.575);
    assert.equal(m.harness.driver_collector.calls, 1);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

// ── each call priced at its own model's card ──
const BIG = { fresh: 1_000_000, cached: 1_000_000, thinking: 500_000, text: 500_000 };
const CARD_38 = 0.75 + 0.075 + 3.75;
const CARD_35 = 1.5 + 0.15 + 9;

/** A run folder with the shipped policy snapshotted, and one chat whose calls ran on `models`. */
async function collected(models) {
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const runDir = join(project, ".sdlc", "runs", "i1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "telemetry.jsonl"), "");
  copyFileSync(join(ROOT, "plugin", "config", "policies", "antigravity-flash38-plus-opus5.yaml"), join(runDir, "policy_snapshot.yaml"));
  const home = agyHomeWith(project, [{ id: "c1", lastModified: "2026-10-13T11:00:00Z", steps: models.map((_, i) => T("2026-10-13T10:10:00Z") + i), gens: models.map((model, i) => ({ model, ...BIG, step: i })) }]);
  const { modeled, evidence } = await collectDriverUsage({ runDir, runId: "i1", projectRoot: project, since: "2026-10-13T10:00:00Z", until: "2026-10-13T12:00:00Z", home, version: "1.3.5" });
  writeFileSync(join(runDir, "driver-cost-modeled.jsonl"), modeled.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(runDir, "driver-collector.json"), JSON.stringify(evidence));
  const manifest = buildHarnessManifest({ runDir, runId: "i1", env: {} });
  return { modeled, evidence, manifest, runDir, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); } };
}

test("a record whose every call is the pin is priced as before: complete, at the pin's card", async () => {
  const r = await collected(["gemini-3.8-flash", "gemini-3.8-flash"]);
  try {
    assert.deepEqual(r.modeled.map((e) => [e.model, e.cost_usd, e.price_basis, e.unpriced]), [["gemini-3.8-flash", CARD_38, "list", undefined], ["gemini-3.8-flash", CARD_38, "list", undefined]]);
    assert.equal(r.evidence.unpriced_calls, undefined);
    assert.equal(r.evidence.model_mismatch, undefined);
    const line = r.manifest.cost.lines[0];
    assert.equal(line.cost_usd, 9.15);
    assert.equal(line.incomplete, undefined);
    assert.match(line.basis, /at the dated price list for gemini-3\.8-flash \(period 2026-09-02\.\.2026-12-31\) \(seat\); thinking at the output rate, cache reads at the cached rate$/);
    assert.equal(r.manifest.cost.driver_modeled_usd_is_floor, undefined);
    assert.match(describeManifest(r.manifest, null), /driver modeled \$9\.15$/);
    assert.equal(r.manifest.harness.pin.verified, true);
  } finally { r.cleanup(); }
});

test("an off-pin call on a model the list prices is billed at that model's own dated card, not the pin's", async () => {
  const r = await collected(["gemini-3.8-flash", "gemini-3.5-flash"]);
  try {
    assert.deepEqual(r.modeled.map((e) => [e.model, e.cost_usd]), [["gemini-3.8-flash", CARD_38], ["gemini-3.5-flash", CARD_35]]);
    assert.deepEqual([r.modeled[1].price_period.from, r.modeled[1].price_period.to], ["2026-05-19", null]);
    assert.deepEqual(r.evidence.model_mismatch, ["gemini-3.5-flash"]);
    assert.equal(r.evidence.unpriced_calls, undefined, "every call has a price");
    const line = r.manifest.cost.lines[0];
    assert.equal(line.cost_usd, Math.round((CARD_38 + CARD_35) * 1e6) / 1e6);
    assert.equal(line.incomplete, undefined);
    assert.deepEqual(line.models, ["gemini-3.8-flash", "gemini-3.5-flash"]);
    assert.match(line.basis, /dated price list for gemini-3\.8-flash and gemini-3\.5-flash \(period 2026-09-02\.\.2026-12-31, 2026-05-19\.\.open\)/);
    assert.deepEqual([r.manifest.harness.pin.verified, r.manifest.harness.pin.unverified_reason], [false, "model_mismatch"]);
  } finally { r.cleanup(); }
});

test("an off-pin call on a model the list cannot price keeps its tokens, has no dollars, and makes the driver line a floor", async () => {
  const r = await collected(["gemini-3.8-flash", "gemini-4-argon", "gemini-4-argon"]);
  try {
    const argon = r.modeled.filter((e) => e.model === "gemini-4-argon");
    assert.equal(argon.length, 2);
    for (const e of argon) {
      assert.equal(e.cost_usd, null, "unpriced, never $0");
      assert.match(e.unpriced, /unknown model "gemini-4-argon": not on the price list/);
      assert.equal(e.price_basis, undefined);
      assert.equal(e.input_tokens, 1_000_000);
    }
    assert.equal(r.evidence.priced_in_full, false);
    assert.deepEqual(r.evidence.unpriced_calls.map((u) => [u.model, u.calls]), [["gemini-4-argon", 2]]);
    assert.match(r.evidence.unpriced_calls[0].reason, /not on the price list/);

    const line = r.manifest.cost.lines[0];
    assert.equal(line.kind, "modeled");
    assert.equal(line.incomplete, true);
    assert.equal(line.cost_usd, CARD_38, "the floor: the priced call only");
    assert.deepEqual([line.calls, line.input_tokens], [3, 3_000_000], "the unpriced calls' tokens are counted");
    assert.match(line.basis, /AT LEAST this figure: 2 of 3 call\(s\) ran on a model the price list cannot price \(gemini-4-argon, 2 call\(s\)\)/);
    assert.equal(r.manifest.cost.driver_modeled_usd_is_floor, true);
    assert.equal(r.manifest.harness.driver_cost_is_floor, true);
    assert.deepEqual(r.manifest.harness.driver_unpriced_calls.map((u) => [u.model, u.calls]), [["gemini-4-argon", 2]]);
    assert.match(r.manifest.harness.cable.driver_cost_note, /It is a floor, not the whole figure: 2 call\(s\) on gemini-4-argon/);
    assert.match(describeManifest(r.manifest, null), /driver modeled at least \$4\.575 \(2 of 3 call\(s\) unpriced: gemini-4-argon\)$/);
  } finally { r.cleanup(); }
});

test("a chat that ran wholly on an unpriced model shows its tokens and a $0 floor, never a complete $0", async () => {
  const r = await collected(["gemini-4-argon", "gemini-4-argon"]);
  try {
    const line = r.manifest.cost.lines[0];
    assert.deepEqual([line.cost_usd, line.incomplete, line.calls], [0, true, 2]);
    assert.match(line.basis, /at no card: the price list prices none of the models agy recorded/);
    assert.match(describeManifest(r.manifest, null), /driver modeled at least \$0 \(2 of 2 call\(s\) unpriced: gemini-4-argon\)/);
  } finally { r.cleanup(); }
});

test("a headless run is refused: its driver comes from the stream run.mjs captured", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-"));
  try {
    writeFileSync(join(runDir, "driver-manifest.json"), "{}");
    await assert.rejects(() => collectDriverUsage({ runDir, runId: "h", projectRoot: runDir, since: "2026-10-13T00:00:00Z", until: "2026-10-14T00:00:00Z", home: runDir }), /headless launcher record/);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("a headless run's stream reading is cross-checked against the same conversation's local record", async () => {
  const { crossCheckLocalRecord } = await import("../../plugin/agy/run.mjs");
  const project = mkdtempSync(join(tmpdir(), "proj-"));
  const home = agyHomeWith(project, [{ id: "conv-h", lastModified: "2026-10-13T11:00:00Z", steps: [T("2026-10-13T10:10:00Z")], gens: [{ fresh: 600, cached: 400, thinking: 50, text: 200, step: 0 }] }]);
  try {
    const booked = [{ input_tokens: 600, input_tokens_cached: 400, output_tokens: 250, output_tokens_reasoning: 50 }];
    const agree = await crossCheckLocalRecord({ conversationId: "conv-h", since: "2026-10-13T10:00:00Z", modeled: booked, home });
    assert.equal(agree.agrees, true);
    assert.deepEqual(agree.models, ["gemini-3.8-flash"], "the record's .1.19 names the model that conducted");
    const off = await crossCheckLocalRecord({ conversationId: "conv-h", since: "2026-10-13T10:00:00Z", modeled: [{ ...booked[0], input_tokens: 200 }], home });
    assert.equal(off.agrees, false, "a stream reading that subtracted the cache reads twice is caught");
    assert.deepEqual(await crossCheckLocalRecord({ conversationId: "absent", since: "2026-10-13T10:00:00Z", modeled: booked, home }), { found: false });
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test("a short text value that also parses as a message is read as text where text is expected", () => {
  // "85" is 0x38 0x35: field 7, varint 53 — a valid message.
  const meta = msg(bytes(1, msg(bytes(20, msg(str(1, "last_step_index"), str(2, "85"))))));
  assert.equal(decodeRaw(meta).find((f) => f.path === ".1.20.2"), undefined, "untold, it decodes as a nested message");
  assert.equal(decodeRaw(meta, { textPaths: new Set([".1.20.2"]) }).find((f) => f.path === ".1.20.2").value, "85");
});
