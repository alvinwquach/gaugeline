import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Strapi lets an administrator make an API token of type "Read-only": it can find and read the
 * content types it is given and cannot create, update or delete anything. Gaugeline asks for that
 * type and nothing wider. The page is Gaugeline's own: it lists the endpoints used and how to make
 * the token.
 */
export const STRAPI_DESCRIPTION: AdapterDescription = {
  name: "Strapi",
  docsUrl: "https://gaugeline.dev/docs/integrations/strapi",
  keyKind: "read-only",
};

export const STRAPI_URL = "STRAPI_URL";
export const STRAPI_TOKEN = "STRAPI_TOKEN";

/** Every variable the Strapi adapter may read. Only the token is a key. */
export const STRAPI_ENV_VARS = [STRAPI_URL, STRAPI_TOKEN] as const;

/** Entries asked for in one request: Strapi's default maximum page size. */
export const STRAPI_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Strapi checks quote them and a check may not import the adapter module.
 */
export const STRAPI_LIMITS = {
  /** Entries read from one collection. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Ids read from each list when looking for unpublished entries a visitor can reach. Past it the count stands and the ids are left out. */
  publicIds: 500,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "strapi",
    name: "Strapi",
    status: "built",
    describe: STRAPI_DESCRIPTION,
    envVars: STRAPI_ENV_VARS,
    load: lazy("strapi", async () => {
      const { createStrapiAdapter } = await import("./strapi.js");
      return (c, settings) =>
        createStrapiAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (an API token of type Read-only)",
      reads:
        "Collections you name, through the REST API: counts, field counts, published entries as fingerprints, whether unpublished work is reachable, and published entries with no page. [Endpoints and the token](/docs/integrations/strapi)",
    },
    page: {
      slug: "integrations/strapi",
      title: "Strapi: content checks for sites built on Strapi",
    },
  },
];
