import type { Env } from "./types.js";

export const REDACTED = "[redacted]";

/** Every way a value can show up in text: as is, trimmed, percent-encoded, and JSON-escaped. */
function spellings(value: string): string[] {
  const trimmed = value.trim();
  // A value that is only whitespace is not a key; blanking every space in the output would help nobody.
  if (trimmed === "") return [];
  const out = new Set<string>([value, trimmed, encodeURIComponent(trimmed)]);
  out.add(JSON.stringify(trimmed).slice(1, -1));
  return [...out].filter((s) => s !== "");
}

/**
 * Build the function every message passes through before it leaves core. It replaces every
 * configured value with "[redacted]". Where two values overlap in the text ("sk_a" inside
 * "sk_a_longer", or "abcd" holding "abc" and "bcd"), the covered stretches are merged, so no
 * leftover characters of either key remain. A name that is unset or empty contributes nothing.
 */
export function createRedactor(env: Env, names: readonly string[]): (text: string) => string {
  const needles = [
    ...new Set(
      names.flatMap((n) => spellings(typeof env[n] === "string" ? (env[n] as string) : "")),
    ),
  ].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (needles.length === 0) return (text) => text;
  return (text) => {
    const spans: Array<[number, number]> = [];
    for (const needle of needles) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        spans.push([at, at + needle.length]);
      }
    }
    if (spans.length === 0) return text;
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let out = "";
    let cursor = 0;
    let from = -1;
    let to = -1;
    const flush = (): void => {
      if (from < 0) return;
      out += text.slice(cursor, from) + REDACTED;
      cursor = to;
    };
    for (const [s, e] of spans) {
      if (from >= 0 && s <= to) {
        to = Math.max(to, e);
        continue;
      }
      flush();
      from = s;
      to = e;
    }
    flush();
    return out + text.slice(cursor);
  };
}
