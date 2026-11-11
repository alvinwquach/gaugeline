import { createSitemapFeedAdapter } from "./sitemap-feed.js";
import type { Fetcher } from "../fetcher.js";
import {
  AdapterCouldNotCheck,
  type AdapterDescription,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
} from "./types.js";

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

/**
 * Why Framer's CMS collections are not read, in one place so the answer, the docs page and the tests say
 * the same thing. The Server API (the `framer-api` package) is a library, not an HTTP API: it opens a
 * WebSocket to Framer and speaks the Plugin API over it, and its one kind of key (a project API key from
 * the project's settings) is not limited to reading: the same connection can add and remove collection
 * items, change pages and set custom code. Gaugeline sends GET and HEAD through its fetcher and nothing
 * else (CLAUDE.md rule 6), so it does not use it, and does not ask for the key.
 */
export const FRAMER_CMS_READ_PATH = Object.freeze({
  package: "framer-api",
  endpoint: "wss://api.framer.com/channel/headless-plugin",
  reason:
    "Not applicable to what Gaugeline can read from a Framer site. Framer's CMS collections can be read only through the Framer Server API, which is a library that talks to Framer over a WebSocket with a project API key that can also change the project. Gaugeline sends only GET and HEAD requests, through its fetcher, so it does not use it and does not ask for the key. What the live site publishes is read from its sitemap instead.",
});

export interface FramerAdapterOptions {
  fetcher: Fetcher;
  /** The site's address, from the run. The settings entry's `site` wins. */
  site?: string | undefined;
  /** The settings entry (`site`, `sitemaps`, `feeds`). `fingerprint` and `urls` mean nothing here. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * The Framer adapter (beta): what a Framer site publishes, read from the files the live site hands every
 * visitor (the sitemap, through the sitemap and feed adapter's reader), and could-not-check, with the
 * reason, for the CMS collections themselves. It never reads the environment: a project API key that
 * happens to be set (`FRAMER_API_KEY`, the Server API package's own variable) is not looked at, so it
 * cannot reach a request, a message or a report.
 *
 * Types are the first folder of an address, which for a Framer CMS page is usually its collection's
 * path (`/journal/kiln-firing` is `journal`); the adapter cannot tell a collection from a folder of
 * ordinary pages. There are no fields, so every `fieldHashes` is empty, and drafts (unpublished changes)
 * live in the project, not on the site.
 */
export function createFramerAdapter(options: FramerAdapterOptions): ContentAdapter {
  const settings = options.settings;
  const site = settings?.site ?? options.site;
  const pages = createSitemapFeedAdapter({
    fetcher: options.fetcher,
    site,
    settings,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  /** The run must name a web address before anything is asked, in this adapter's own words. */
  const requireSite = (): void => {
    let url: URL | undefined;
    try {
      url = site === undefined || site.trim() === "" ? undefined : new URL(site.trim());
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:"))
      throw new AdapterCouldNotCheck(
        'No site address to read the Framer site\'s sitemap from. Give the site on the command line, or set "site" on the framer entry in gaugeline.adapters.json.',
      );
  };

  async function* published(opts?: PublishedOptions): AsyncGenerator<PublishedDoc> {
    requireSite();
    yield* pages.published(opts);
  }

  return {
    id: "framer",
    describe: () => FRAMER_DESCRIPTION,
    types: async () => {
      requireSite();
      return pages.types();
    },
    fieldCounts: () => Promise.reject(new AdapterCouldNotCheck(FRAMER_CMS_READ_PATH.reason)),
    published,
    draftsReachable: () => Promise.resolve("not-applicable"),
    ...(pages.resolveUrl ? { resolveUrl: pages.resolveUrl } : {}),
  };
}
