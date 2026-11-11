import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Tideline Print Shop's invented Squarespace store: a pop-up shop a freelancer built, selling prints, a tote
 * bag, a zine and a card set that is not on sale yet. Nothing here was recorded from a real store, every
 * address is on a reserved `.example` domain, and every value is invented. The shapes follow Squarespace's
 * Commerce Products and Inventory APIs as far as they could be confirmed (the docs page says which parts
 * are `uncited`): a list answers `{ products | inventory, pagination: { hasNextPage, nextPageCursor } }`,
 * a price is a decimal text with a currency, stock is a quantity or "unlimited".
 */
export const SQUARESPACE_COMMERCE_SITE = "https://tideline-prints.example";
export const SQUARESPACE_COMMERCE_HOST = "api.squarespace.com";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const SQUARESPACE_COMMERCE_MARKERS = {
  dawn: "Harbour at Dawn: a pale harbour wall, printed on cotton paper",
  dawnText: "Two sizes, signed and numbered, shipped flat in a board mailer",
  tote: "Tide Chart tote with the autumn tide tables printed on it",
  toteText: "Heavy canvas, long handles, made in a batch of fifty",
  cards: "Winter card set, six designs, not announced yet",
  cardsText: "Prices and the launch date are still being decided",
  zine: "Sea Glass zine, thirty pages of beach finds",
} as const;

export interface FixtureVariant {
  id: string;
  sku: string;
  currency: string;
  base: string;
  /** Present when the variant is on sale. */
  sale?: string;
  /** Inventory: a quantity, or "unlimited"; undefined means the Inventory API has no row for it. */
  stock?: number | "unlimited";
}

export interface FixtureProduct {
  id: string;
  type: "PHYSICAL" | "SERVICE" | "DIGITAL" | "GIFT_CARD";
  urlSlug: string;
  url: string;
  isVisible: boolean;
  name: string;
  description?: string;
  createdOn: string;
  modifiedOn: string;
  variants: FixtureVariant[];
}

export const SQUARESPACE_COMMERCE_PRODUCTS: FixtureProduct[] = [
  {
    id: "p-dawn",
    type: "PHYSICAL",
    urlSlug: "harbour-at-dawn",
    url: "/shop/harbour-at-dawn",
    isVisible: true,
    name: SQUARESPACE_COMMERCE_MARKERS.dawn,
    description: SQUARESPACE_COMMERCE_MARKERS.dawnText,
    createdOn: "2026-10-01T09:00:00.000Z",
    modifiedOn: "2026-10-20T08:30:00.000Z",
    variants: [
      { id: "v-dawn-a4", sku: "DAWN-A4", currency: "USD", base: "28.00", stock: 12 },
      { id: "v-dawn-a3", sku: "DAWN-A3", currency: "USD", base: "45.00", stock: 3 },
    ],
  },
  {
    id: "p-tote",
    type: "PHYSICAL",
    urlSlug: "tide-chart-tote",
    url: "/shop/tide-chart-tote",
    isVisible: true,
    name: SQUARESPACE_COMMERCE_MARKERS.tote,
    description: SQUARESPACE_COMMERCE_MARKERS.toteText,
    createdOn: "2026-10-05T09:00:00.000Z",
    modifiedOn: "2026-11-02T17:00:00.000Z",
    // On sale: a buyer pays the sale price. Sold out: the Inventory API says quantity 0.
    variants: [
      { id: "v-tote", sku: "TOTE-1", currency: "USD", base: "40.00", sale: "32.00", stock: 0 },
    ],
  },
  // Hidden in the store: a draft. The published list never holds it.
  {
    id: "p-cards",
    type: "PHYSICAL",
    urlSlug: "winter-card-set",
    url: "/shop/winter-card-set",
    isVisible: false,
    name: SQUARESPACE_COMMERCE_MARKERS.cards,
    description: SQUARESPACE_COMMERCE_MARKERS.cardsText,
    createdOn: "2026-11-09T10:00:00.000Z",
    modifiedOn: "2026-11-09T10:00:00.000Z",
    variants: [{ id: "v-cards", sku: "CARDS-6", currency: "USD", base: "12.00", stock: 5 }],
  },
  // No description: a field an item lacks is left out of its hashes, never hashed as empty.
  {
    id: "p-zine",
    type: "PHYSICAL",
    urlSlug: "sea-glass-zine",
    url: "/shop/sea-glass-zine",
    isVisible: true,
    name: SQUARESPACE_COMMERCE_MARKERS.zine,
    createdOn: "2026-10-12T09:00:00.000Z",
    modifiedOn: "2026-10-12T09:00:00.000Z",
    variants: [{ id: "v-zine", sku: "ZINE-1", currency: "USD", base: "9.50", stock: "unlimited" }],
  },
];

export interface SquarespaceCommerceFixtureOptions {
  /** When set, a request without `Authorization: Bearer <token>` is answered 401. */
  token?: string;
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
  /** The Inventory API answers 403: a key with the Products permission and not the Inventory one. */
  inventory?: "ok" | "forbidden";
  /** Items in one page of a list. The real API's size is fixed; a small one makes the cursor walk visible. */
  pageSize?: number;
  /** Replaces what each list says about whether another page follows (a hostile server). */
  paging?: (list: "products" | "inventory", page: number, cursor: string | undefined) => unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const html = (status: number, body: string) =>
  Promise.resolve({
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Readable.from([Buffer.from(body)]),
  });

const productJson = (p: FixtureProduct) => ({
  id: p.id,
  type: p.type,
  storePageId: "page-shop",
  name: p.name,
  ...(p.description !== undefined ? { description: p.description } : {}),
  url: p.url,
  urlSlug: p.urlSlug,
  tags: [],
  isVisible: p.isVisible,
  variants: p.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    pricing: {
      basePrice: { currency: v.currency, value: v.base },
      onSale: v.sale !== undefined,
      salePrice: { currency: v.currency, value: v.sale ?? "0.00" },
    },
  })),
  createdOn: p.createdOn,
  modifiedOn: p.modifiedOn,
});

/**
 * Squarespace's Commerce API over the invented store: GET only, cursor pages, a key in the Authorization
 * header. The first page has no cursor; a page names the next one with `nextPageCursor`.
 */
export function squarespaceCommerceTransport(
  products: readonly FixtureProduct[] = SQUARESPACE_COMMERCE_PRODUCTS,
  options: SquarespaceCommerceFixtureOptions = {},
): Transport {
  const size = options.pageSize ?? 2;
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== SQUARESPACE_COMMERCE_HOST) return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { message: "Request not authorized" });

    const list = (name: "products" | "inventory", rows: unknown[]) => {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const page = cursor === undefined ? 0 : Number(/^c(\d+)$/.exec(cursor)?.[1] ?? "NaN");
      if (!Number.isInteger(page)) return json(400, { message: "bad cursor" });
      const slice = rows.slice(page * size, (page + 1) * size);
      const more = (page + 1) * size < rows.length;
      const paging = options.paging?.(name, page, cursor) ?? {
        hasNextPage: more,
        nextPageCursor: more ? `c${page + 1}` : null,
        nextPageUrl: more ? `https://elsewhere.example/steal?cursor=c${page + 1}` : "",
      };
      return json(200, { [name]: slice, pagination: paging });
    };

    if (url.pathname === "/1.0/commerce/products")
      return list("products", products.map(productJson));
    if (url.pathname === "/1.0/commerce/inventory") {
      if (options.inventory === "forbidden") return json(403, { message: "forbidden" });
      return list(
        "inventory",
        products.flatMap((p) =>
          p.variants.flatMap((v) =>
            v.stock === undefined
              ? []
              : [
                  {
                    variantId: v.id,
                    sku: v.sku,
                    descriptor: "invented",
                    isUnlimited: v.stock === "unlimited",
                    quantity: v.stock === "unlimited" ? 0 : v.stock,
                  },
                ],
          ),
        ),
      );
    }
    return json(404, { message: "no such route" });
  };
}

/** What a product page of the invented shop shows, for the page side of the price and stock checks. */
export interface ShownProduct {
  /** The price in the product data and on the page, as the page writes it ("28.00"). */
  price?: string;
  currency?: string;
  /** schema.org availability without the prefix: "InStock", "OutOfStock". */
  availability?: string;
  /** More offers, for a product with several variants: each its own price. */
  more?: { price: string; availability?: string }[];
  /** Text of the visible price element, when the page has no product data. */
  visible?: string;
}

/** A product page the way a Squarespace store writes one: schema.org Product data in a script tag. */
export function productPage(shown: ShownProduct): string {
  const offers = [
    ...(shown.price !== undefined
      ? [
          {
            price: shown.price,
            ...(shown.availability ? { availability: shown.availability } : {}),
          },
        ]
      : []),
    ...(shown.more ?? []),
  ].map((o) => ({
    "@type": "Offer",
    price: o.price,
    priceCurrency: shown.currency ?? "USD",
    ...("availability" in o && o.availability
      ? { availability: `https://schema.org/${o.availability}` }
      : {}),
  }));
  const data =
    offers.length === 0
      ? ""
      : `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Invented", offers })}</script>`;
  const visible =
    shown.visible !== undefined ? `<div class="product-price">${shown.visible}</div>` : "";
  return `<!doctype html><html lang="en"><head><title>Invented product</title>${data}</head><body><h1>Invented</h1>${visible}</body></html>`;
}

/** The shop's pages by path: a status and what the page shows. Any other path is 404. */
export type ShopPages = Record<string, ShownProduct | number>;

/** The healthy shop: every visible product's page shows what the API says. */
export const HEALTHY_PAGES: ShopPages = {
  "/shop/harbour-at-dawn": {
    price: "28.00",
    availability: "InStock",
    more: [{ price: "45.00", availability: "InStock" }],
  },
  "/shop/tide-chart-tote": { price: "32.00", availability: "OutOfStock" },
  "/shop/sea-glass-zine": { price: "9.50", availability: "InStock" },
};

/** The live site: the product pages above, and nothing from the API host. */
export function squarespaceShopTransport(
  pages: ShopPages = HEALTHY_PAGES,
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void,
): Transport {
  return (url, req) => {
    onRequest?.(req.method, url, req.headers);
    if (url.origin !== SQUARESPACE_COMMERCE_SITE) return html(404, "not here");
    const page = pages[url.pathname];
    if (page === undefined) return html(404, "<html><body>Not found</body></html>");
    if (typeof page === "number") return html(page, "<html><body>Error</body></html>");
    return html(200, productPage(page));
  };
}

/** Both sides in one transport: the API host and the shop, as a run over a real store sees them. */
export function squarespaceStoreTransport(
  pages: ShopPages = HEALTHY_PAGES,
  api: Parameters<typeof squarespaceCommerceTransport>[1] = {},
  products: readonly FixtureProduct[] = SQUARESPACE_COMMERCE_PRODUCTS,
): Transport {
  const apiSide = squarespaceCommerceTransport(products, api);
  const shopSide = squarespaceShopTransport(pages, api.onRequest);
  return (url, req) =>
    url.host === SQUARESPACE_COMMERCE_HOST ? apiSide(url, req) : shopSide(url, req);
}
