/**
 * A synthetic agy home in the layout agy keeps (p1-agy-runtime.md check 18):
 * a summaries database naming each conversation's workspace, and one SQLite
 * database per conversation whose gen_metadata rows are protobufs holding each
 * model call's usage. Built under the OS temp dir; never the real ~/.gemini.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { DatabaseSync } = await import("node:sqlite");

// A minimal protobuf writer, enough for the fields the reader takes.
const varint = (n) => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
export const int = (field, n) => Buffer.concat([varint((field << 3) | 0), varint(n)]);
export const bytes = (field, buf) => Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
export const str = (field, s) => bytes(field, Buffer.from(s, "utf8"));
export const msg = (...parts) => Buffer.concat(parts);

export function generation({ model = "gemini-3.8-flash", fresh, cached = 0, thinking, text, step, output = thinking + text }) {
  const usage = msg(int(1, 1318), int(2, fresh), int(3, output), ...(cached ? [int(5, cached)] : []), int(6, 3), int(9, thinking), int(10, text));
  return msg(bytes(1, msg(bytes(17, bytes(2, usage)), str(19, model), bytes(20, msg(str(1, "last_step_index"), str(2, String(step)))))));
}
const stepMeta = (epochSeconds) => msg(bytes(1, int(1, epochSeconds)));

/** `conversations`: `{ id, lastModified, workspace?, steps: [epoch seconds], gens: [generation() args] }`. */
export function agyHomeWith(projectRoot, conversations) {
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  mkdirSync(join(home, "conversations"));
  const sum = new DatabaseSync(join(home, "conversation_summaries.db"));
  sum.exec("CREATE TABLE conversation_summaries (conversation_id text, workspace_uris text, last_modified_time datetime, parent_conversation_id text)");
  for (const c of conversations) {
    sum.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, '')").run(c.id, JSON.stringify([pathToFileURL(c.workspace ?? projectRoot).href]), c.lastModified);
    const db = new DatabaseSync(join(home, "conversations", `${c.id}.db`));
    db.exec("CREATE TABLE steps (idx integer, metadata blob); CREATE TABLE gen_metadata (idx integer, data blob, size integer)");
    c.steps.forEach((t, i) => db.prepare("INSERT INTO steps VALUES (?, ?)").run(i, stepMeta(t)));
    c.gens.forEach((g, i) => db.prepare("INSERT INTO gen_metadata VALUES (?, ?, 0)").run(i, generation(g)));
    db.close();
  }
  sum.close();
  return home;
}

export const T = (iso) => Math.floor(Date.parse(iso) / 1000);
