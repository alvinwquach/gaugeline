import type { Fetcher } from "./fetcher.js";
import type { Budget } from "./limits.js";
import { linkCandidates } from "./links.js";
import { NetworkError } from "./errors.js";
import { sampleUrls } from "./sample.js";
import { buildSnapshot, type PageSnapshot } from "./snapshot.js";

export interface PagesOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/**
 * The checked page plus the first other same-site pages it links to (the run's "pages" allowance),
 * each fetched once with GET and parsed. For checks that compare pages with each other. Pages that
 * do not load as HTML are left out.
 */
export async function samplePages({
  page,
  fetcher,
  budget,
}: PagesOptions): Promise<PageSnapshot[]> {
  const unique = sampleUrls(linkCandidates(page), Number.MAX_SAFE_INTEGER).taken.map((t) => t.url);
  const taken = budget.take("pages", unique);
  const others = await Promise.all(
    taken.map(async (url) => {
      try {
        const hops = await fetcher.get(url);
        const last = hops.at(-1);
        if (
          !last ||
          last.status < 200 ||
          last.status >= 300 ||
          !/html/i.test(last.headers["content-type"] ?? "text/html")
        )
          return undefined;
        return buildSnapshot(hops);
      } catch (err) {
        if (err instanceof NetworkError) return undefined;
        throw err;
      }
    }),
  );
  return [page, ...others.filter((p): p is PageSnapshot => p !== undefined)];
}

export function lazyPages(opts: PagesOptions): () => Promise<PageSnapshot[]> {
  let pending: Promise<PageSnapshot[]> | undefined;
  return () => (pending ??= samplePages(opts));
}
