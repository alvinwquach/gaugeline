import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Contentstack's delivery token is made for one environment and can only read what is published to it:
 * the Content Delivery API has no write endpoint at all, so the narrowest key is also the one Gaugeline
 * needs. It is sent with the stack's API key (a stack identifier, not a secret on its own). The page is
 * Gaugeline's own: it lists the endpoints used and how to make the token.
 */
export const CONTENTSTACK_DESCRIPTION: AdapterDescription = {
  name: "Contentstack",
  docsUrl: "https://gaugeline.dev/docs/integrations/contentstack",
  keyKind: "read-only",
};

/** The stack's API key (header `api_key`). */
export const CONTENTSTACK_API_KEY = "CONTENTSTACK_API_KEY";
/** A delivery token for ONE environment (header `access_token`). */
export const CONTENTSTACK_DELIVERY_TOKEN = "CONTENTSTACK_DELIVERY_TOKEN";
/** The environment the token is for, such as "production". Required: Gaugeline never guesses it. */
export const CONTENTSTACK_ENVIRONMENT = "CONTENTSTACK_ENVIRONMENT";
/** The stack's region: us (the default), eu, au, azure-na, azure-eu, gcp-na or gcp-eu. */
export const CONTENTSTACK_REGION = "CONTENTSTACK_REGION";

export const entries: readonly AdapterEntry[] = [
  {
    id: "contentstack",
    name: "Contentstack",
    status: "built",
    describe: CONTENTSTACK_DESCRIPTION,
    envVars: [
      CONTENTSTACK_API_KEY,
      CONTENTSTACK_DELIVERY_TOKEN,
      CONTENTSTACK_ENVIRONMENT,
      CONTENTSTACK_REGION,
    ],
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("contentstack", async () => {
      const { createContentstackAdapter } = await import("./contentstack.js");
      return (c, settings) =>
        createContentstackAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (a delivery token for one environment, with the stack's API key)",
      reads:
        "Content types and their published entries as fingerprints and field counts. Drafts are out of reach of a delivery token by design. [Endpoints and the token](/docs/integrations/contentstack)",
    },
    page: {
      slug: "integrations/contentstack",
      title: "Contentstack: content checks for sites built on Contentstack",
    },
  },
];
