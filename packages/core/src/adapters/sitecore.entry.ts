import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Sitecore XM Cloud publishes content to Experience Edge, and a site reads it through the Delivery GraphQL
 * API with a Delivery API token (sent as the `sc_apikey` header). That token is read-only by nature: the
 * Delivery API only answers queries, only for content that was published to Edge, and writing content is a
 * different API (Authoring and management) with a different kind of credential, so this token cannot change
 * anything. It is the narrowest key the platform offers. The page is Gaugeline's own.
 */
export const SITECORE_DESCRIPTION: AdapterDescription = {
  name: "Sitecore XM Cloud",
  docsUrl: "https://gaugeline.dev/docs/integrations/sitecore",
  keyKind: "read-only",
};

/** The variable the Delivery API token comes from (the name Sitecore's JavaScript SDK uses). The adapter imports it from here. */
export const SITECORE_API_KEY = "SITECORE_API_KEY";

/** Every variable the Sitecore adapter may read. Only the token is a key. The site name and languages are settings. */
export const SITECORE_ENV_VARS = [SITECORE_API_KEY] as const;

/** Routes asked for in one request. Experience Edge allows up to 1000; Gaugeline asks for fewer so an answer stays small. */
export const SITECORE_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to. There are no flags to raise them. They live here, in plain data, because the
 * Sitecore checks quote them and a check may not import the adapter module.
 */
export const SITECORE_LIMITS = {
  /** Routes read for one language. A bigger site is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Languages read in one run. */
  languages: 5,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "sitecore",
    name: "Sitecore XM Cloud",
    status: "built",
    describe: SITECORE_DESCRIPTION,
    envVars: SITECORE_ENV_VARS,
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("sitecore", async () => {
      const { createSitecoreAdapter } = await import("./sitecore.js");
      return (c, settings) =>
        createSitecoreAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    settings: { edgeSite: true, expectPrivate: true },
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (a Delivery API token for Experience Edge; it only answers queries for published content)",
      reads:
        "The site you name, through the Experience Edge Delivery GraphQL API (queries sent as POST, read-only): the published routes per language as counts and fingerprints, published routes with no page on the live site, and whether the preview endpoint answers on the public site. [Endpoints and the key](/docs/integrations/sitecore)",
    },
    page: {
      slug: "integrations/sitecore",
      title: "Sitecore XM Cloud: content checks for sites built on Sitecore XM Cloud",
    },
  },
];
