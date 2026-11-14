/**
 * The digest of a field's live value (X71). The inbox keeps this digest in a Sanity draft's `before` (never
 * the client's text), and the writer recomputes it from what the content system holds now: a different
 * digest means someone edited the field since the fix was proposed, and the draft is refused.
 *
 * The text hashed is canonical JSON: object keys sorted (by code unit) at every depth, no spaces, array
 * order kept. A field that is missing hashes as `null`, the same as a field set to null.
 */
import { createHash } from "node:crypto";

const MAX_DEPTH = 64;

/** The canonical JSON text of a value parsed from JSON. Throws TypeError for anything JSON cannot hold. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new TypeError("value is nested too deeply");
  if (value === undefined || value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("number is not finite");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value))
        return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
      return `{${Object.keys(value)
        .sort()
        .map(
          (k) =>
            `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], depth + 1)}`,
        )
        .join(",")}}`;
    default:
      throw new TypeError(`${typeof value} is not JSON`);
  }
}

/** SHA-256, lower-case hex, of the value's canonical JSON text. */
export function valueSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
