import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

export const WIX_API_KEY = "WIX_API_KEY";

/** Every variable the Wix adapter may read. Only the key is a secret; the site's id is a setting (`siteId`). */
export const WIX_ENV_VARS = [WIX_API_KEY] as const;

/** Items asked for in one request. Wix's documented maximum for one query is 1000 (uncited); 100 keeps an answer small. */
export const WIX_PAGE_SIZE = 100;

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because a check may not import the adapter module.
 */
export const WIX_LIMITS = {
  /** Items read from one collection. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
} as const;

/**
 * The Wix adapter reads with no key at all (the files the live site publishes: its sitemap and feeds) and, when
 * `WIX_API_KEY` is set, reads the CMS collections the settings name through Wix's Query Data Items endpoint. That
 * endpoint answers a read with a POST, which ADR-0006 allows for one documented read-only query, through the
 * allowlist `WIX_QUERY_ALLOW` (wix.ts). The key to make is a Wix API key with only the read permission for Wix
 * Data, so `keyKind` is "read-only"; docs/integrations/wix.md says how. `optionalKey` makes the run header say
 * both: with that key when one is set, with no key otherwise.
 */
export const WIX_DESCRIPTION: AdapterDescription = {
  name: "Wix",
  docsUrl: "https://gaugeline.dev/docs/integrations/wix",
  keyKind: "read-only",
  optionalKey: true,
};

export const entries: readonly AdapterEntry[] = [
  {
    id: "wix",
    name: "Wix",
    status: "built",
    describe: WIX_DESCRIPTION,
    envVars: WIX_ENV_VARS,
    detect: {
      generator: ["wix.com website builder"],
      hosts: ["parastorage.com", "wixstatic.com"],
      headers: { "x-wix-request-id": "" },
    },
    settings: { pageReader: true, fields: true },
    load: lazy("wix", async () => {
      const { createWixAdapter } = await import("./wix.js");
      return (c, settings) =>
        createWixAdapter({
          env: c.env,
          fetcher: c.fetcher,
          site: c.site,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "none to read the live site; read-only (a Wix API key with only the Wix Data read permission) to read the CMS collections",
      reads:
        "With no key: published items from the site's `sitemap.xml` and feeds, with their dates. With the key: the collections you name, through Wix's Query Data Items endpoint (the one POST Gaugeline sends, ADR-0006): counts, field counts and published items as fingerprints. [Wix](wix.md)",
    },
    page: { slug: "integrations/wix", title: "Wix: content checks for sites built on Wix" },
  },
];
