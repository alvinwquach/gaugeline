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

/**
 * Why Wix's CMS items are not read, in one place so the answer, the docs page and the tests say the same
 * thing. Wix Data lists items with Query Data Items, which is a POST (the filter travels in the body), and
 * counts them with Count Data Items, also a POST. The only read by GET is one item by its id, and nothing
 * Gaugeline may call lists the ids. Gaugeline sends GET and HEAD through its fetcher and nothing else
 * (CLAUDE.md rule 6; the one exception, ADR-0005, is notifications to the user's own channels), so it does
 * not send the query, and it does not ask for the key. Allowing a read-only POST query needs an ADR: open
 * question 52 for the owner. The endpoint shapes are from the build session's memory of Wix's reference,
 * which could not be reached, and are marked uncited on the docs page.
 */
export const WIX_CMS_READ_PATH = Object.freeze({
  method: "POST",
  host: "www.wixapis.com",
  path: "/wix-data/v2/items/query",
  reason:
    "Not applicable to what Gaugeline can read from a Wix site. Wix lists the items of a CMS collection only with Query Data Items, which is a POST request, and counts them with Count Data Items, also a POST. Gaugeline sends only GET and HEAD requests, through its fetcher, so it does not send them and does not ask for a Wix API key. What the live site publishes is read from its sitemap instead.",
});

export interface WixAdapterOptions {
  fetcher: Fetcher;
  /** The site's address, from the run. The settings entry's `site` wins. */
  site?: string | undefined;
  /** The settings entry (`site`, `sitemaps`, `feeds`). `fingerprint` and `urls` mean nothing here. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * The Wix adapter: what a Wix site publishes, read from the files the live site hands every visitor (the
 * sitemap, through the sitemap and feed adapter's reader), and could-not-check, with the reason, for the CMS
 * collections themselves. It never reads the environment: a Wix API key that happens to be set cannot reach
 * a request, a message or a report, because nothing here looks one up.
 *
 * Types are the first folder of an address, which for a Wix dynamic page is usually its collection's path
 * (`/programs/spring-cohort` is `programs`); the adapter cannot tell a collection from a folder of ordinary
 * pages. There are no fields, so every `fieldHashes` is empty, and draft items live in the CMS, not on the site.
 */
export function createWixAdapter(options: WixAdapterOptions): ContentAdapter {
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
        'No site address to read the Wix site\'s sitemap from. Give the site on the command line, or set "site" on the wix entry in gaugeline.adapters.json.',
      );
  };

  async function* published(opts?: PublishedOptions): AsyncGenerator<PublishedDoc> {
    requireSite();
    yield* pages.published(opts);
  }

  return {
    id: "wix",
    describe: () => WIX_DESCRIPTION,
    types: async () => {
      requireSite();
      return pages.types();
    },
    fieldCounts: () => Promise.reject(new AdapterCouldNotCheck(WIX_CMS_READ_PATH.reason)),
    published,
    draftsReachable: () => Promise.resolve("not-applicable"),
    ...(pages.resolveUrl ? { resolveUrl: pages.resolveUrl } : {}),
  };
}
