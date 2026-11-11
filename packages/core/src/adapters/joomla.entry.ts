import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Joomla (4 and 5) answers a REST API, the Web Services API, in JSON:API format. Its key is an API token that
 * belongs to one user and carries that user's rights: Joomla has no token that can only read. So the narrowest key
 * is a token for a dedicated user whose group may sign in to the API and has no create, edit or delete right, which
 * is `scoped`, not `read-only`. The page is Gaugeline's own: it lists the endpoints used and how to make the user.
 */
export const JOOMLA_DESCRIPTION: AdapterDescription = {
  name: "Joomla",
  docsUrl: "https://gaugeline.dev/docs/integrations/joomla",
  keyKind: "scoped",
};

/** The Joomla site's own address, https only (a folder is allowed: Joomla is often installed in one). Not a key. */
export const JOOMLA_URL = "JOOMLA_URL";
/** The API token, sent in the `X-Joomla-Token` header to JOOMLA_URL's origin only. */
export const JOOMLA_TOKEN = "JOOMLA_TOKEN";

/** Every variable the Joomla adapter may read. Only the token is a key. */
export const JOOMLA_ENV_VARS = [JOOMLA_URL, JOOMLA_TOKEN] as const;

/** Articles asked for in one request. Joomla's default is 20: Gaugeline asks for more and steps by what comes back. */
export const JOOMLA_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Joomla checks quote them and a check may not import the adapter module.
 */
export const JOOMLA_LIMITS = {
  /** Articles read in one list. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Requests spent on one list. A server that hands out a few articles at a time ends here, as could-not-check. */
  requestsPerList: 500,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "joomla",
    name: "Joomla",
    status: "built",
    describe: JOOMLA_DESCRIPTION,
    envVars: JOOMLA_ENV_VARS,
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("joomla", async () => {
      const { createJoomlaAdapter } = await import("./joomla.js");
      return (c, settings) =>
        createJoomlaAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    settings: { expectPrivate: true },
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "scoped (an API token for a dedicated user whose group can only view; Joomla has no read-only token)",
      reads:
        "Articles, through the Web Services API: the published count, field counts, published articles as fingerprints, whether the key reaches unpublished articles, published articles with no page, and whether the API answers visitors who have no token. [Endpoints and the key](/docs/integrations/joomla)",
    },
    page: {
      slug: "integrations/joomla",
      title: "Joomla: content checks for sites built on Joomla",
    },
  },
];
