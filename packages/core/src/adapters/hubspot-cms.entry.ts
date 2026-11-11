import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The HubSpot CMS adapter.
 * TODO(new:adapter) say which key the platform offers and why it is the narrowest (scoped). Write the
 * same sentence at the top of docs/integrations/hubspot-cms.md.
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
export const HUBSPOT_CMS_DESCRIPTION: AdapterDescription = {
  name: "HubSpot CMS",
  docsUrl: "https://gaugeline.dev/docs/integrations/hubspot-cms",
  keyKind: "scoped",
};

/** The variable the key comes from. The adapter imports it from here. */
export const HUBSPOT_CMS_TOKEN = "HUBSPOT_CMS_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "hubspot-cms",
    name: "HubSpot CMS",
    status: "built",
    describe: HUBSPOT_CMS_DESCRIPTION,
    envVars: [HUBSPOT_CMS_TOKEN],
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("hubspot-cms", async () => {
      const { createHubspotCmsAdapter } = await import("./hubspot-cms.js");
      return (c, settings) =>
        createHubspotCmsAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "scoped (TODO(new:adapter) the narrowest key, in one clause)",
      reads:
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/hubspot-cms)",
    },
    page: {
      slug: "integrations/hubspot-cms",
      title: "HubSpot CMS: content checks for sites built on HubSpot CMS",
    },
  },
];
