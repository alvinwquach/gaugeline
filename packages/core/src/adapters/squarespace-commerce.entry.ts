import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Squarespace's Commerce APIs (Products and Inventory) take an API key made in the site's Developer API
 * Keys settings, with a permission chosen per API. Gaugeline asks for "Products" and "Inventory" set to
 * read, and nothing else: the key then cannot change a product or an order. Pages and blog posts have no
 * read API, so they stay with the live-site adapter (`builders`). The page is Gaugeline's own: it lists the
 * endpoints used and how to make the key.
 */
export const SQUARESPACE_COMMERCE_DESCRIPTION: AdapterDescription = {
  name: "Squarespace commerce",
  docsUrl: "https://gaugeline.dev/docs/integrations/squarespace-commerce",
  keyKind: "read-only",
};

/** The variable the key comes from. The adapter imports it from here. */
export const SQUARESPACE_COMMERCE_TOKEN = "SQUARESPACE_COMMERCE_TOKEN";

/** The one content type this adapter has: the store's products. */
export const SQUARESPACE_COMMERCE_TYPE = "products";

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in
 * plain data, because the checks quote them and a check may not import the adapter module.
 */
export const SQUARESPACE_COMMERCE_LIMITS = {
  /** Items read from one list. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Pages read from one list (the API's page size is fixed, so this bounds a server that never says "last"). */
  pagesPerList: 400,
  /** Product pages asked for on the live site in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "squarespace-commerce",
    name: "Squarespace commerce",
    status: "built",
    describe: SQUARESPACE_COMMERCE_DESCRIPTION,
    envVars: [SQUARESPACE_COMMERCE_TOKEN],
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("squarespace-commerce", async () => {
      const { createSquarespaceCommerceAdapter } = await import("./squarespace-commerce.js");
      return (c, settings) =>
        createSquarespaceCommerceAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (an API key with Products and Inventory set to read)",
      reads:
        "The Commerce Products and Inventory APIs: product prices and stock, compared with the product pages. Pages and blogs have no read API. [Endpoints and the key](/docs/integrations/squarespace-commerce)",
    },
    page: {
      slug: "integrations/squarespace-commerce",
      title: "Squarespace commerce: price and stock checks for stores built on Squarespace",
    },
  },
];
