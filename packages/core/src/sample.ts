import { normaliseUrl } from "./fetcher.js";

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
      key = normaliseUrl(base === undefined ? raw : new URL(raw.trim(), base).href);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
