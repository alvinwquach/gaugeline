import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Umbraco (13 and newer) answers a read-only REST API, the Content Delivery API, that is off until the site's
 * owner turns it on. Gaugeline asks for the narrowest key there is: none when the API is public, and the
 * Delivery API key (the `Api-Key` header, which can only read) when the API is protected. The page is
 * Gaugeline's own: it lists the endpoints used and how to set the key.
 */
export const UMBRACO_DESCRIPTION: AdapterDescription = {
  name: "Umbraco",
  docsUrl: "https://gaugeline.dev/docs/integrations/umbraco",
  keyKind: "read-only",
};

/** The site's own address, https only: the Delivery API lives on the Umbraco site itself. Not a key. */
export const UMBRACO_URL = "UMBRACO_URL";
/** The Delivery API key, sent in the `Api-Key` header to UMBRACO_URL's origin only. Optional when the API is public. */
export const UMBRACO_API_KEY = "UMBRACO_API_KEY";

/** Every variable the Umbraco adapter may read. Only the API key is a key. */
export const UMBRACO_ENV_VARS = [UMBRACO_URL, UMBRACO_API_KEY] as const;

/** Items asked for in one request. The API's default is 10: Gaugeline asks for more and steps by what comes back. */
export const UMBRACO_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Umbraco checks quote them and a check may not import the adapter module.
 */
export const UMBRACO_LIMITS = {
  /** Items read from one content type. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Requests spent on one list. A server that hands out a few items at a time ends here, as could-not-check. */
  requestsPerList: 500,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "umbraco",
    name: "Umbraco",
    status: "built",
    describe: UMBRACO_DESCRIPTION,
    envVars: UMBRACO_ENV_VARS,
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("umbraco", async () => {
      const { createUmbracoAdapter } = await import("./umbraco.js");
      return (c, settings) =>
        createUmbracoAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    settings: { expectPrivate: true },
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "none if the Delivery API is public; read-only (the Delivery API key) if it is protected",
      reads:
        "The content types you name, through the Content Delivery API: counts, field counts, published nodes as fingerprints, whether unpublished work is reachable with the key, published nodes with no page, and whether the API answers visitors who have no key. [Endpoints and the key](/docs/integrations/umbraco)",
    },
    page: {
      slug: "integrations/umbraco",
      title: "Umbraco: content checks for sites built on Umbraco",
    },
  },
];
