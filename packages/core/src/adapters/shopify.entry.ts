import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Shopify adapter reads the Storefront API, whose access token is public and read-only by design:
 * it can only read what the Online Store shows every visitor. The Admin API is not used (its tokens
 * can carry write scopes). The page is Gaugeline's own: it lists the endpoint and how to make the token.
 */
export const SHOPIFY_DESCRIPTION: AdapterDescription = {
  name: "Shopify",
  docsUrl: "https://gaugeline.dev/docs/integrations/shopify",
  keyKind: "read-only",
};

/** The variable the Storefront API access token comes from. The adapter imports it from here. */
export const SHOPIFY_STOREFRONT_TOKEN = "SHOPIFY_STOREFRONT_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "shopify",
    name: "Shopify",
    status: "built",
    describe: SHOPIFY_DESCRIPTION,
    envVars: [SHOPIFY_STOREFRONT_TOKEN, "SHOPIFY_SHOP_DOMAIN", "SHOPIFY_API_VERSION"],
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("shopify", async () => {
      const { createShopifyAdapter } = await import("./shopify.js");
      return (c, settings) =>
        createShopifyAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (a Storefront API access token, which is public and read-only by design)",
      reads:
        "Products, collections, pages, blogs and articles published to the Online Store, as fingerprints and counts. Through `readShopify` (a library read; the CLI does not run it yet), whether a published item's page answers on the live site. [Endpoint and the token](/docs/integrations/shopify)",
    },
    page: {
      slug: "integrations/shopify",
      title: "Shopify: content checks for sites built on Shopify",
    },
  },
];
