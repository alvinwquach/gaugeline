// check-community: allow-email (the scrubber replaces addresses with this reserved example one)
import { keyPatterns } from "@gaugeline/core";

export interface Interaction {
  method: "GET" | "HEAD";
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A scrubber returns a cleaned copy. Scrubbers run before anything is written to disk. */
export type Scrubber = (i: Interaction) => Interaction;

export const SCRUBBED = "SCRUBBED";
export const SAFE_EMAIL = "person@example.com";
const SECRET_PARAMS = new Set([
  "key",
  "token",
  "access_token",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
]);
/** Response headers worth keeping: the type, and what pagination needs. Everything else is dropped. */
const KEEP_HEADERS = new Set([
  "content-type",
  "link",
  "x-total-count",
  "x-next-cursor",
  "x-page",
  "x-per-page",
  "x-total",
]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;

/** Key patterns and email addresses in plain text, including inside base64 runs. */
export function scrubText(text: string, depth = 0): string {
  let out = text;
  for (const { pattern } of keyPatterns()) out = out.replace(pattern, SCRUBBED);
  out = out.replace(EMAIL, (m) => (m === SAFE_EMAIL ? m : SAFE_EMAIL));
  if (depth > 0) return out;
  return out.replace(BASE64_RUN, (run) => {
    const decoded = Buffer.from(run, "base64").toString("utf8");
    if (!/^[\t\n\r\x20-\x7e]*$/.test(decoded)) return run;
    const cleaned = scrubText(decoded, depth + 1);
    return cleaned === decoded ? run : Buffer.from(cleaned, "utf8").toString("base64");
  });
}

function scrubJsonValue(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubJsonValue(v)]));
  }
  return value;
}

/**
 * A JSON body is scrubbed on its parsed values, so a key hidden behind \u escapes is still found;
 * anything else is scrubbed as text.
 */
export function scrubBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(scrubJsonValue(JSON.parse(body) as unknown));
    } catch {
      // not JSON after all: scrub as text
    }
  }
  return scrubText(body);
}

export function scrubUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return scrubText(url);
  }
  for (const name of [...u.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) u.searchParams.set(name, SCRUBBED);
  }
  if (u.username) u.username = SCRUBBED;
  if (u.password) u.password = SCRUBBED;
  return scrubText(u.href);
}

export const scrubHeaders: Scrubber = (i) => ({
  ...i,
  headers: Object.fromEntries(
    Object.entries(i.headers)
      .filter(([k]) => KEEP_HEADERS.has(k.toLowerCase()))
      .map(([k, v]) => [k.toLowerCase(), scrubText(v)]),
  ),
});

export const scrubQuery: Scrubber = (i) => ({ ...i, url: scrubUrl(i.url) });

export const scrubValues: Scrubber = (i) => ({ ...i, body: scrubBody(i.body) });

export const DEFAULT_SCRUBBERS: readonly Scrubber[] = Object.freeze([
  scrubHeaders,
  scrubQuery,
  scrubValues,
]);

export function scrub(
  i: Interaction,
  scrubbers: readonly Scrubber[] = DEFAULT_SCRUBBERS,
): Interaction {
  return scrubbers.reduce((acc, s) => s(acc), i);
}
