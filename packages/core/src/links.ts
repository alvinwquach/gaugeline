import type { Fetcher, Hop } from "./fetcher.js";
import type { Budget } from "./limits.js";
import { probe } from "./probe.js";
import { isSameSite, sampleUrls, type SampleItem } from "./sample.js";
import type { PageSnapshot } from "./snapshot.js";

/** One sampled link and every hop of its probe ([] when it could not be reached). */
export interface LinkResult extends SampleItem {
  hops: Hop[];
}

/** The run's link sample: `seen` unique same-site links, the first of them probed. */
export interface LinkSample {
  seen: number;
  taken: LinkResult[];
}

function withoutHash(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

/**
 * Same-site http(s) links from a[href], in document order. mailto:, tel: and javascript: are not
 * http(s) and are dropped; a #fragment link to this page is the page itself and is dropped too.
 */
export function linkCandidates(page: PageSnapshot): { url: string; text?: string }[] {
  const self = withoutHash(page.finalUrl);
  return page.links.flatMap((l) => {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      return [];
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return [];
    if (!isSameSite(u.href, page.finalUrl)) return [];
    if (withoutHash(u.href) === self) return [];
    return [{ url: u.href, ...(l.text ? { text: l.text } : {}) }];
  });
}

export interface LinkSampleOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/** De-duplicate, take the run's link allowance in document order, and probe each once. */
export async function sampleLinks({
  page,
  fetcher,
  budget,
}: LinkSampleOptions): Promise<LinkSample> {
  const unique = sampleUrls(linkCandidates(page), Number.MAX_SAFE_INTEGER).taken;
  const taken = budget.take("links", unique);
  const hops = await Promise.all(taken.map((item) => probe(item.url, fetcher)));
  return {
    seen: unique.length,
    taken: taken.map((item, i) => ({ ...item, hops: hops[i] ?? [] })),
  };
}

/** Built on first use and shared by both link checks, so each link is requested once per run. */
export function lazyLinkSample(opts: LinkSampleOptions): () => Promise<LinkSample> {
  let pending: Promise<LinkSample> | undefined;
  return () => (pending ??= sampleLinks(opts));
}
