import type { CheckContext } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import type { ContentNow } from "../snapshot/compare.js";
import { contentKey, type ContentSnapshot } from "../snapshot/page-snapshot.js";

export interface PageCompare {
  /** The saved path. */
  key: string;
  /** That path on the checked origin, for the finding. */
  url: string;
  prev: ContentSnapshot;
  now: ContentNow;
}

/** A path from gaugeline.pages.json, keyed like a saved page. */
export const pathKey = (path: string) => contentKey(new URL(path, "https://pages.invalid").href);

/**
 * The saved pages and what each is now, for the four page checks. Without a saved run: nothing,
 * and with --since last that is could not check (a first run, or a snapshot saved before pages
 * were), never a pass. Pages listed in expectedChanges are left out.
 */
export async function comparePages(
  page: PageSnapshot,
  ctx: CheckContext,
): Promise<PageCompare[] | undefined> {
  const saved = ctx.previous?.pages;
  if (!saved) {
    if (ctx.baselineRequested)
      ctx.couldNotCheck?.(
        page.finalUrl,
        ctx.previous
          ? "the last run's snapshot has no saved pages: this run saves them"
          : "no saved pages to compare with yet: this run saves them",
      );
    return undefined;
  }
  if (!ctx.contentNow) return undefined;
  const now = await ctx.contentNow();
  const expected = new Set((ctx.expectedChanges ?? []).map((e) => pathKey(e.path)));
  const origin = new URL(page.finalUrl).origin;
  const out: PageCompare[] = [];
  for (const [key, prev] of Object.entries(saved).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const at = now.get(key);
    if (!at || expected.has(key)) continue;
    out.push({ key, url: new URL(key, origin).href, prev, now: at });
  }
  return out;
}

/** The pages still there, and a could-not-check line for each that couldn't be read. */
export function readPages(
  list: readonly PageCompare[],
  ctx: CheckContext,
): (PageCompare & { snap: ContentSnapshot })[] {
  const out: (PageCompare & { snap: ContentSnapshot })[] = [];
  for (const c of list) {
    if (c.now.kind === "unread") ctx.couldNotCheck?.(c.url, c.now.reason);
    else if (c.now.kind === "page") out.push({ ...c, snap: c.now.snap });
  }
  return out;
}
