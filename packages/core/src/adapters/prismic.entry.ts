import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * A Prismic repository's content API (the Document API, "REST API V2") is public for a public repository and
 * needs a read access token for a private one. Gaugeline asks for the narrowest key there is: none for a public
 * repository, and a read access token (it can only read what is published, plus the releases) for a private
 * one. The token is sent in an Authorization header and never in an address, which is the one thing Prismic's
 * own client does differently for this API, so a private repository that insists on the address form is
 * could-not-check (see the docs page). The page is Gaugeline's own.
 */
export const PRISMIC_DESCRIPTION: AdapterDescription = {
  name: "Prismic",
  docsUrl: "https://gaugeline.dev/docs/integrations/prismic",
  keyKind: "read-only",
  optionalKey: true,
};

/** The repository's name, such as larkspur-yoga: the address of its API is made from it. Not a key. */
export const PRISMIC_REPOSITORY = "PRISMIC_REPOSITORY";
/** A read access token. Optional: a public repository needs none. Sent as a header, never in an address. */
export const PRISMIC_ACCESS_TOKEN = "PRISMIC_ACCESS_TOKEN";

/** Every variable the Prismic adapter may read. Only the access token is a key. */
export const PRISMIC_ENV_VARS = [PRISMIC_REPOSITORY, PRISMIC_ACCESS_TOKEN] as const;

/** Documents asked for in one request: the API's own maximum. */
export const PRISMIC_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Prismic checks quote them and a check may not import the adapter module.
 */
export const PRISMIC_LIMITS = {
  /** Documents read from one type or one release. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Releases read by the release check. More are could-not-check by name. */
  releases: 10,
  /** Seconds between the reads that tell a stale master ref from a publication in flight (the client's own cache is 5). */
  settleSeconds: 6,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "prismic",
    name: "Prismic",
    status: "built",
    describe: PRISMIC_DESCRIPTION,
    envVars: PRISMIC_ENV_VARS,
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("prismic", async () => {
      const { createPrismicAdapter } = await import("./prismic.js");
      return (c, settings) =>
        createPrismicAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    settings: { checkReleases: true },
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "none for a public repository; read-only (a read access token) for a private one",
      reads:
        "Every document type of the repository, through the Document API: counts, field counts, published documents as fingerprints, published documents with no page, a master ref the public cache serves that is older than the origin's, and (with consent) documents in a release that are already live. [Endpoints and the token](/docs/integrations/prismic)",
    },
    page: {
      slug: "integrations/prismic",
      title: "Prismic: content checks for sites built on Prismic",
    },
  },
];
