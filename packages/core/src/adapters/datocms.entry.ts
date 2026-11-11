import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * DatoCMS's Content Delivery API is read-only by design (it has no write endpoint), and an API token is limited by
 * two things: a role, and flags for which APIs it may call. The narrowest token is one with the Content Delivery API
 * on, the draft (preview) flag off and the Content Management API off. The page is Gaugeline's own: it lists the
 * endpoints used and how to make the token.
 */
export const DATOCMS_DESCRIPTION: AdapterDescription = {
  name: "DatoCMS",
  docsUrl: "https://gaugeline.dev/docs/integrations/datocms",
  keyKind: "read-only",
};

/** A DatoCMS API token that may call the Content Delivery API for published content only (header `Authorization: Bearer`). */
export const DATOCMS_TOKEN = "DATOCMS_TOKEN";
/** The sandbox environment to read, such as "staging" (header `X-Environment`). Optional: without it the primary environment is read. */
export const DATOCMS_ENVIRONMENT = "DATOCMS_ENVIRONMENT";

export const entries: readonly AdapterEntry[] = [
  {
    id: "datocms",
    name: "DatoCMS",
    status: "built",
    describe: DATOCMS_DESCRIPTION,
    envVars: [DATOCMS_TOKEN, DATOCMS_ENVIRONMENT],
    settings: { graphqlCollections: true },
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("datocms", async () => {
      const { createDatocmsAdapter } = await import("./datocms.js");
      return (c, settings) =>
        createDatocmsAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (an API token with the Content Delivery API on, drafts off and the Content Management API off)",
      reads:
        "The published records of the collections you name, as fingerprints and field counts, and whether the token can also read drafts. [Endpoints and the token](/docs/integrations/datocms)",
    },
    page: {
      slug: "integrations/datocms",
      title: "DatoCMS: content checks for sites built on DatoCMS",
    },
  },
];
