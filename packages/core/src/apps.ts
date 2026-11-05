import type { Fetcher, Hop } from "./fetcher.js";
import type { Budget } from "./limits.js";
import { getOrNull } from "./probe.js";
import type { PageSnapshot } from "./snapshot.js";

/** One app the page links to: an App Store id or a Google Play package. */
export interface AppRef {
  store: "apple" | "google";
  /** Apple: the numeric id ("1234567890"). Google: the package ("com.example.app"). */
  id: string;
  /** Apple only: the two-letter storefront from the link's path ("gb"), if it has one. */
  country?: string;
  /** The first href that named this app. */
  href: string;
}

/**
 * An App Store id from every documented link form:
 *   https://apps.apple.com/us/app/name/id1234567890, https://apps.apple.com/app/id1234567890,
 *   https://itunes.apple.com/gb/app/name/id1234567890?mt=8, itms-apps://itunes.apple.com/app/id123
 */
export function appleRef(href: string): AppRef | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (!/^(?:https?|itms-apps|itms-appss):$/.test(u.protocol)) return undefined;
  if (!/^(?:apps|itunes)\.apple\.com$/i.test(u.hostname)) return undefined;
  const parts = u.pathname.split("/").filter(Boolean);
  const idPart = parts.find((p) => /^id\d+$/.test(p));
  if (!idPart || !parts.some((p) => p === "app")) return undefined;
  const country = parts[0] && /^[a-z]{2}$/i.test(parts[0]) ? parts[0].toLowerCase() : undefined;
  return { store: "apple", id: idPart.slice(2), ...(country ? { country } : {}), href };
}

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

/**
 * A Google Play package from https://play.google.com/store/apps/details?id=<package> (with any
 * hl or gl parameters) or market://details?id=<package>.
 */
export function googleRef(href: string): AppRef | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  const play =
    /^https?:$/.test(u.protocol) &&
    /^play\.google\.com$/i.test(u.hostname) &&
    /^\/store\/apps\/details\/?$/.test(u.pathname);
  const market =
    u.protocol === "market:" && (u.hostname === "details" || u.pathname.startsWith("//details"));
  if (!play && !market) return undefined;
  const id = u.searchParams.get("id") ?? "";
  return PACKAGE.test(id) ? { store: "google", id, href } : undefined;
}

/** The app id an apple-itunes-app meta tag names ("app-id=1234567890, app-argument=..."). */
export function bannerAppId(content: string | undefined): string | undefined {
  return content ? /(?:^|,)\s*app-id\s*=\s*(\d+)/i.exec(content)?.[1] : undefined;
}

/** Every app the page links to, once per store and id, in document order. */
export function appRefs(page: Pick<PageSnapshot, "links">): AppRef[] {
  const out = new Map<string, AppRef>();
  for (const l of page.links) {
    const ref = appleRef(l.href) ?? googleRef(l.href);
    if (ref && !out.has(`${ref.store}:${ref.id}`)) out.set(`${ref.store}:${ref.id}`, ref);
  }
  return [...out.values()];
}

/**
 * What the store said:
 * - found: the app is live, with its store name
 * - missing: the store has no such app (Apple: no result anywhere tried; Google: 404)
 * - unchecked: the store could not say (a regional link for an app not sold there, 429, an error)
 */
export type AppLookup =
  | { ref: AppRef; state: "found"; name: string }
  | { ref: AppRef; state: "missing"; status?: number }
  | { ref: AppRef; state: "unchecked"; reason: string };

/** The public iTunes Lookup endpoint: no key, JSON. */
export function appleLookupUrl(id: string, country = "us"): string {
  return `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}`;
}

export function googleListingUrl(id: string): string {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}&hl=en`;
}

const RETRY = "The store asked Gaugeline to slow down (429); try again in a few minutes.";

function appleResult(
  hops: Hop[],
): { state: "ok"; name?: string } | { state: "error"; reason: string } {
  const last = hops.at(-1);
  if (!last) return { state: "error", reason: "the App Store lookup did not answer" };
  if (last.status === 429) return { state: "error", reason: RETRY };
  if (last.status !== 200)
    return { state: "error", reason: `the App Store lookup answered ${last.status}` };
  try {
    const json = JSON.parse(last.body ?? "") as {
      resultCount?: number;
      results?: { trackName?: unknown }[];
    };
    const name = json.results?.[0]?.trackName;
    return { state: "ok", ...(typeof name === "string" ? { name } : {}) };
  } catch {
    return { state: "error", reason: "the App Store lookup did not return JSON" };
  }
}

async function lookupApple(ref: AppRef, fetcher: Fetcher): Promise<AppLookup> {
  const country = ref.country ?? "us";
  const first = appleResult(await getOrNull(fetcher, appleLookupUrl(ref.id, country)));
  if (first.state === "error") return { ref, state: "unchecked", reason: first.reason };
  if (first.name !== undefined) return { ref, state: "found", name: first.name };
  if (country === "us") return { ref, state: "missing" };
  // Not in the link's storefront: look in the default one before calling it gone.
  const us = appleResult(await getOrNull(fetcher, appleLookupUrl(ref.id, "us")));
  if (us.state === "error") return { ref, state: "unchecked", reason: us.reason };
  if (us.name !== undefined) {
    return {
      ref,
      state: "unchecked",
      reason: `"${us.name}" is live but not sold in the ${country.toUpperCase()} store this link points to`,
    };
  }
  return { ref, state: "missing" };
}

/** The listing's name: <title> "Name - Apps on Google Play", or og:title. */
export function playTitle(html: string): string | undefined {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  const raw = (title ?? og ?? "").replace(/\s*[-–]\s*Apps on Google Play\s*$/i, "").trim();
  return raw === ""
    ? undefined
    : raw
        .replace(/&amp;/g, "&")
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"');
}

async function lookupGoogle(ref: AppRef, fetcher: Fetcher): Promise<AppLookup> {
  const last = (await getOrNull(fetcher, googleListingUrl(ref.id))).at(-1);
  if (!last) return { ref, state: "unchecked", reason: "Google Play did not answer" };
  if (last.status === 404) return { ref, state: "missing", status: 404 };
  if (last.status === 429) return { ref, state: "unchecked", reason: RETRY };
  if (last.status !== 200)
    return { ref, state: "unchecked", reason: `Google Play answered ${last.status}` };
  const name = playTitle(last.body ?? "");
  // A 200 with no recognisable title (a consent or error page) is ambiguous: unchecked, not found.
  return name
    ? { ref, state: "found", name }
    : { ref, state: "unchecked", reason: "Google Play's page had no app title" };
}

export interface AppLookupOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/** Look up the first apps the page links to, within the run's allowance, once each. */
export async function lookupApps({
  page,
  fetcher,
  budget,
}: AppLookupOptions): Promise<AppLookup[]> {
  const refs = budget.take("appLinks", appRefs(page));
  return Promise.all(
    refs.map((r) => (r.store === "apple" ? lookupApple(r, fetcher) : lookupGoogle(r, fetcher))),
  );
}

/** Built on first use and shared by the app checks. */
export function lazyAppLookups(opts: AppLookupOptions): () => Promise<AppLookup[]> {
  let pending: Promise<AppLookup[]> | undefined;
  return () => (pending ??= lookupApps(opts));
}
