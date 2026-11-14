import { load } from "cheerio/slim";
import type { Fetcher, Hop } from "../fetcher.js";
import { readPrices, type PriceReading } from "../price.js";
import { buildSnapshot } from "../snapshot.js";
import { collectPublished, type PartialRead } from "./collect.js";
import {
  SHOPIFY_TYPES,
  shopHost as normaliseShopHost,
  type ShopifyAdapter,
  type ShopifyOffer,
} from "./shopify.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { bare, onSite, type PageAnswer } from "./webflow-read.js";

/** Bounds a Shopify read keeps to. There are no flags to raise them. */
export const SHOPIFY_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
  /** Theme preview addresses followed from the home page. */
  previews: 5,
} as const;

/** How the live site answered for a page: as the page, gone, unread, or a redirect to the home page (the store's way of hiding a page). */
export type ShopifyAnswer = PageAnswer | { kind: "redirected-home"; status: number };

export interface ShopifyPageRead {
  id: string;
  type: string;
  slug?: string;
  url: string;
  path: string;
  answer: ShopifyAnswer;
}

/** A product's page set against what the Storefront API says: numbers and flags, no text of the page. */
export interface ShopifyPriceRead {
  /** The product's slug (its handle). */
  slug: string;
  /** What the Storefront API said. Absent when the price read gave nothing for this published product (see `unread`). */
  offer?: ShopifyOffer;
  url: string;
  /** What the page shows. Absent when the page could not be read (see `unread`). */
  page?: PriceReading;
  /** The availability of every offer in the page's product data, without the schema.org prefix ("InStock"). One per variant when the theme lists them. */
  offerAvailability?: string[];
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
  /** Of those, the products whose price and availability were therefore not compared. */
  productsSkipped: number;
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
  /**
   * The shop's own myshopify.com host (SHOPIFY_SHOP_DOMAIN, already checked). A theme preview is asked for only
   * on the live site's own host, on this host, or on this shop's shopifypreview.com host; with none given, only
   * on the live site's own host.
   */
  shopHost?: string | undefined;
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

function answerOf(hops: Hop[] | string, requested: string): ShopifyAnswer {
  if (typeof hops === "string") return { kind: "unread", reason: hops };
  const last = hops.at(-1);
  if (!last) return { kind: "unread", reason: "no answer" };
  if (last.status >= 200 && last.status < 300) {
    // A 200 is not proof of the page: the store may have sent the visitor to its password page or home page.
    let from: string;
    let to: string;
    try {
      from = new URL(requested).pathname;
      to = new URL(last.url).pathname;
    } catch {
      return { kind: "page", status: last.status };
    }
    if (to !== from && /^\/password(?:\/|$)/i.test(to))
      return {
        kind: "unread",
        reason: "the store is password protected, so the page could not be read",
      };
    if (to !== from && to === "/" && hops.length > 1)
      return { kind: "redirected-home", status: hops[0]?.status ?? last.status };
    return { kind: "page", status: last.status };
  }
  if (last.status === 404 || last.status === 410) return { kind: "missing", status: last.status };
  return { kind: "unread", reason: `the site answered ${last.status}` };
}

/** The availability of every offer in the page's product data ("InStock", "OutOfStock"...), one per variant when listed. */
function availabilitiesOf(jsonLd: unknown[]): string[] {
  const out: string[] = [];
  const offers = (raw: unknown): void => {
    if (Array.isArray(raw)) return raw.forEach(offers);
    if (raw === null || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    if (typeof o.availability === "string")
      out.push(o.availability.replace(/^https?:\/\/schema\.org\//, ""));
    if (o.offers !== undefined) offers(o.offers);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const type = o["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) offers(o.offers);
    if (o["@graph"] !== undefined) visit(o["@graph"]);
  };
  jsonLd.forEach(visit);
  return out;
}

/** A host that belongs to Shopify's own preview or store names: such a link is judged by whose it is. */
const SHOPIFY_HOST = /(^|\.)(myshopify|shopifypreview)\.com$/;

/**
 * A preview address the site links to, and whether it may be asked for. Only on the live site's own host, on the
 * configured shop's myshopify.com host, or on that shop's own shopifypreview.com host (its handle, then
 * `.shopifypreview.com`); and on the first two only with the `preview_theme_id` parameter. Another store's address
 * is "refused": never asked for and never shown, but counted so the run can say so. An address on any other host
 * is not Shopify's business and is ignored. Never a guess: only what the site itself links to.
 */
export function previewTarget(
  href: string,
  siteHost: string,
  shopHost: string | undefined,
): URL | "refused" | undefined {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:") return undefined;
    // The hostname (no port) says whose address it is; the host (with its port) says which server. A Shopify name is
    // judged by its hostname alone, with a root dot dropped; "own" is judged by host, so another port is another server.
    const name = u.hostname.toLowerCase().replace(/\.$/, "");
    const host = u.host.toLowerCase().replace(/\.(?=$|:)/, "");
    const shop = shopHost === undefined ? undefined : normaliseShopHost(shopHost);
    const handle = shop?.replace(/\.myshopify\.com$/, "");
    const ownHost = bare(host) === bare(siteHost) || host === shop;
    if (ownHost) return u.searchParams.has("preview_theme_id") ? u : undefined;
    if (!SHOPIFY_HOST.test(name)) return undefined;
    if (handle !== undefined && host === `${handle}.shopifypreview.com`) return u;
    return "refused";
  } catch {
    // not an address
  }
  return undefined;
}

/** The address as it is shown and put in a finding: host and path, and only the preview_theme_id parameter. Any other parameter (a key, a token) is dropped. */
function shownUrl(u: URL): string {
  const id = u.searchParams.get("preview_theme_id");
  const query = id === null ? "" : `?preview_theme_id=${encodeURIComponent(id)}`;
  return `${u.origin}${u.pathname}${query}`;
}

/** Linked preview addresses of the home page, in page order, each once, at most `max`; and how many linked Shopify addresses were refused as not this store's. */
function previewLinks(
  home: Hop[],
  max: number,
  siteHost: string,
  shopHost: string | undefined,
): { urls: URL[]; refused: number } {
  const last = home.at(-1);
  if (!last) return { urls: [], refused: 0 };
  const $ = load(last.body ?? "");
  const seen = new Map<string, URL>();
  const refused = new Set<string>();
  $("a[href], link[href]").each((_, el) => {
    let abs: string;
    try {
      abs = new URL($(el).attr("href") ?? "", last.url).href;
    } catch {
      return;
    }
    const t = previewTarget(abs, siteHost, shopHost);
    if (t === "refused") refused.add(abs);
    else if (t !== undefined && seen.size < max && !seen.has(t.href)) seen.set(t.href, t);
  });
  return { urls: [...seen.values()], refused: refused.size };
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
  // A canonical to a different address, on any host, asks search engines to list that address instead.
  const canonicalElsewhere =
    snap.canonical !== undefined && noHash(snap.canonical) !== noHash(snap.finalUrl);
  const indexable = !noindex && !canonicalElsewhere;
  return {
    shown,
    url: shownUrl(url),
    indexable,
    why: noindex
      ? "it says noindex"
      : canonicalElsewhere
        ? "its canonical points at a different address"
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
    productsSkipped: 0,
    pageBudget: budget,
  };

  const todo: Omit<ShopifyPageRead, "answer">[] = [];
  // Products first: they are what the drift check needs, and what a page budget should cut last.
  const ORDER = ["products", "pages", "collections", "articles", "blogs"].filter(
    (t) => t in SHOPIFY_TYPES,
  );
  const unreadableTypes = new Set<string>();
  for (const type of ORDER) {
    try {
      const got = await collectPublished(adapter, { types: [type] });
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
      if (got.partial) {
        reading.partial = got.partial;
        break;
      }
    } catch (err) {
      // One type the token may not read does not stop the others.
      if (!(err instanceof AdapterCouldNotCheck)) throw err;
      unreadableTypes.add(type);
      reading.unreadable.push({ part: type, reason: err.reason });
    }
  }
  for (const k of adapter.skipped())
    reading.unreadable.push({
      part: `${k.type} ${k.id}`,
      reason: `${k.reason}; it was not checked`,
    });

  if (adapter.skippedMore() > 0)
    reading.unreadable.push({
      part: "more skipped items",
      reason: `${adapter.skippedMore()} more items were skipped for the same kinds of reasons and are not listed`,
    });

  const offers = new Map<string, ShopifyOffer>();
  let offersRead = !unreadableTypes.has("products");
  if (offersRead)
    try {
      for await (const o of adapter.offers()) offers.set(o.id, o);
    } catch (err) {
      offersRead = false;
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
  reading.productsSkipped = todo.slice(budget).filter((p) => p.type === "products").length;
  await Promise.all(
    asked.map(async (p) => {
      const hops = await fetchHops(fetcher, p.url);
      const answer = answerOf(hops, p.url);
      reading.pages.push({ ...p, answer });
      if (p.type !== "products") return;
      const offer = offers.get(p.id);
      // A published product the price read gave nothing for is said, never dropped. (When the whole price read
      // failed, that is already in `unreadable`.)
      if (offer === undefined) {
        if (offersRead)
          reading.prices.push({
            slug: p.slug ?? p.id,
            url: p.url,
            unread: "no price from the Storefront API",
          });
        return;
      }
      if (answer.kind !== "page" || typeof hops === "string")
        reading.prices.push({
          slug: p.slug ?? p.id,
          offer,
          url: p.url,
          unread:
            answer.kind === "unread"
              ? answer.reason
              : `the page answered ${answer.kind === "missing" ? answer.status : "with a redirect"}`,
        });
      else {
        const snap = buildSnapshot(hops);
        reading.prices.push({
          slug: p.slug ?? p.id,
          offer,
          url: p.url,
          page: await readPrices(snap),
          offerAvailability: availabilitiesOf(snap.jsonLd),
        });
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
    const links = previewLinks(
      home,
      SHOPIFY_READ_LIMITS.previews,
      new URL(origin).host,
      options.shopHost,
    );
    if (links.refused > 0)
      reading.unreadable.push({
        part: "theme previews",
        reason: `${links.refused} linked ${links.refused === 1 ? "address is" : "addresses are"} on a Shopify host that is not this store's, so ${links.refused === 1 ? "it was" : "they were"} not asked for`,
      });
    const found = await Promise.all(
      links.urls.map(async (u) => {
        const hops = await fetchHops(fetcher, u.href);
        return typeof hops === "string" ? undefined : judgePreview(u, hops);
      }),
    );
    for (const f of found) if (f !== undefined) reading.previews.push(f);
  }
  return reading;
}
