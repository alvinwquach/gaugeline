import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Larkspur Ceramics' invented Shopify store: a small studio selling hand-thrown mugs and bowls, with a few
 * pages and a journal. Nothing here was recorded from a real store, and every address is on a reserved
 * `.example` domain. The shapes follow the Storefront API's GraphQL connections (`nodes`, `pageInfo`
 * with `hasNextPage` and `endCursor`, `onlineStoreUrl` null when the item is not published to the Online
 * Store) as the adapter reads them; every value is invented.
 */
export const SHOPIFY_SITE = "https://larkspur-ceramics.example";
export const SHOPIFY_SHOP = "larkspur-ceramics.myshopify.com";
export const SHOPIFY_VERSION = "2025-07";

/** Text that is in the client's content, hidden items included, and must never reach a report, a log or a hash input. */
export const SHOPIFY_MARKERS = {
  mug: "Speckled mug, thrown in a morning and fired twice",
  mugDescription: "Holds three hundred millilitres and is dishwasher safe",
  bowl: "Ash glaze bowl with a thumb rest",
  seconds: "Kiln seconds box, not yet photographed",
  collection: "Everything we make for the table",
  about: "Two potters in a converted bakery",
  hours: "Open Saturdays from ten until four",
  blog: "Studio notes",
  article: "Testing a new spring glaze on forty tiles",
} as const;

export interface FixtureNode {
  id: string;
  handle: string;
  /** null: not published to the Online Store (hidden on purpose). */
  onlineStoreUrl: string | null;
  updatedAt?: string;
  publishedAt?: string;
  [field: string]: unknown;
}

export const SHOPIFY_CONTENT: Record<string, FixtureNode[]> = {
  products: [
    {
      id: "gid://shopify/Product/1001",
      handle: "mug-speckled",
      onlineStoreUrl: `${SHOPIFY_SITE}/products/mug-speckled`,
      updatedAt: "2026-10-20T08:30:00Z",
      publishedAt: "2026-10-01T09:00:00Z",
      title: SHOPIFY_MARKERS.mug,
      description: SHOPIFY_MARKERS.mugDescription,
      availableForSale: true,
      priceRange: {
        minVariantPrice: { amount: "28.00", currencyCode: "USD" },
        maxVariantPrice: { amount: "28.00", currencyCode: "USD" },
      },
    },
    // No description: a field an item lacks is left out of its hashes, never hashed as empty.
    {
      id: "gid://shopify/Product/1002",
      handle: "bowl-ash-glaze",
      onlineStoreUrl: `${SHOPIFY_SITE}/products/bowl-ash-glaze`,
      updatedAt: "2026-11-02T17:00:00Z",
      publishedAt: "2026-10-05T09:00:00Z",
      title: SHOPIFY_MARKERS.bowl,
      description: "",
      availableForSale: false,
      priceRange: {
        minVariantPrice: { amount: "42.50", currencyCode: "USD" },
        maxVariantPrice: { amount: "42.50", currencyCode: "USD" },
      },
    },
    // Hidden from the Online Store: the API still answers it, with no address. Never reported as missing.
    {
      id: "gid://shopify/Product/1003",
      handle: "kiln-seconds-box",
      onlineStoreUrl: null,
      updatedAt: "2026-11-09T10:00:00Z",
      publishedAt: "2026-11-09T10:00:00Z",
      title: SHOPIFY_MARKERS.seconds,
      description: SHOPIFY_MARKERS.seconds,
      availableForSale: true,
      priceRange: {
        minVariantPrice: { amount: "60.00", currencyCode: "USD" },
        maxVariantPrice: { amount: "60.00", currencyCode: "USD" },
      },
    },
  ],
  collections: [
    {
      id: "gid://shopify/Collection/2001",
      handle: "mugs",
      onlineStoreUrl: `${SHOPIFY_SITE}/collections/mugs`,
      updatedAt: "2026-10-21T08:00:00Z",
      title: "Mugs",
      description: SHOPIFY_MARKERS.collection,
    },
    {
      id: "gid://shopify/Collection/2002",
      handle: "bowls",
      onlineStoreUrl: `${SHOPIFY_SITE}/collections/bowls`,
      updatedAt: "2026-10-22T08:00:00Z",
      title: "Bowls",
      description: SHOPIFY_MARKERS.collection,
    },
  ],
  pages: [
    {
      id: "gid://shopify/Page/3001",
      handle: "about",
      onlineStoreUrl: `${SHOPIFY_SITE}/pages/about`,
      updatedAt: "2026-09-01T09:00:00Z",
      title: "About",
      body: SHOPIFY_MARKERS.about,
    },
    {
      id: "gid://shopify/Page/3002",
      handle: "studio-hours",
      onlineStoreUrl: `${SHOPIFY_SITE}/pages/studio-hours`,
      updatedAt: "2026-10-10T09:00:00Z",
      title: "Studio hours",
      body: SHOPIFY_MARKERS.hours,
    },
  ],
  blogs: [
    {
      id: "gid://shopify/Blog/4001",
      handle: "news",
      onlineStoreUrl: `${SHOPIFY_SITE}/blogs/news`,
      title: SHOPIFY_MARKERS.blog,
    },
  ],
  articles: [
    {
      id: "gid://shopify/Article/5001",
      handle: "spring-glaze-test",
      onlineStoreUrl: `${SHOPIFY_SITE}/blogs/news/spring-glaze-test`,
      publishedAt: "2026-10-12T09:00:00Z",
      title: SHOPIFY_MARKERS.article,
      content: SHOPIFY_MARKERS.article,
    },
  ],
};

export interface ShopifyFixtureOptions {
  /** When set, a request without this Storefront access token is answered 401. */
  token?: string;
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, body: string | undefined) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** The cursor the fixture gives for a position: opaque to the adapter. */
const cursorAt = (n: number): string => `cursor-${n}`;

/**
 * The Storefront API over the invented store. Only a POST to the store's own `/api/<version>/graphql.json`
 * is answered; a list answers at most 250 nodes a page with `pageInfo`, and a token that is not the
 * configured one is a 401. Nothing here ever changes.
 */
export function shopifyTransport(
  content: Record<string, readonly FixtureNode[]> = SHOPIFY_CONTENT,
  options: ShopifyFixtureOptions = {},
): Transport {
  return (url, req) => {
    options.onRequest?.(req.method, url, req.body);
    if (url.host !== SHOPIFY_SHOP) return json(404, { message: "not here" });
    if (req.method !== "POST") return json(405, { message: "method not allowed" });
    if (url.pathname !== `/api/${SHOPIFY_VERSION}/graphql.json`) return json(404, {});
    if (
      options.token !== undefined &&
      req.headers["x-shopify-storefront-access-token"] !== options.token
    )
      return json(401, { errors: "Unauthorized" });
    const body = JSON.parse(req.body ?? "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";
    const root = /^query Read\(\$first: Int!, \$after: String\) \{ (\w+)\(/.exec(query)?.[1];
    const nodes = root === undefined ? undefined : content[root];
    if (nodes === undefined) return json(200, { errors: [{ message: "unknown query" }] });
    const first = Number(body.variables?.first);
    if (!Number.isInteger(first) || first < 1 || first > 250)
      return json(200, { errors: [{ message: "first must be 1 to 250" }] });
    const after = body.variables?.after;
    const start = typeof after === "string" ? Number(/^cursor-(\d+)$/.exec(after)?.[1] ?? NaN) : 0;
    if (!Number.isInteger(start)) return json(200, { errors: [{ message: "bad cursor" }] });
    const page = nodes.slice(start, start + first);
    const end = start + page.length;
    return json(200, {
      data: {
        [root as string]: {
          nodes: page,
          pageInfo: { hasNextPage: end < nodes.length, endCursor: end > 0 ? cursorAt(end) : null },
        },
      },
    });
  };
}

/** A product page as a theme prints it: the price in the theme's element, and the product data in JSON-LD. */
export function productHtml(
  price: string,
  currency = "USD",
  availability = "InStock",
  extra = "",
): string {
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    offers: {
      "@type": "Offer",
      price,
      priceCurrency: currency,
      availability: `https://schema.org/${availability}`,
    },
  });
  return `<!doctype html><html><head><title>Product</title><script type="application/ld+json">${ld}</script></head><body><span class="price-item--regular">$${price}</span>${extra}</body></html>`;
}

export interface LivePage {
  status?: number;
  headers?: Record<string, string>;
  html?: string;
}

/** The live site's pages by path. A number is a status with an empty body. */
export type LivePages = Readonly<Record<string, number | LivePage>>;

export const LIVE_HEALTHY: LivePages = {
  "/": { html: "<html><body><a href='/products/mug-speckled'>Mug</a></body></html>" },
  "/products/mug-speckled": { html: productHtml("28.00") },
  "/products/bowl-ash-glaze": { html: productHtml("42.50", "USD", "OutOfStock") },
  "/collections/mugs": 200,
  "/collections/bowls": 200,
  "/pages/about": 200,
  "/pages/studio-hours": 200,
  "/blogs/news": 200,
  "/blogs/news/spring-glaze-test": 200,
};

/** The store's Storefront API and its live site, in one transport. Any path not listed on the live site is a 404. */
export function shopifyStoreTransport(
  pages: LivePages = LIVE_HEALTHY,
  options: ShopifyFixtureOptions = {},
  content: Record<string, readonly FixtureNode[]> = SHOPIFY_CONTENT,
): Transport {
  const api = shopifyTransport(content, options);
  return (url, req) => {
    if (url.host === SHOPIFY_SHOP) return api(url, req);
    options.onRequest?.(req.method, url, req.body);
    if (url.host !== new URL(SHOPIFY_SITE).host) return json(404, {});
    const key = `${url.pathname}${url.search}`;
    const hit = pages[key] ?? pages[url.pathname];
    const page: LivePage = typeof hit === "number" ? { status: hit } : (hit ?? { status: 404 });
    return Promise.resolve({
      status: page.status ?? 200,
      headers: { "content-type": "text/html", ...page.headers },
      body: Readable.from([Buffer.from(page.html ?? "<html><body></body></html>")]),
    });
  };
}
