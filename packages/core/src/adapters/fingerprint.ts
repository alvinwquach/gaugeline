import { createHash } from "node:crypto";
import type { PublishedDoc } from "./types.js";

/** How many hex characters of the hash are kept: 64 bits, enough to tell a changed field from an unchanged one. */
const HASH_HEX = 16;

/** The value as JSON with object keys in order, so the same content always gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * The fingerprint of one field's value: a truncated SHA-256 of its canonical JSON. The value is read
 * only to be hashed here, and neither it nor the hash's input is kept. Null and undefined are "no
 * value", which the caller leaves out of `fieldHashes` rather than hashing as empty.
 */
export function hashValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, HASH_HEX);
}

const PLACEHOLDER = /\{(slug|id)\}/g;

/** Is this a template the settings may hold: a path or an https address, with only {slug} and {id} to fill in. */
export function isUrlTemplate(text: string): boolean {
  if (/\s/.test(text) || !(text.startsWith("/") || text.startsWith("https://"))) return false;
  return !/[{}]/.test(text.replace(PLACEHOLDER, ""));
}

/**
 * "/blog/{slug}" for an item: its slug and id, percent-encoded. An empty string when the template
 * needs a slug the item does not have, so no address is ever made up.
 */
export function fillUrlTemplate(template: string, doc: Pick<PublishedDoc, "id" | "slug">): string {
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_m, name: string) => {
    const value = name === "slug" ? doc.slug : doc.id;
    // "." and ".." are dot segments: "/blog/.." is "/", another page, so they are no address at all.
    if (value === undefined || value === "" || value === "." || value === "..") {
      missing = true;
      return "";
    }
    return encodeURIComponent(value);
  });
  return missing ? "" : out;
}

/** A field's value by name; a dotted name goes into objects. Never throws. */
export function valueAt(data: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(data, path)) return data[path];
  let at: unknown = data;
  for (const part of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    const own = at as Record<string, unknown>;
    at = Object.hasOwn(own, part) ? own[part] : undefined;
  }
  return at;
}

/** A field counts as present when it has a value: not missing, null, an empty string, an empty list or an empty object. */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}
