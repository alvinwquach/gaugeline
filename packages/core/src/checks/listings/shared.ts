import { venueZone } from "../events/events.js";
import type { CheckContext, Finding } from "../../model.js";
import type { ListingsRead } from "../../listings/read.js";
import { readSiteFacts, todayIn, type SiteFacts } from "../../listings/site.js";
import type { Listing } from "../../listings/types.js";
import type { PageSnapshot } from "../../snapshot.js";

export interface ListingRun {
  read: ListingsRead;
  site: SiteFacts;
  /** Today in the venue's time zone. */
  today: string;
  /** The listings this check can compare: every one except a business marked permanently closed. */
  listings: Listing[];
}

/**
 * What every listing check starts from. Returns undefined when no listing is configured (the
 * checks are then not run at all: checkSite skips them, or says "none set up" if one was asked for
 * by id). Sources that gave nothing (no key, refused, rate limited) are
 * reported once for each check that needed them, by `wants` (the connector ids). A listing marked
 * permanently closed is reported and left out: a renamed venue's old listing is meant to say so.
 */
export async function startListingCheck(
  page: PageSnapshot,
  ctx: CheckContext,
  wants: (connector: string) => boolean,
): Promise<ListingRun | undefined> {
  if (!ctx.listings) return undefined;
  const read = await ctx.listings();
  for (const n of read.notices)
    if (wants(n.connector) || n.connector === "listings")
      ctx.couldNotCheck?.(page.finalUrl, n.message);
  const listings: Listing[] = [];
  for (const l of read.listings) {
    if (!wants(l.source)) continue;
    if (l.status === "closed-permanently") {
      ctx.couldNotCheck?.(
        l.url ?? page.finalUrl,
        `${l.label} lists the business as permanently closed, so it was not compared. If you are open, that is the listing to fix first.`,
      );
    } else listings.push(l);
  }
  const now = ctx.now?.() ?? new Date();
  const today = todayIn(now, venueZone(ctx));
  const pages = (await ctx.pages?.()) ?? [page];
  return { read, site: readSiteFacts(pages, ctx.facts, today), today, listings };
}

/** How a listing's state qualifies what is said about it. */
export function aside(l: Listing): string {
  if (l.status === "unverified") return " (the owner has not verified this listing)";
  if (l.status === "closed-temporarily") return " (marked temporarily closed)";
  return "";
}

export function finding(
  checkId: string,
  severity: Finding["severity"],
  title: string,
  evidence: string,
  url: string,
): Finding {
  return { checkId, severity, title, evidence, url };
}

export const ANY_LISTING = (connector: string): boolean => connector !== "bio-link";
