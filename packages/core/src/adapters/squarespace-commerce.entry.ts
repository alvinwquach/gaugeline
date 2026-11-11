import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Squarespace commerce adapter.
 * TODO(new:adapter) say which key the platform offers and why it is the narrowest (read-only). Write the
 * same sentence at the top of docs/integrations/squarespace-commerce.md.
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
export const SQUARESPACE_COMMERCE_DESCRIPTION: AdapterDescription = {
  name: "Squarespace commerce",
  docsUrl: "https://gaugeline.dev/docs/integrations/squarespace-commerce",
  keyKind: "read-only",
};

/** The variable the key comes from. The adapter imports it from here. */
export const SQUARESPACE_COMMERCE_TOKEN = "SQUARESPACE_COMMERCE_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "squarespace-commerce",
    name: "Squarespace commerce",
    status: "built",
    describe: SQUARESPACE_COMMERCE_DESCRIPTION,
    envVars: [SQUARESPACE_COMMERCE_TOKEN],
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("squarespace-commerce", async () => {
      const { createSquarespaceCommerceAdapter } = await import("./squarespace-commerce.js");
      return (c, settings) =>
        createSquarespaceCommerceAdapter({
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
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/squarespace-commerce)",
    },
    page: {
      slug: "integrations/squarespace-commerce",
      title: "Squarespace commerce: content checks for sites built on Squarespace commerce",
    },
  },
];
