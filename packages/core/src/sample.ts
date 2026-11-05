import { normaliseUrl } from "./normalise.js";

/**
 * Keep the first occurrence of each address, compared by normalised URL, in document order.
 * Call this before Budget.take() so a link repeated in the nav and the footer costs one.
 * Candidates that are not valid URLs are dropped.
 */
export function dedupeUrls(urls: Iterable<string>, base?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    let key: string;
    try {
      key = normaliseUrl(raw, base);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** One sampled address: normalised, with the first href and link text that pointed at it. */
export interface SampleItem {
  url: string;
  href: string;
  text?: string;
}

/**
 * De-duplicate by normalised URL, keep document order, take the first `limit`. A Map keyed by the
 * normalised URL keeps the first-seen href and text for the evidence line, with O(1) lookups on a
 * page with thousands of links. `seen` counts the unique addresses. Same input, same sample.
 */
export function sampleUrls(
  urls: readonly { url: string; text?: string }[],
  limit: number,
  base?: string,
): { taken: SampleItem[]; seen: number } {
  const unique = new Map<string, SampleItem>();
  for (const { url, text } of urls) {
    let key: string;
    try {
      key = normaliseUrl(url, base);
    } catch {
      continue;
    }
    if (!unique.has(key)) unique.set(key, { url: key, href: url, ...(text ? { text } : {}) });
  }
  const all = [...unique.values()];
  return { taken: all.slice(0, Math.max(0, limit)), seen: all.length };
}

/** The site a host belongs to, for "same site": the hostname without a leading www. */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** www.shop.example and shop.example are one site; blog.shop.example and other.example are not. */
export function isSameSite(a: string, b: string): boolean {
  const x = siteOf(a);
  return x !== undefined && x === siteOf(b);
}
