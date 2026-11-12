import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Directus gives each user a static token, and what that token may read is whatever the user's role (its
 * policies) allows. Gaugeline asks for a token on a user whose role can only read the collections it is
 * given: no create, update or delete on any collection. Directus has no key type that is read-only by
 * itself, so the narrowing is the role's, and the docs page says how to make it. The page is Gaugeline's own.
 */
export const DIRECTUS_DESCRIPTION: AdapterDescription = {
  name: "Directus",
  docsUrl: "https://gaugeline.dev/docs/integrations/directus",
  keyKind: "read-only",
};

export const DIRECTUS_URL = "DIRECTUS_URL";
export const DIRECTUS_TOKEN = "DIRECTUS_TOKEN";

/** Every variable the Directus adapter may read. Only the token is a key. */
export const DIRECTUS_ENV_VARS = [DIRECTUS_URL, DIRECTUS_TOKEN] as const;

/** Items asked for in one request. */
export const DIRECTUS_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Directus checks quote them and a check may not import the adapter module.
 */
export const DIRECTUS_LIMITS = {
  /** Items read from one collection. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "directus",
    name: "Directus",
    status: "built",
    describe: DIRECTUS_DESCRIPTION,
    envVars: DIRECTUS_ENV_VARS,
    load: lazy("directus", async () => {
      const { createDirectusAdapter } = await import("./directus.js");
      return (c, settings) =>
        createDirectusAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    settings: { privateCollections: true },
    docs: {
      key: "read-only (a static token on a user whose role can only read the collections you name)",
      reads:
        "Collections you name, through the REST API: counts, field counts, published items as fingerprints, whether unpublished work is reachable, published items with no page, and (with consent) collections you mark private that the Public role can read. [Endpoints and the token](/docs/integrations/directus)",
    },
    page: {
      slug: "integrations/directus",
      title: "Directus: content checks for sites built on Directus",
    },
  },
];
