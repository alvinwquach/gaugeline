/**
 * Canonical JSON for approval receipts (AG-06): one text for one value, so a hash over it means the same
 * thing on every machine. The rules, a strict subset of RFC 8785 (JSON Canonicalization Scheme):
 *
 *  - object keys sorted by UTF-16 code unit, as JavaScript's default sort compares strings;
 *  - no whitespace between tokens;
 *  - strings as JSON.stringify writes them (", \ and the controls below U+0020 escaped, everything else
 *    as itself), hashed as UTF-8 bytes; a lone surrogate cannot be UTF-8, so it is refused;
 *  - numbers are safe integers only (|n| <= 2^53 - 1): no fraction, no exponent, no NaN or Infinity,
 *    so no two programs can print one differently. -0 prints as 0;
 *  - null, true, false, arrays and plain objects; undefined, bigint, functions, symbols, Dates, Maps
 *    and cycles are refused rather than dropped or guessed at.
 *
 * Pure: no I/O, no clock.
 */
import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const MAX_DEPTH = 32;
/** In a /u regex, a surrogate class matches only a surrogate that is not half of a pair. */
const LONE_SURROGATE = /[\ud800-\udfff]/u;

function str(s: string, where: string): string {
  if (LONE_SURROGATE.test(s))
    throw new CanonicalJsonError(`${where}: a lone surrogate is not text`);
  return JSON.stringify(s);
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(v: unknown, where: string, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError(`${where}: nested too deep`);
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      return str(v, where);
    case "number":
      if (!Number.isSafeInteger(v))
        throw new CanonicalJsonError(
          `${where}: only whole numbers up to 2^53 - 1, not ${String(v)}`,
        );
      return Object.is(v, -0) ? "0" : String(v);
    case "object": {
      if (seen.has(v)) throw new CanonicalJsonError(`${where}: refers to itself`);
      seen.add(v);
      let out: string;
      if (Array.isArray(v)) {
        out = `[${v.map((x, i) => write(x, `${where}[${i}]`, depth + 1, seen)).join(",")}]`;
      } else if (isPlainObject(v)) {
        const keys = Object.keys(v).sort();
        out = `{${keys
          .map((k) => `${str(k, `${where} key`)}:${write(v[k], `${where}.${k}`, depth + 1, seen)}`)
          .join(",")}}`;
      } else {
        throw new CanonicalJsonError(`${where}: only plain objects and arrays`);
      }
      seen.delete(v);
      return out;
    }
    default:
      throw new CanonicalJsonError(`${where}: ${typeof v} has no JSON form`);
  }
}

/** The canonical JSON text of `value`. Throws CanonicalJsonError for anything outside the rules above. */
export function canonicalJson(value: unknown): string {
  return write(value, "value", 0, new Set());
}

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lower-case hex digits. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
