import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Craft CMS reads content through its GraphQL API, and a GraphQL schema decides what a key may do. A schema
 * token whose schema allows only queries on the sections you name is the narrowest key: it cannot save, delete
 * or change anything. Gaugeline sends GraphQL queries only, as GET requests, and refuses a token whose schema
 * shows a mutation type (a key that can write is for live-site checks only). The page is Gaugeline's own.
 */
export const CRAFT_DESCRIPTION: AdapterDescription = {
  name: "Craft CMS",
  docsUrl: "https://gaugeline.dev/docs/integrations/craft",
  keyKind: "read-only",
};

/** The variable the key comes from. The adapter imports it from here. */
export const CRAFT_TOKEN = "CRAFT_TOKEN";

/** The variable the GraphQL endpoint comes from (the route the site set up, such as https://cms.client.example/api). Not a key. */
export const CRAFT_URL = "CRAFT_URL";

/** Every variable the Craft adapter may read. Only the token is a key. */
export const CRAFT_ENV_VARS = [CRAFT_URL, CRAFT_TOKEN] as const;

/** Entries asked for in one request. */
export const CRAFT_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to. There are no flags to raise them. They live here, in plain data, because the Craft
 * check quotes them and a check may not import the adapter module.
 */
export const CRAFT_LIMITS = {
  /** Entries read from one section (every site counted). A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "craft",
    name: "Craft CMS",
    status: "built",
    describe: CRAFT_DESCRIPTION,
    envVars: CRAFT_ENV_VARS,
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("craft", async () => {
      const { createCraftAdapter } = await import("./craft.js");
      return (c, settings) =>
        createCraftAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (a GraphQL schema token that allows queries only, on the sections you name)",
      reads:
        "Sections you name, through the GraphQL API (queries over GET): counts, field counts, live entries as fingerprints, whether unpublished entries are reachable, and entries live on a site that have no page on it. [Endpoints and the key](/docs/integrations/craft)",
    },
    page: {
      slug: "integrations/craft",
      title: "Craft CMS: content checks for sites built on Craft CMS",
    },
  },
];
