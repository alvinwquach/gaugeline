import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Webflow asks for a site token whose scopes are `sites:read` and `cms:read` and nothing else, so the
 * token can read and cannot change anything. The page is Gaugeline's own: it lists the endpoints used
 * and how to make the token.
 */
export const WEBFLOW_DESCRIPTION: AdapterDescription = {
  name: "Webflow",
  docsUrl: "https://gaugeline.dev/docs/integrations/webflow",
  keyKind: "read-only",
};

export const WEBFLOW_TOKEN = "WEBFLOW_TOKEN";
export const WEBFLOW_SITE_ID = "WEBFLOW_SITE_ID";

export const entries: readonly AdapterEntry[] = [
  {
    id: "webflow",
    name: "Webflow",
    status: "built",
    describe: WEBFLOW_DESCRIPTION,
    envVars: [WEBFLOW_TOKEN, WEBFLOW_SITE_ID],
    settings: { hyphenFields: true },
    load: lazy("webflow", async () => {
      const { createWebflowAdapter } = await import("./webflow.js");
      return (c, settings) =>
        createWebflowAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (a site token with only the `sites:read` and `cms:read` scopes)",
      reads:
        "Collections and their published items as fingerprints, field counts, whether staged or draft items exist, and items staged but not published. [Endpoints and the token](/docs/integrations/webflow)",
    },
    page: {
      slug: "integrations/webflow",
      title: "Webflow: content checks for sites built on Webflow",
    },
  },
];
