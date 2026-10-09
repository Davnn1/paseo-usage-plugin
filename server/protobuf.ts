/**
 * Minimal zero-dependency protobuf wire-format walker.
 *
 * Decodes enough of the wire format to navigate real blobs: varints,
 * length-delimited fields (recursed into when they parse as messages), and
 * fixed32/fixed64 skips. It never throws on malformed input - unknown or
 * invalid fields are skipped, so partially corrupt blobs still yield whatever
 * decodes cleanly.
 *
 * Extraction is path-based (e.g. "1.4.2" = field 1 message, field 4 message,
 * field 2 varint) so field meanings live in the extractor, not the walker.
 */

export type WireValue =
  | { kind: "varint"; value: number }
  | { kind: "bytes"; value: Uint8Array; children: WireMessage | null };

export type WireMessage = Map<number, WireValue[]>;

function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let i = pos;
  while (i < buf.length && shift <= 70) {
    const byte = buf[i];
    result += (byte & 0x7f) * 2 ** shift;
    i += 1;
    if ((byte & 0x80) === 0) return { value: result, next: i };
    shift += 7;
  }
  return null;
}

/** Parse a buffer into a field map. Returns an empty map on malformed input. */
export function walkProtobuf(buf: Uint8Array): WireMessage {
  const fields: WireMessage = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) break;
    pos = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (fieldNumber <= 0) break;

    if (wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v.next;
      push(fields, fieldNumber, { kind: "varint", value: v.value });
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      pos = len.next;
      const end = pos + len.value;
      if (end > buf.length) break;
      const bytes = buf.subarray(pos, end);
      pos = end;
      // Try to recurse; bytes that do not parse as a message stay leaf bytes.
      const children = tryParseMessage(bytes);
      push(fields, fieldNumber, { kind: "bytes", value: bytes, children });
    } else if (wireType === 5) {
      pos += 4; // fixed32: skip
    } else if (wireType === 1) {
      pos += 8; // fixed64: skip
    } else {
      break; // groups (3/4) are obsolete and unused here
    }
  }
  return fields;
}

function tryParseMessage(bytes: Uint8Array): WireMessage | null {
  if (bytes.length === 0) return null;
  // Heuristic: must parse fully with at least one field and leave nothing.
  const parsed = parseStrict(bytes);
  return parsed;
}

const MAX_DEPTH = 50;

function parseStrict(buf: Uint8Array, depth = 0): WireMessage | null {
  if (depth > MAX_DEPTH) return null;
  const fields: WireMessage = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) return null;
    pos = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (fieldNumber <= 0) return null;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) return null;
      pos = v.next;
      push(fields, fieldNumber, { kind: "varint", value: v.value });
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      if (!len) return null;
      pos = len.next;
      const end = pos + len.value;
      if (end > buf.length) return null;
      const bytes = buf.subarray(pos, end);
      pos = end;
      const children = bytes.length > 0 && looksLikeMessage(bytes) ? parseStrict(bytes, depth + 1) : null;
      push(fields, fieldNumber, { kind: "bytes", value: bytes, children });
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else {
      return null;
    }
  }
  return pos === buf.length && fields.size > 0 ? fields : null;
}

function looksLikeMessage(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const tag = readVarint(bytes, 0);
  if (!tag) return false;
  const wireType = tag.value & 7;
  return wireType === 0 || wireType === 2 || wireType === 1 || wireType === 5;
}

function push(fields: WireMessage, number: number, value: WireValue): void {
  const existing = fields.get(number);
  if (existing) existing.push(value);
  else fields.set(number, [value]);
}

/** Follow a dotted path (e.g. "1.4.2") and return the matching values. */
export function probePath(message: WireMessage, path: string): WireValue[] {
  const parts = path.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return [];
  let current: WireValue[] = [{ kind: "bytes", value: new Uint8Array(0), children: message }];
  for (const fieldNumber of parts) {
    const next: WireValue[] = [];
    for (const value of current) {
      if (value.kind !== "bytes" || !value.children) continue;
      const matches = value.children.get(fieldNumber);
      if (matches) next.push(...matches);
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

/** First varint at a path, or null. */
export function varintAt(message: WireMessage, path: string): number | null {
  const values = probePath(message, path);
  for (const value of values) {
    if (value.kind === "varint") return value.value;
  }
  return null;
}

/** First UTF-8 string at a path, or null. */
export function stringAt(message: WireMessage, path: string): string | null {
  const values = probePath(message, path);
  for (const value of values) {
    if (value.kind === "bytes") {
      try {
        return new TextDecoder("utf-8", { fatal: false }).decode(value.value);
      } catch {
        return null;
      }
    }
  }
  return null;
}
