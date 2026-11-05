import type { Hop } from "../fetcher.js";

/** "a, b, c and 2 more": the first few, in order, so evidence stays one line. */
export function firstFew(items: readonly string[], n = 3): string {
  const shown = items.slice(0, n).join(", ");
  return items.length > n ? `${shown} and ${items.length - n} more` : shown;
}

/** The final status of a request, or undefined when it got no answer. */
export function finalStatus(hops: readonly Hop[]): number | undefined {
  return hops.at(-1)?.status;
}

/** "/menu" for an address on the page's origin, the full address otherwise. */
export function shortUrl(url: string, origin: string): string {
  try {
    const u = new URL(url);
    return u.origin === origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}
