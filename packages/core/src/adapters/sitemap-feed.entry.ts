import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The sitemap and feed adapter asks for no key: it reads the files a site already hands every visitor.
 * `keyKind` is "read-only" because nothing it does can change anything; `noKey` makes the run header
 * say there is no key at all.
 */
export const SITEMAP_FEED_DESCRIPTION: AdapterDescription = {
  name: "Sitemap and feeds",
  docsUrl: "https://gaugeline.dev/docs/integrations/sitemap-feed",
  keyKind: "read-only",
  noKey: true,
};

export const entries: readonly AdapterEntry[] = [
  {
    id: "sitemap-feed",
    name: "Sitemap and feeds",
    status: "built",
    describe: SITEMAP_FEED_DESCRIPTION,
    settings: { pageReader: true },
    load: lazy("sitemap-feed", async () => {
      const { createSitemapFeedAdapter } = await import("./sitemap-feed.js");
      return (c, settings) =>
        createSitemapFeedAdapter({
          fetcher: c.fetcher,
          site: c.site,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "read-only (no key at all: it reads the files the site already publishes)",
      reads:
        "Published items from `sitemap.xml` (and indexes, gzip), RSS, Atom and JSON Feed, with their dates. [Which checks need a native adapter instead](/docs/integrations/sitemap-feed#what-needs-a-native-adapter-instead)",
    },
    page: {
      slug: "integrations/sitemap-feed",
      title: "Sitemap and feeds: content checks for sites built on any CMS",
    },
  },
];
