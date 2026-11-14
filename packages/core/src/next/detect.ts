import type { PageSnapshot } from "../snapshot.js";

/**
 * A Next.js site, from its responses: an x-powered-by: Next.js or x-nextjs-* header, or, behind a
 * proxy that strips those, its HTML (/_next/ assets, __NEXT_DATA__, the App Router's __next_f).
 */
export function isNextSite(page: PageSnapshot): boolean {
  const headers = page.hops.at(-1)?.headers ?? {};
  if (/next\.js/i.test(headers["x-powered-by"] ?? "")) return true;
  if (Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-nextjs-"))) return true;
  if (page.scripts.some((s) => /\/_next\//.test(s))) return true;
  const body = page.hops.at(-1)?.body ?? "";
  return /<script[^>]+id=["']__NEXT_DATA__["']|self\.__next_f\b/.test(body);
}

export interface CacheRead {
  /** HIT, STALE or MISS, from x-nextjs-cache or x-vercel-cache. */
  state?: "HIT" | "STALE" | "MISS";
  /** The Age header, in seconds. */
  ageSeconds?: number;
}

/** The framework's and host's cache headers, as documented; anything else is left out (unchecked). */
export function readCache(headers: Record<string, string>): CacheRead {
  const raw = (headers["x-nextjs-cache"] ?? headers["x-vercel-cache"] ?? "").trim().toUpperCase();
  const state = raw === "HIT" || raw === "STALE" || raw === "MISS" ? raw : undefined;
  const age = /^\d+$/.test(headers.age ?? "") ? Number(headers.age) : undefined;
  return { ...(state ? { state } : {}), ...(age !== undefined ? { ageSeconds: age } : {}) };
}

/** Added to a rendered-versus-sent finding on a Next.js site. */
export const NEXT_RENDERED_NOTE =
  "On this Next.js site the content arrives only after the page's scripts run.";
