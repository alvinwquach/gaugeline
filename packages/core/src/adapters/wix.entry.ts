import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The Wix adapter asks for no key: it reads what the live site publishes, the same files every visitor can
 * read. `keyKind` is "read-only" because nothing it does can change anything; `noKey` makes the run header say
 * there is no key at all. Wix does have a key that can be limited to read permissions (an API key with only
 * the Wix Data read permissions ticked), and docs/integrations/wix.md says how to make it; Gaugeline does not
 * ask for it yet, because the call that key is for is not one Gaugeline may send (see WIX_CMS_READ_PATH).
 */
export const WIX_DESCRIPTION: AdapterDescription = {
  name: "Wix",
  docsUrl: "https://gaugeline.dev/docs/integrations/wix",
  keyKind: "read-only",
  noKey: true,
};

export const entries: readonly AdapterEntry[] = [
  {
    id: "wix",
    name: "Wix",
    status: "built",
    describe: WIX_DESCRIPTION,
    detect: {
      generator: ["wix.com website builder"],
      hosts: ["parastorage.com", "wixstatic.com"],
      headers: { "x-wix-request-id": "" },
    },
    settings: { pageReader: true },
    load: lazy("wix", async () => {
      const { createWixAdapter } = await import("./wix.js");
      return (c, settings) =>
        createWixAdapter({
          fetcher: c.fetcher,
          site: c.site,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (no key at all: it reads the files the site already publishes; the CMS items need a POST query, which Gaugeline does not send yet)",
      reads:
        "Published items from the site's `sitemap.xml` and feeds, with their dates; the CMS collections' items and fields are could-not-check, with the reason (the read is planned as C-05b). [Wix](wix.md)",
    },
    page: { slug: "integrations/wix", title: "Wix: content checks for sites built on Wix" },
  },
];
