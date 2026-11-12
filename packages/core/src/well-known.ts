import list from "./data/well-known.json";
import type { Fetcher, Hop } from "./fetcher.js";
import { getOrNull } from "./probe.js";

export interface WellKnownPath {
  path: string;
  name: string;
  /** A specification link, or "uncited". */
  source: string;
}

/** The documented discovery paths Gaugeline asks for, from packages/core/src/data/well-known.json. */
export const WELL_KNOWN_PATHS: readonly WellKnownPath[] = Object.freeze(
  list.paths.map((p) => Object.freeze({ path: p.path, name: p.name, source: p.source })),
);

/** Largest body parsed as JSON: a discovery file is a few kilobytes. */
export const WELL_KNOWN_MAX_CHARS = 200_000;

export type WellKnownState = "valid" | "absent" | "invalid" | "unread";

/** Judge one answer: only a served, non-HTML 2xx body is read; 404, HTML and 5xx mean no file. */
export function judgeWellKnown(hop: Hop | undefined): { state: WellKnownState; why?: string } {
  if (!hop || hop.status < 200 || hop.status >= 300) return { state: "absent" };
  const type = hop.headers["content-type"] ?? "";
  const body = (hop.body ?? "").replace(/^\uFEFF/, "");
  const start = body.trimStart().slice(0, 16).toLowerCase();
  // A catch-all route answering every path with its home page is "no file", not a broken one.
  if (/html/i.test(type) || start.startsWith("<!doctype") || start.startsWith("<html")) {
    return { state: "absent" };
  }
  if (hop.truncated || body.length > WELL_KNOWN_MAX_CHARS) return { state: "unread" };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { state: "invalid", why: "is not valid JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { state: "invalid", why: "is JSON but not an object" };
  }
  return { state: "valid" };
}

export interface WellKnownRead extends WellKnownPath {
  url: string;
  state: WellKnownState;
  why?: string;
}

const cache = new WeakMap<Fetcher, Map<string, Promise<WellKnownRead[]>>>();

/** Ask for each documented path once per fetcher and origin; the checks share the answer. */
export function readWellKnown(fetcher: Fetcher, origin: string): Promise<WellKnownRead[]> {
  const perFetcher = cache.get(fetcher) ?? new Map<string, Promise<WellKnownRead[]>>();
  cache.set(fetcher, perFetcher);
  let pending = perFetcher.get(origin);
  if (!pending) {
    pending = Promise.all(
      WELL_KNOWN_PATHS.map(async (p) => {
        const url = `${origin}${p.path}`;
        const hops = await getOrNull(fetcher, url);
        return { ...p, url, ...judgeWellKnown(hops.at(-1)) };
      }),
    );
    perFetcher.set(origin, pending);
  }
  return pending;
}
