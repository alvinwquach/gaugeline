import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Sitecore XM Cloud adapter.
 * TODO(new:adapter) say which key the platform offers and why it is the narrowest (read-only). Write the
 * same sentence at the top of docs/integrations/sitecore.md.
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
export const SITECORE_DESCRIPTION: AdapterDescription = {
  name: "Sitecore XM Cloud",
  docsUrl: "https://gaugeline.dev/docs/integrations/sitecore",
  keyKind: "read-only",
};

/** The variable the key comes from. The adapter imports it from here. */
export const SITECORE_TOKEN = "SITECORE_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "sitecore",
    name: "Sitecore XM Cloud",
    status: "built",
    describe: SITECORE_DESCRIPTION,
    envVars: [SITECORE_TOKEN],
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
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (TODO(new:adapter) the narrowest key, in one clause)",
      reads:
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/sitecore)",
    },
    page: {
      slug: "integrations/sitecore",
      title: "Sitecore XM Cloud: content checks for sites built on Sitecore XM Cloud",
    },
  },
];
