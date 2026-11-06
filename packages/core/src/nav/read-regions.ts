import { load, type CheerioAPI } from "cheerio/slim";
import * as z from "zod";
import type { PageSnapshot } from "../snapshot.js";

/**
 * A page's links by region: the header navigation, the footer and the body. For menus, each link
 * keeps its parent item, so the same destination under two parents is two entries. A link is
 * identified by region, parent and destination, never by its text alone.
 */
export type NavRegion = "header" | "footer" | "body";

export interface NavEntry {
  region: NavRegion;
  /** The top-level menu item it sits under; "" for a top-level item or a link outside a list. */
  parent: string;
  text: string;
  /** Resolved, lower-case host, no trailing slash, no #fragment. */
  destination: string;
  /** Position among the links with the same region and parent, from 0. */
  order: number;
}

/** gaugeline.nav.json: where the menus are, and which footer links every page must have. */
export const navRulesSchema = z
  .object({
    /** CSS selectors that override the landmarks (header, footer, a separate mobile menu). */
    regions: z
      .object({
        header: z.string().min(1).optional(),
        footer: z.string().min(1).optional(),
        mobile: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Footer links every page must have, matched on their text or path: "privacy", "terms". */
    requiredFooter: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type NavRules = z.infer<typeof navRulesSchema>;

export interface PageNav {
  url: string;
  entries: NavEntry[];
  /** The separate mobile menu's destinations, when the HTML has one. */
  mobile?: string[];
  /** A menu toggle points at a menu that isn't in the HTML: it is built by JavaScript. */
  mobileBuiltByScript: boolean;
}

/** Where a separate mobile menu usually is, when the config names none. */
const MOBILE =
  "[data-mobile-menu], #mobile-menu, #mobile-nav, .mobile-menu, .mobile-nav, nav[aria-label*='mobile' i]";

/** The key a destination is compared on: no fragment, lower-case host, no trailing slash. */
export function destinationKey(href: string): string {
  try {
    const u = new URL(href);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.href;
  } catch {
    return href;
  }
}

const clean = (s: string) => s.replace(/[\s\u00a0]+/g, " ").trim();

function label($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
  const aria = $(el).attr("aria-label")?.trim();
  return clean(aria || $(el).text() || ($(el).find("img[alt]").first().attr("alt") ?? ""));
}

/** The text of a top-level menu item: its own link, button or label, not its submenu. */
function itemLabel($: CheerioAPI, li: Parameters<CheerioAPI>[0]): string {
  const own = $(li).children("a, button, span, summary, details > summary").first();
  if (own.length > 0) return label($, own.get(0) as Parameters<CheerioAPI>[0]);
  const copy = $(li).clone();
  copy.find("ul, ol").remove();
  return clean(copy.text());
}

/** Read one page's navigation from the HTML it sent (no JavaScript is run). */
export function readRegions(
  page: Pick<PageSnapshot, "hops" | "finalUrl">,
  rules: NavRules = {},
): PageNav {
  const $ = load(page.hops.at(-1)?.body ?? "");
  const resolve = (href: string | undefined) => {
    if (!href || /^(?:javascript|mailto|tel):/i.test(href.trim())) return undefined;
    try {
      const u = new URL(href.trim(), page.finalUrl);
      return /^https?:$/.test(u.protocol) ? destinationKey(u.href) : undefined;
    } catch {
      return undefined;
    }
  };
  const mobileSel = rules.regions?.mobile ?? MOBILE;
  const mobileEls = $(mobileSel);
  const headerSel = rules.regions?.header ?? "header, nav, [role=banner]";
  const footerSel = rules.regions?.footer ?? "footer, [role=contentinfo]";
  const entries: NavEntry[] = [];
  const counters = new Map<string, number>();
  $("a[href]").each((_, el) => {
    const destination = resolve($(el).attr("href"));
    if (!destination) return;
    if (mobileEls.length > 0 && $(el).closest(mobileSel).length > 0) return;
    const inFooter = $(el).closest(footerSel).length > 0;
    const region: NavRegion = inFooter
      ? "footer"
      : $(el).closest(headerSel).length > 0
        ? "header"
        : "body";
    let parent = "";
    if (region !== "body") {
      // The outermost list item inside the region is the top-level menu item.
      const container = $(el)
        .closest(inFooter ? footerSel : headerSel)
        .get(0);
      const inside = (_: number, x: Parameters<CheerioAPI>[0]) =>
        container !== undefined && $.contains(container, x as never);
      const top = $(el).parents("li").filter(inside).last();
      if (top.length > 0) {
        const ownLink = top.children("a").first().get(0);
        if (ownLink !== el) parent = itemLabel($, top.get(0) as Parameters<CheerioAPI>[0]);
      }
      // Footer columns: a heading above the list names the group.
      if (inFooter && parent === "") {
        // The nearest ancestor inside the footer with a heading of its own names the column.
        const column = $(el)
          .parents()
          .filter(inside)
          .toArray()
          .find((x) => $(x).children("h2, h3, h4, h5, h6").length > 0);
        if (column) parent = clean($(column).children("h2, h3, h4, h5, h6").first().text());
      }
    }
    const key = `${region}|${parent}`;
    const order = counters.get(key) ?? 0;
    counters.set(key, order + 1);
    entries.push({ region, parent, text: label($, el), destination, order });
  });
  const mobile =
    mobileEls.length > 0
      ? [
          ...new Set(
            mobileEls
              .find("a[href]")
              .map((_, el) => resolve($(el).attr("href")))
              .get()
              .filter((d: string | undefined): d is string => d !== undefined),
          ),
        ]
      : undefined;
  // A toggle (aria-controls) whose menu is missing or empty in the HTML: built when it opens.
  const mobileBuiltByScript =
    mobileEls.length === 0 &&
    $("button[aria-controls], [aria-expanded][aria-controls]")
      .toArray()
      .some((t) => {
        const id = $(t).attr("aria-controls") ?? "";
        const target = id ? $(`[id="${id.replace(/"/g, "")}"]`) : $();
        return target.length === 0 || target.find("a[href]").length === 0;
      });
  return { url: page.finalUrl, entries, ...(mobile ? { mobile } : {}), mobileBuiltByScript };
}
