import type { TrackingRule } from "./config.js";

/**
 * Click-tracking and link-scanning wrappers whose address holds the real destination in a query
 * parameter, so it can be read without a request. A wrapper that keeps the destination on its own
 * server (most email providers') cannot be unwrapped here: add its pattern to
 * gaugeline.emails.json if it puts the address in a parameter, and otherwise the wrapper itself is
 * what is checked.
 */
export const KNOWN_TRACKING: readonly TrackingRule[] = Object.freeze([
  // Microsoft's link scanning rewrites links in an inbox to ...safelinks.protection.outlook.com/?url=<destination>.
  { host: "safelinks.protection.outlook.com", param: "url" },
  // Google's redirect: google.com/url?q=<destination>.
  { host: "google.com", param: "q", path: "/url" },
  { host: "google.com", param: "url", path: "/url" },
]);

const hostMatches = (hostname: string, host: string): boolean =>
  hostname === host || hostname.endsWith(`.${host}`);

/** How many wrappers inside wrappers are followed. */
const MAX_DEPTH = 3;

export interface Unwrapped {
  /** The destination, or the address as written when no known pattern matched. */
  href: string;
  /** The wrapper's host, when one was unwrapped. */
  via?: string;
}

/** One layer, or undefined. Nothing is requested. */
function unwrapOnce(href: string, rules: readonly TrackingRule[]): string | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const r of rules) {
    if (!hostMatches(host, r.host.toLowerCase())) continue;
    if (r.path !== undefined && u.pathname !== r.path) continue;
    const dest = u.searchParams.get(r.param);
    if (dest !== null && /^https?:\/\/\S+$/i.test(dest.trim())) return dest.trim();
  }
  return undefined;
}

/** The destination of a tracking-wrapped link when its pattern is known (a built-in or `extra`), else the link itself. */
export function unwrapTracking(href: string, extra: readonly TrackingRule[] = []): Unwrapped {
  const rules = [...KNOWN_TRACKING, ...extra];
  let current = href;
  let via: string | undefined;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const next = unwrapOnce(current, rules);
    if (next === undefined) break;
    via ??= new URL(current).hostname.toLowerCase();
    current = next;
  }
  return via === undefined ? { href: current } : { href: current, via };
}
