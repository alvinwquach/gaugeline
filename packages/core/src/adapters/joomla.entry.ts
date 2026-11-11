import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Joomla adapter.
 * TODO(new:adapter) say which key the platform offers and why it is the narrowest (scoped). Write the
 * same sentence at the top of docs/integrations/joomla.md.
 *
 * If the platform's own API is in beta, add `beta: true` (as framer.entry.ts does): the run header then says
 * "(beta)" and the docs page says what may change.
 */
export const JOOMLA_DESCRIPTION: AdapterDescription = {
  name: "Joomla",
  docsUrl: "https://gaugeline.dev/docs/integrations/joomla",
  keyKind: "scoped",
};

/** The variable the key comes from. The adapter imports it from here. */
export const JOOMLA_TOKEN = "JOOMLA_TOKEN";

export const entries: readonly AdapterEntry[] = [
  {
    id: "joomla",
    name: "Joomla",
    status: "built",
    describe: JOOMLA_DESCRIPTION,
    envVars: [JOOMLA_TOKEN],
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
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "scoped (TODO(new:adapter) the narrowest key, in one clause)",
      reads:
        "TODO(new:adapter) what it reads, in one sentence. [Endpoints and the key](/docs/integrations/joomla)",
    },
    page: {
      slug: "integrations/joomla",
      title: "Joomla: content checks for sites built on Joomla",
    },
  },
];
