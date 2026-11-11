import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Sanity asks for a token with the Viewer role (read only); a public dataset needs none. The page is
 * Gaugeline's own: it lists the endpoints used and how to make the token.
 */
export const SANITY_DESCRIPTION: AdapterDescription = {
  name: "Sanity",
  docsUrl: "https://gaugeline.dev/docs/private-datasets",
  keyKind: "read-only",
};

export const entries: readonly AdapterEntry[] = [
  {
    id: "sanity",
    name: "Sanity",
    status: "built",
    describe: SANITY_DESCRIPTION,
    load: lazy("sanity", async () => {
      const { createSanityAdapter } = await import("./sanity.js");
      return (c, settings) =>
        createSanityAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (a token with the Viewer role)",
      reads:
        "Type names and counts, how many items have each field, published items as fingerprints, whether drafts are reachable, who has access",
    },
  },
];
