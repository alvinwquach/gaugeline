import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Craft CMS adapter.
 * TODO(new:adapter) say which key the platform offers and why it is the narrowest (read-only). Write the
 * same sentence at the top of docs/integrations/craft.md.
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
export const CRAFT_DESCRIPTION: AdapterDescription = {
  name: "Craft CMS",
  docsUrl: "https://gaugeline.dev/docs/integrations/craft",
  keyKind: "read-only",
};

/** The variable the key comes from. The adapter imports it from here. */
export const CRAFT_TOKEN = "CRAFT_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "craft",
    name: "Craft CMS",
    status: "built",
    describe: CRAFT_DESCRIPTION,
    envVars: [CRAFT_TOKEN],
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("craft", async () => {
      const { createCraftAdapter } = await import("./craft.js");
      return (c, settings) =>
        createCraftAdapter({
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
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/craft)",
    },
    page: {
      slug: "integrations/craft",
      title: "Craft CMS: content checks for sites built on Craft CMS",
    },
  },
];
