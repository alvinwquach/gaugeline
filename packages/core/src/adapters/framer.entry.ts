import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Framer adapter is beta because Framer's own API is. It asks for no key: it reads what the live
 * site publishes, the same files every visitor can read. `keyKind` is "read-only" because nothing it
 * does can change anything; `noKey` makes the run header say there is no key at all.
 */
export const FRAMER_DESCRIPTION: AdapterDescription = {
  name: "Framer",
  docsUrl: "https://gaugeline.dev/docs/integrations/framer",
  keyKind: "read-only",
  noKey: true,
  beta: true,
};

export const entries: readonly AdapterEntry[] = [
  {
    id: "framer",
    name: "Framer",
    status: "built",
    describe: FRAMER_DESCRIPTION,
    settings: { pageReader: true },
    load: lazy("framer", async () => {
      const { createFramerAdapter } = await import("./framer.js");
      return (c, settings) =>
        createFramerAdapter({
          fetcher: c.fetcher,
          site: c.site,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (no key at all: Framer has no read-only key and its project API key can change the project, so Gaugeline does not use it)",
      reads:
        "Published pages from the live site's `sitemap.xml`, with their dates. Beta. The CMS collections themselves are could-not-check, with the reason. [What it reads and why](/docs/integrations/framer)",
    },
    page: {
      slug: "integrations/framer",
      title: "Framer: content checks for sites built on Framer (beta)",
    },
  },
];
