import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { CheckContext } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import type { StatePage } from "./pages.js";

export const NOT_SET_UP =
  "gaugeline.switches.json is not set up, so nothing was checked. See docs/guides/switches-and-availability.";

/** Text from a config file or a page, made safe to print in one line. */
export function safe(text: string, max = 60): string {
  return escapeInvisible(text, max);
}

/** "/order" for a page on the site, the full address otherwise. */
export function pathOf(url: string, origin: string): string {
  try {
    const u = new URL(url);
    return safe(u.origin === origin ? `${u.pathname}${u.search}` : url, 100);
  } catch {
    return safe(url, 100);
  }
}

export function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * What a page that could not be read means for a check: could not check, with the reason. A page
 * that answers 404 has nothing to link to or list, so a check of links or items (`gone: "silent"`)
 * has nothing to say about it; the link checks report dead pages. A check of what a page says has
 * not checked it, and says so.
 */
export function unreadable(
  ctx: CheckContext,
  fallback: string,
  got: Exclude<StatePage, { ok: true }>,
  gone: "silent" | "note" = "note",
): void {
  if (got.kind === "gone" && gone === "silent") return;
  ctx.couldNotCheck?.(fallback, got.message);
}

/** The checked page plus the sample of other pages the run read, once each. */
export async function pagesInScope(page: PageSnapshot, ctx: CheckContext): Promise<PageSnapshot[]> {
  const seen = new Set<string>();
  const out: PageSnapshot[] = [];
  for (const p of [page, ...((await ctx.pages?.()) ?? [])]) {
    const key = trimSlash(new URL(p.finalUrl).pathname);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** A rule as a finding names it: "eighty-six (db:eightySixed)" with an id, the source alone without. */
export function label(rule: { id?: string | undefined; source: string }): string {
  return rule.id === undefined ? rule.source : `${rule.id} (${rule.source})`;
}
