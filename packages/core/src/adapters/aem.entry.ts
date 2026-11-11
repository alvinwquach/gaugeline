import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Adobe Experience Manager (AEM). The adapter reads the PUBLISH tier, which serves what is published to every
 * visitor, so it takes no key: persisted GraphQL queries over GET (`/graphql/execute.json/<config>/<query>`)
 * that the site's developers already published for the Content Fragments. It never touches the author tier,
 * never creates a persisted query (that is a write) and never sends a POST.
 */
export const AEM_DESCRIPTION: AdapterDescription = {
  name: "Adobe Experience Manager",
  docsUrl: "https://gaugeline.dev/docs/integrations/aem",
  keyKind: "read-only",
  noKey: true,
  fingerprintsFields: true,
};

/** The publish tier's own address (https, an origin and nothing else). Not a secret. */
export const AEM_PUBLISH_URL = "AEM_PUBLISH_URL";
/** The name of the configuration the persisted queries were published under (the first part after /graphql/execute.json/). Not a secret. */
export const AEM_CONFIG = "AEM_CONFIG";

/** Every variable the AEM adapter may read. None is a key. */
export const AEM_ENV_VARS = [AEM_PUBLISH_URL, AEM_CONFIG] as const;

/** Items asked for in one request of a paginated query (`first`). */
export const AEM_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to. There are no flags to raise them. In plain data because a check may quote them and
 * may not import the adapter module.
 */
export const AEM_LIMITS = {
  /** Fragments read from one persisted query. A bigger list is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Requests for one persisted query. A server that never ends its pages is given up on here. */
  pagesPerType: 200,
  /**
   * A list that has no `pageInfo` and answers this many fragments or more may have been cut short by the
   * platform's own default limit, so it is could-not-check, never "complete".
   */
  unpagedList: 50,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "aem",
    name: "Adobe Experience Manager",
    status: "built",
    describe: AEM_DESCRIPTION,
    envVars: AEM_ENV_VARS,
    detect: { paths: ["/etc.clientlibs/", "/content/dam/"] },
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    load: lazy("aem", async () => {
      const { createAemAdapter } = await import("./aem.js");
      return (c, settings) =>
        createAemAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "none (the public publish tier)",
      reads:
        "Content Fragments through the persisted GraphQL queries you name, over GET: counts, field counts and published fragments as fingerprints, fragments missing from the live site, and author-tier links on the live pages. [Endpoints and the key](/docs/integrations/aem)",
    },
    page: {
      slug: "integrations/aem",
      title: "Adobe Experience Manager: content checks for sites built on AEM",
    },
  },
];
