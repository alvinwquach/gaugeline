import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Contentful's delivery token can only read published content: the Content Delivery API has no
 * write endpoint at all, so the narrowest key is also the one Gaugeline needs. The page is
 * Gaugeline's own: it lists the endpoints used and how to make the token.
 */
export const CONTENTFUL_DESCRIPTION: AdapterDescription = {
  name: "Contentful",
  docsUrl: "https://gaugeline.dev/docs/integrations/contentful",
  keyKind: "read-only",
};

export const CONTENTFUL_SPACE_ID = "CONTENTFUL_SPACE_ID";
export const CONTENTFUL_ENVIRONMENT = "CONTENTFUL_ENVIRONMENT";
export const CONTENTFUL_DELIVERY_TOKEN = "CONTENTFUL_DELIVERY_TOKEN";
export const CONTENTFUL_PREVIEW_TOKEN = "CONTENTFUL_PREVIEW_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "contentful",
    name: "Contentful",
    status: "built",
    describe: CONTENTFUL_DESCRIPTION,
    detect: { hosts: ["ctfassets.net"] },
    envVars: [
      CONTENTFUL_SPACE_ID,
      CONTENTFUL_ENVIRONMENT,
      CONTENTFUL_DELIVERY_TOKEN,
      CONTENTFUL_PREVIEW_TOKEN,
    ],
    load: lazy("contentful", async () => {
      const { createContentfulAdapter } = await import("./contentful.js");
      return (c, settings) =>
        createContentfulAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (a Content Delivery API token; a Preview token only if you want the draft count)",
      reads:
        "Content types and their published entries as fingerprints, field counts, whether drafts exist (only with a preview token), and published entries whose page is gone. [Endpoints and the token](/docs/integrations/contentful)",
    },
    page: {
      slug: "integrations/contentful",
      title: "Contentful: content checks for sites built on Contentful",
    },
  },
];
