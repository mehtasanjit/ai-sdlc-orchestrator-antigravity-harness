/**
 * A schema-less protobuf reader: every field as `{ path, type, value }`, with
 * nested messages flattened into dotted field-number paths (".1.17.2").
 * agy publishes no schema for its conversation records, so the fields are
 * read by number. A length-delimited field is tried as a nested message
 * first, then as UTF-8 text, then left as a byte count.
 */

function varint(buf, at) {
  let result = 0n;
  let shift = 0n;
  for (let i = at; i < buf.length; i++) {
    const b = buf[i];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (b < 0x80) return [result, i + 1];
    if (shift > 70n) break;
  }
  throw new RangeError("truncated varint");
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeInto(buf, path, depth, out) {
  let at = 0;
  const fields = [];
  while (at < buf.length) {
    const [key, next] = varint(buf, at);
    at = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new RangeError("field 0");
    const p = `${path}.${field}`;
    if (wire === 0) {
      const [v, n] = varint(buf, at);
      at = n;
      fields.push({ path: p, type: "int", value: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v });
    } else if (wire === 1) {
      if (at + 8 > buf.length) throw new RangeError("truncated fixed64");
      fields.push({ path: p, type: "fixed64", value: buf.readBigUInt64LE(at) });
      at += 8;
    } else if (wire === 5) {
      if (at + 4 > buf.length) throw new RangeError("truncated fixed32");
      fields.push({ path: p, type: "fixed32", value: buf.readUInt32LE(at) });
      at += 4;
    } else if (wire === 2) {
      const [len, n] = varint(buf, at);
      at = n;
      const end = at + Number(len);
      if (end > buf.length) throw new RangeError("truncated bytes");
      const sub = buf.subarray(at, end);
      at = end;
      const nested = [];
      if (depth < 8 && sub.length > 0 && tryDecode(sub, p, depth + 1, nested)) fields.push(...nested);
      else {
        let text = null;
        try { text = UTF8.decode(sub); } catch { text = null; }
        fields.push(text !== null ? { path: p, type: "str", value: text } : { path: p, type: "bytes", value: sub.length });
      }
    } else {
      throw new RangeError(`wire type ${wire}`);
    }
  }
  out.push(...fields);
}

function tryDecode(buf, path, depth, out) {
  try {
    decodeInto(buf, path, depth, out);
    return true;
  } catch {
    return false;
  }
}

/** Every field of a message, or null when the bytes are not a message. */
export function decodeRaw(bytes) {
  const out = [];
  return tryDecode(Buffer.from(bytes ?? []), "", 0, out) ? out : null;
}
