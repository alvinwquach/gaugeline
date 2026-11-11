import { load } from "cheerio/slim";
import type { Fetcher, Hop } from "../fetcher.js";
import { readPrices, type PriceReading } from "../price.js";
import { buildSnapshot } from "../snapshot.js";
import { collectPublished, type PartialRead } from "./collect.js";
import type { ShopifyAdapter, ShopifyOffer } from "./shopify.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { bare, onSite, type PageAnswer } from "./webflow-read.js";

/** Bounds a Shopify read keeps to. There are no flags to raise them. */
export const SHOPIFY_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
  /** Theme preview addresses followed from the home page. */
  previews: 5,
} as const;

export interface ShopifyPageRead {
  id: string;
  type: string;
  slug?: string;
  url: string;
  path: string;
  answer: PageAnswer;
}

/** A product's page set against what the Storefront API says: numbers and flags, no text of the page. */
export interface ShopifyPriceRead {
  offer: ShopifyOffer;
  url: string;
  /** What the page shows. Absent when the page could not be read (see `unread`). */
  page?: PriceReading;
  unread?: string;
}

/** A link on the live site that points at a theme preview, and whether a search engine may list it. */
export interface ShopifyPreviewRead {
  /** The address without any query value: host, path, and the name of the preview parameter. */
  shown: string;
  url: string;
  indexable: boolean;
  /** Why it is indexable: what the page does not say. */
  why: string;
}

/**
 * What the three Shopify checks need, read once. Ids, slugs, addresses, statuses, prices as whole minor
 * units and flags: never a title, a description or any text of a page.
 */
export interface ShopifyReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: ShopifyPageRead[];
  prices: ShopifyPriceRead[];
  previews: ShopifyPreviewRead[];
  /** Parts the platform would not give, with why (a token that may not read, a bad answer). */
  unreadable: { part: string; reason: string }[];
  /** Published items with a page that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadShopifyOptions {
  adapter: ShopifyAdapter;
  /** Asks the live site's own pages only. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://larkspur-ceramics.example. */
  site: string;
  /** Replaces SHOPIFY_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

const NOINDEX = /(^|[\s,:])(noindex|none)(\s*(,|$)|$)/i;

async function fetchHops(fetcher: Fetcher, url: string): Promise<Hop[] | string> {
  try {
    const hops = await fetcher.get(url);
    return hops.length > 0 ? hops : "no answer";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function answerOf(hops: Hop[] | string): PageAnswer {
  if (typeof hops === "string") return { kind: "unread", reason: hops };
  const last = hops.at(-1);
  if (!last) return { kind: "unread", reason: "no answer" };
  if (last.status >= 200 && last.status < 300) return { kind: "page", status: last.status };
  if (last.status === 404 || last.status === 410) return { kind: "missing", status: last.status };
  return { kind: "unread", reason: `the site answered ${last.status}` };
}

/** A preview address: the `preview_theme_id` parameter, or a shopifypreview.com host. Never a guess: only what the site links to. */
function previewTarget(href: string): URL | undefined {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:") return undefined;
    if (u.searchParams.has("preview_theme_id") || /(^|\.)shopifypreview\.com$/i.test(u.hostname))
      return u;
  } catch {
    // not an address
  }
  return undefined;
}

/** Linked preview addresses of the home page, in page order, each once, at most `max`. */
function previewLinks(home: Hop[], max: number): URL[] {
  const last = home.at(-1);
  if (!last) return [];
  const $ = load(last.body ?? "");
  const seen = new Map<string, URL>();
  $("a[href], link[href]").each((_, el) => {
    if (seen.size >= max) return;
    let abs: string;
    try {
      abs = new URL($(el).attr("href") ?? "", last.url).href;
    } catch {
      return;
    }
    const t = previewTarget(abs);
    if (t !== undefined && !seen.has(t.href)) seen.set(t.href, t);
  });
  return [...seen.values()];
}

function judgePreview(url: URL, hops: Hop[]): ShopifyPreviewRead | undefined {
  const last = hops.at(-1);
  if (!last || last.status < 200 || last.status >= 300) return undefined;
  const snap = buildSnapshot(hops);
  const header = last.headers["x-robots-tag"];
  const noindex =
    (snap.metaRobots !== undefined && NOINDEX.test(snap.metaRobots)) ||
    (header !== undefined && NOINDEX.test(header));
  const shown = `${url.host}${url.pathname}${url.searchParams.has("preview_theme_id") ? " (preview_theme_id)" : ""}`;
  const noHash = (u: string): string => u.replace(/#.*$/, "");
  const canonicalElsewhere =
    snap.canonical !== undefined &&
    noHash(snap.canonical) !== noHash(snap.finalUrl) &&
    bare(new URL(snap.canonical).host) === bare(new URL(snap.finalUrl).host);
  const indexable = !noindex && !canonicalElsewhere;
  return {
    shown,
    url: url.href,
    indexable,
    why: noindex
      ? "it says noindex"
      : canonicalElsewhere
        ? "its canonical points at the public page"
        : snap.canonical === undefined
          ? "it has no noindex and no canonical"
          : "it has no noindex and its canonical is itself",
  };
}

/**
 * Read a Shopify site for the Shopify checks: every item published to the Online Store (ids, slugs and
 * paths), one GET of each one's live page, the price and availability of each published product against
 * its page, and the theme preview links the home page offers. A part the token may not read is recorded
 * with its reason and the rest is still read; a rate limit that stays marks the read partial. An item
 * that is hidden from the Online Store has no address and is never asked for or reported.
 */
export async function readShopify(options: ReadShopifyOptions): Promise<ShopifyReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? SHOPIFY_READ_LIMITS.pages;
  const reading: ShopifyReading = {
    site: origin,
    pages: [],
    prices: [],
    previews: [],
    unreadable: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };

  const todo: Omit<ShopifyPageRead, "answer">[] = [];
  try {
    const got = await collectPublished(adapter);
    for (const d of got.docs) {
      const url = d.url === undefined ? undefined : onSite(d.url, origin);
      if (url === undefined) continue;
      todo.push({
        id: d.id,
        type: d.type,
        ...(d.slug !== undefined ? { slug: d.slug } : {}),
        url: url.href,
        path: url.pathname,
      });
    }
    if (got.partial) reading.partial = got.partial;
  } catch (err) {
    if (!(err instanceof AdapterCouldNotCheck)) throw err;
    reading.unreadable.push({ part: "published items", reason: err.reason });
  }

  const offers = new Map<string, ShopifyOffer>();
  if (reading.unreadable.length === 0)
    try {
      for await (const o of adapter.offers()) offers.set(o.id, o);
    } catch (err) {
      if (err instanceof AdapterCouldNotCheck)
        reading.unreadable.push({ part: "product prices", reason: err.reason });
      else if (err instanceof AdapterRateLimitedError)
        reading.partial ??= {
          reason: "rate-limited",
          ...(err.retry !== undefined ? { retry: err.retry } : {}),
          delivered: todo.length,
        };
      else throw err;
    }

  const asked = todo.slice(0, budget);
  reading.pagesSkipped = todo.length - asked.length;
  await Promise.all(
    asked.map(async (p) => {
      const hops = await fetchHops(fetcher, p.url);
      reading.pages.push({ ...p, answer: answerOf(hops) });
      const offer = p.type === "products" ? offers.get(p.id) : undefined;
      if (offer === undefined) return;
      if (typeof hops === "string") reading.prices.push({ offer, url: p.url, unread: hops });
      else {
        const last = hops.at(-1);
        if (last === undefined || last.status < 200 || last.status >= 300)
          reading.prices.push({
            offer,
            url: p.url,
            unread: `the page answered ${last?.status ?? "nothing"}`,
          });
        else
          reading.prices.push({ offer, url: p.url, page: await readPrices(buildSnapshot(hops)) });
      }
    }),
  );
  // Promise.all finishes in any order: put the lists in the order the items were read.
  const order = new Map(todo.map((p, i) => [p.url, i]));
  const byOrder = (a: string, b: string): number => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  reading.pages.sort((a, b) => byOrder(a.url, b.url));
  reading.prices.sort((a, b) => byOrder(a.url, b.url));

  const home = await fetchHops(fetcher, `${origin}/`);
  if (typeof home === "string") reading.unreadable.push({ part: "theme previews", reason: home });
  else {
    const found = await Promise.all(
      previewLinks(home, SHOPIFY_READ_LIMITS.previews).map(async (u) => {
        const hops = await fetchHops(fetcher, u.href);
        return typeof hops === "string" ? undefined : judgePreview(u, hops);
      }),
    );
    for (const f of found) if (f !== undefined) reading.previews.push(f);
  }
  return reading;
}
