import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Hygraph's Content API is GraphQL, and a permanent auth token is limited by the permissions you give it: the
 * narrowest one reads (and only reads) the PUBLISHED stage of the models you name. Gaugeline sends GraphQL queries
 * only, as POSTs through the read-only query allowlist (ADR-0006), always with `stage: PUBLISHED` unless the owner
 * turns on the one probing check (`readDraftStage`, with --owner-consent). The page is Gaugeline's own: it lists the
 * endpoints used and how to make the token.
 */
export const HYGRAPH_DESCRIPTION: AdapterDescription = {
  name: "Hygraph",
  docsUrl: "https://gaugeline.dev/docs/integrations/hygraph",
  keyKind: "read-only",
};

/** A permanent auth token with read permission on the PUBLISHED stage only (header `Authorization: Bearer`). */
export const HYGRAPH_TOKEN = "HYGRAPH_TOKEN";

/**
 * The project's Content API endpoint, from Settings, API access in Hygraph, such as
 * https://api-eu-central-1.hygraph.com/v2/<project id>/master. It names the project and the environment and is not
 * a key. Only a hygraph.com host with the Content API's path is accepted.
 */
export const HYGRAPH_ENDPOINT = "HYGRAPH_ENDPOINT";

/** Every variable the Hygraph adapter may read. Only the token is a key. */
export const HYGRAPH_ENV_VARS = [HYGRAPH_ENDPOINT, HYGRAPH_TOKEN] as const;

/** Entries asked for in one request (Hygraph's `first`). Hygraph's own cap is higher (uncited), so 100 keeps an answer small. */
export const HYGRAPH_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to. There are no flags to raise them. They live here, in plain data, because the Hygraph
 * check quotes them and a check may not import the adapter module.
 */
export const HYGRAPH_LIMITS = {
  /** Entries read from one model and one stage (`skip` stepping). A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 5_000,
  /** Unpublished entries whose live page is asked for in one run. More are could-not-check, never skipped quietly. */
  pages: 40,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "hygraph",
    name: "Hygraph",
    status: "built",
    describe: HYGRAPH_DESCRIPTION,
    envVars: HYGRAPH_ENV_VARS,
    settings: { graphqlCollections: true, draftStageRead: true },
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("hygraph", async () => {
      const { createHygraphAdapter } = await import("./hygraph.js");
      return (c, settings) =>
        createHygraphAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (a permanent auth token with read permission on the PUBLISHED stage of the models you name)",
      reads:
        "The PUBLISHED stage of the models you name, through the Content API (GraphQL queries): counts, field counts and published entries as fingerprints. With --owner-consent and a settings entry, entries that are not published and still have a live page. [Endpoints and the token](/docs/integrations/hygraph)",
    },
    page: {
      slug: "integrations/hygraph",
      title: "Hygraph: content checks for sites built on Hygraph",
    },
  },
];
