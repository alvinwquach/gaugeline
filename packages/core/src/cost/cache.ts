/**
 * What the headers of a response say about caching. Only the headers the hosts document are read:
 * Vercel's x-vercel-cache, Cloudflare's cf-cache-status, the Age a cache adds, and Cache-Control.
 * Anything else is "unknown", never a guess.
 */

export interface CacheRead {
  /** hit: a cache served it. miss: it went to the origin. unknown: the response does not say. */
  state: "hit" | "miss" | "unknown";
  /** The header that said so, as printed in evidence: "x-vercel-cache: MISS". */
  header?: string;
}

const VERCEL_HIT = new Set(["HIT", "STALE", "PRERENDER", "REVALIDATED"]);
const VERCEL_MISS = new Set(["MISS", "BYPASS"]);
const CF_HIT = new Set(["HIT", "STALE", "UPDATING", "REVALIDATED"]);
const CF_MISS = new Set(["MISS", "EXPIRED", "BYPASS", "DYNAMIC"]);

const named = (
  headers: Readonly<Record<string, string>>,
  name: string,
  hit: ReadonlySet<string>,
  miss: ReadonlySet<string>,
): CacheRead | undefined => {
  const raw = (headers[name] ?? "").trim().toUpperCase();
  if (hit.has(raw)) return { state: "hit", header: `${name}: ${raw}` };
  if (miss.has(raw)) return { state: "miss", header: `${name}: ${raw}` };
  return undefined;
};

/** The cache state of one response: the host's own status header first, then a positive Age. */
export function cacheRead(headers: Readonly<Record<string, string>>): CacheRead {
  const status =
    named(headers, "x-vercel-cache", VERCEL_HIT, VERCEL_MISS) ??
    named(headers, "cf-cache-status", CF_HIT, CF_MISS);
  if (status) return status;
  const age = (headers.age ?? "").trim();
  if (/^\d{1,9}$/.test(age) && Number(age) >= 1)
    return { state: "hit", header: `age: ${Number(age)}` };
  return { state: "unknown" };
}

export interface Lifetime {
  seconds: number;
  /** The directive it came from, as printed in evidence: "s-maxage=1", "no-store". */
  from: string;
}

const directive = (value: string, name: string): number | undefined => {
  const m = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*"?(\\d{1,10})"?(?=$|[\\s,;])`, "i").exec(value);
  return m ? Number(m[1]) : undefined;
};

/**
 * How long a shared cache may keep the response, from Cache-Control: no-store, no-cache and private
 * mean not at all; otherwise s-maxage (which a shared cache obeys over max-age), then max-age.
 * Undefined when there is no header or no lifetime in it.
 */
export function lifetimeOf(headers: Readonly<Record<string, string>>): Lifetime | undefined {
  const value = (headers["cache-control"] ?? "").trim();
  if (value === "") return undefined;
  const has = (name: string) => new RegExp(`(?:^|[\\s,])${name}(?=$|[\\s,;=])`, "i").test(value);
  if (has("no-store")) return { seconds: 0, from: "no-store" };
  if (has("no-cache")) return { seconds: 0, from: "no-cache" };
  if (has("private")) return { seconds: 0, from: "private" };
  const shared = directive(value, "s-maxage");
  if (shared !== undefined) return { seconds: shared, from: `s-maxage=${shared}` };
  const max = directive(value, "max-age");
  if (max !== undefined) return { seconds: max, from: `max-age=${max}` };
  return undefined;
}
