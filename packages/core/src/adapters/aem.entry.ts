import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Adobe Experience Manager adapter.
 * It reads the platform's public API, which needs no key. TODO(new:adapter) say which endpoints are public.
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
export const AEM_DESCRIPTION: AdapterDescription = {
  name: "Adobe Experience Manager",
  docsUrl: "https://gaugeline.dev/docs/integrations/aem",
  keyKind: "read-only",
  noKey: true,
};

export const entries: readonly AdapterEntry[] = [
  {
    id: "aem",
    name: "Adobe Experience Manager",
    status: "built",
    describe: AEM_DESCRIPTION,
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
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
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "read-only (no key at all: it reads the platform's public API)",
      reads:
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/aem)",
    },
    page: {
      slug: "integrations/aem",
      title: "Adobe Experience Manager: content checks for sites built on Adobe Experience Manager",
    },
  },
];
