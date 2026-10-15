/**
 * The conductor's own usage, read from agy's local conversation record:
 * `~/.gemini/antigravity-cli/conversations/<conversation-id>.db`, one SQLite
 * database per conversation, whose `gen_metadata` rows hold one protobuf per
 * model call. An interactive session exposes no usage to the plugin
 * (no stream, no hook field, `/usage` reports quota only), so this record is
 * where an interactive run's driver line comes from.
 *
 * The record's format is agy's, undocumented, and read by field number
 * (p1-agy-runtime.md check 18, agy 1.3.0). Every row is checked against the
 * one identity the reading rests on — output = thinking + text — and a
 * record that breaks it is refused, never guessed at. The databases are
 * copied to a temporary folder and opened read-only; nothing under
 * ~/.gemini is written.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { decodeRaw } from "./protobufRaw.mjs";

/** The field numbers check 18 read. `verified_on` is the agy version they were read from. */
export const LOCAL_RECORD_FIELDS = Object.freeze({
  verified_on: "1.3.5",
  model: ".1.19",
  usage: ".1.17.2",
  fresh_input: 2,
  cache_read: 5,
  output: 3,
  thinking: 9,
  text: 10,
  meta_key: ".1.20.1",
  meta_value: ".1.20.2",
  step_time: ".1.1",
});

const TEXT_PATHS = new Set([LOCAL_RECORD_FIELDS.model, LOCAL_RECORD_FIELDS.meta_key, LOCAL_RECORD_FIELDS.meta_value]);

export function agyHome(env = process.env, home = homedir()) {
  return env.MMO_AGY_HOME ? resolve(env.MMO_AGY_HOME) : join(home, ".gemini", "antigravity-cli");
}

async function openCopy(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "agy-record-"));
  const copy = join(dir, "record.db");
  copyFileSync(path, copy);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix);
  const db = new DatabaseSync(copy, { readOnly: true });
  return { db, close: () => { try { db.close(); } finally { rmSync(dir, { recursive: true, force: true }); } } };
}

function usageOf(fields) {
  const F = LOCAL_RECORD_FIELDS;
  const u = {};
  for (const f of fields) {
    if (f.type !== "int" || !f.path.startsWith(`${F.usage}.`)) continue;
    const n = Number(f.path.slice(F.usage.length + 1));
    if (Number.isInteger(n)) u[n] = Number(f.value);
  }
  return u;
}

function metaOf(fields) {
  const meta = {};
  let key = null;
  for (const f of fields) {
    if (f.path === LOCAL_RECORD_FIELDS.meta_key && f.type === "str") key = f.value;
    else if (f.path === LOCAL_RECORD_FIELDS.meta_value && key !== null) { meta[key] = f.value; key = null; }
  }
  return meta;
}

/**
 * Every model call one conversation record holds: `{ model, fresh, cached,
 * output, thinking, at }`, `at` the ISO time of the step it belongs to (null
 * when the step has none). Throws when a row breaks the layout check.
 */
export async function readConversationRecord(dbPath) {
  const F = LOCAL_RECORD_FIELDS;
  const { db, close } = await openCopy(dbPath);
  try {
    const stepTime = new Map();
    for (const row of db.prepare("SELECT idx, metadata FROM steps").all()) {
      const t = (decodeRaw(row.metadata) ?? []).find((f) => f.path === F.step_time && f.type === "int");
      if (t) stepTime.set(Number(row.idx), new Date(Number(t.value) * 1000).toISOString());
    }
    const calls = [];
    for (const row of db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").all()) {
      const fields = decodeRaw(row.data, { textPaths: TEXT_PATHS });
      if (!fields) throw new Error(`gen_metadata row ${row.idx} is not a protobuf message`);
      const u = usageOf(fields);
      if (u[F.output] === undefined) continue;
      const thinking = u[F.thinking] ?? 0;
      if (u[F.text] !== undefined && u[F.output] !== thinking + u[F.text]) {
        throw new Error(`gen_metadata row ${row.idx}: output ${u[F.output]} is not thinking ${thinking} + text ${u[F.text]}; the record's layout differs from the one check 18 read (agy ${F.verified_on})`);
      }
      const meta = metaOf(fields);
      const step = meta.last_step_index !== undefined ? Number(meta.last_step_index) : null;
      calls.push({
        index: Number(row.idx),
        model: fields.find((f) => f.path === F.model && f.type === "str")?.value ?? null,
        fresh: u[F.fresh_input] ?? 0,
        cached: u[F.cache_read] ?? 0,
        output: u[F.output],
        thinking,
        at: step !== null ? stepTime.get(step) ?? null : null,
      });
    }
    // A call whose step carries no time takes the time of the nearest dated call before it (else after it).
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].at) continue;
      const near = calls.slice(0, i).reverse().find((c) => c.at && !c.at_inferred) ?? calls.slice(i + 1).find((c) => c.at);
      if (near) { calls[i].at = near.at; calls[i].at_inferred = true; }
    }
    return calls;
  } finally {
    close();
  }
}

/**
 * Conversations agy recorded for this project that were active after `since`:
 * the summaries database's rows whose workspace is the project root.
 */
export async function projectConversations(home, projectRoot, since) {
  const summaries = join(home, "conversation_summaries.db");
  if (!existsSync(summaries)) return [];
  const root = pathToFileURL(resolve(projectRoot)).href.replace(/\/$/, "");
  const { db, close } = await openCopy(summaries);
  try {
    return db.prepare("SELECT conversation_id, workspace_uris, last_modified_time, parent_conversation_id FROM conversation_summaries").all()
      .filter((r) => {
        let uris = [];
        try { uris = JSON.parse(r.workspace_uris); } catch { uris = []; }
        return uris.some((u) => String(u).replace(/\/$/, "") === root) && Date.parse(r.last_modified_time) >= Date.parse(since);
      })
      .map((r) => ({ id: r.conversation_id, parent: r.parent_conversation_id || null, last_modified: r.last_modified_time }));
  } finally {
    close();
  }
}

/**
 * The model calls of the given conversations (or this project's, found
 * through the summaries) inside [since, until]. `inferred` counts the calls
 * dated from a neighbouring call because their own step carries no time.
 */
export async function collectConversationUsage({ home = agyHome(), projectRoot, conversationIds = null, since, until = new Date().toISOString() }) {
  const ids = conversationIds ?? (await projectConversations(home, projectRoot, since)).map((c) => c.id);
  const lo = Date.parse(since);
  const hi = Date.parse(until);
  const conversations = [];
  const calls = [];
  for (const id of ids) {
    const path = join(home, "conversations", `${id}.db`);
    if (!existsSync(path)) { conversations.push({ id, found: false }); continue; }
    const all = await readConversationRecord(path);
    const inside = all.filter((c) => c.at && Date.parse(c.at) >= lo && Date.parse(c.at) <= hi);
    conversations.push({ id, found: true, calls: inside.length, inferred: inside.filter((c) => c.at_inferred).length, undated: all.filter((c) => !c.at).length });
    for (const c of inside) calls.push({ ...c, conversation_id: id });
  }
  return { conversations, calls };
}
