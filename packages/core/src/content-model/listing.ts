import { load } from "cheerio/slim";
import type { StatePages } from "../switches/pages.js";
import { MAX_LISTING_PAGES, type ModelListing } from "./config.js";

/** What a listing page, followed through its pages of results, shows. */
export type ListingRead =
  | {
      ok: true;
      /** Pages of results read. */
      pages: number;
      /** Entries shown: each distinct address once (an entry with no address counts once each). */
      shown: number;
      /** The address of each entry that has one: the last part of its link. */
      slugs: string[];
      /** Every entry had an address, so the ones that are missing can be named. */
      allAddressed: boolean;
    }
  | { ok: false; reason: string };

/** The slug an entry's link ends in: `/news/tip-07` is `tip-07`. */
function slugOf(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base);
    const last = u.pathname.split("/").filter(Boolean).at(-1);
    return last === undefined ? undefined : decodeURIComponent(last);
  } catch {
    return undefined;
  }
}

/**
 * Read a listing the way a visitor pages through it: the page, then the page its "next" link
 * names, and so on, up to MAX_LISTING_PAGES. A page that cannot be read, or a list that goes on
 * longer than that, gives no count at all: a partial count would report entries as missing that
 * are on a page nobody read.
 */
export async function readListing(
  listing: ModelListing,
  origin: string,
  pages: StatePages,
): Promise<ListingRead> {
  const seen = new Set<string>();
  const slugs: string[] = [];
  let unaddressed = 0;
  let url: string | undefined = `${origin}${listing.page}`;
  const visited = new Set<string>();
  let read = 0;
  while (url !== undefined) {
    if (visited.has(url)) break;
    if (read >= MAX_LISTING_PAGES)
      return {
        ok: false,
        reason: `the listing goes on for more than ${MAX_LISTING_PAGES} pages of results, so it was not counted`,
      };
    visited.add(url);
    const got = await pages.get(url);
    if (!got.ok) return { ok: false, reason: got.message };
    read += 1;
    const html = got.page.hops.at(-1)?.body ?? "";
    const $ = load(html);
    $(listing.item).each((_, el) => {
      const anchor = $(el).is("a[href]") ? $(el) : $(el).find("a[href]").first();
      const href = anchor.attr("href")?.trim() ?? "";
      const slug =
        href === "" || href.startsWith("#") ? undefined : slugOf(href, got.page.finalUrl);
      if (slug === undefined) {
        unaddressed += 1;
        return;
      }
      if (!seen.has(slug)) {
        seen.add(slug);
        slugs.push(slug);
      }
    });
    const nextHref = (
      listing.next
        ? $(listing.next).first().attr("href")
        : ($('a[rel~="next"]').first().attr("href") ?? $('link[rel~="next"]').first().attr("href"))
    )?.trim();
    url = undefined;
    if (nextHref) {
      try {
        const next = new URL(nextHref, got.page.finalUrl);
        next.hash = "";
        if (next.origin === origin) url = next.href;
      } catch {
        // an address that is not one: the list ends here
      }
    }
  }
  return {
    ok: true,
    pages: read,
    shown: slugs.length + unaddressed,
    slugs,
    allAddressed: unaddressed === 0,
  };
}
