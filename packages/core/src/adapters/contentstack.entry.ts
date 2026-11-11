import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Contentstack adapter.
 * TODO(new:adapter) say which key the platform offers and why it is the narrowest (read-only). Write the
 * same sentence at the top of docs/integrations/contentstack.md.
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
export const CONTENTSTACK_DESCRIPTION: AdapterDescription = {
  name: "Contentstack",
  docsUrl: "https://gaugeline.dev/docs/integrations/contentstack",
  keyKind: "read-only",
};

/** The variable the key comes from. The adapter imports it from here. */
export const CONTENTSTACK_TOKEN = "CONTENTSTACK_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "contentstack",
    name: "Contentstack",
    status: "built",
    describe: CONTENTSTACK_DESCRIPTION,
    envVars: [CONTENTSTACK_TOKEN],
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("contentstack", async () => {
      const { createContentstackAdapter } = await import("./contentstack.js");
      return (c, settings) =>
        createContentstackAdapter({
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
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/contentstack)",
    },
    page: {
      slug: "integrations/contentstack",
      title: "Contentstack: content checks for sites built on Contentstack",
    },
  },
];
