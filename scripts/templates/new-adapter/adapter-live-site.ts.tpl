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
 * The $NAME$ adapter reads the live site only. It asks for no key: it reads what the site publishes, the
 * same files every visitor can read. `keyKind` is "read-only" because nothing it does can change anything;
 * `noKey` makes the run header say there is no key at all.
 *
 * Why it reads the live site only (rule 6 of CLAUDE.md, and the release plan in PROGRESS.md):
#if full-access
 * TODO(new:adapter) $NAME$'s key can also write (say what it can change, and where you read that), so
 * Gaugeline does not ask for it, read it or use it.
#else
 * TODO(new:adapter) $NAME$ has no read API (say what you looked for, and where), so there is nothing to ask.
#end
 */
export const $P$_DESCRIPTION: AdapterDescription = {
  name: "$NAME$",
  docsUrl: "https://gaugeline.dev/docs/integrations/$ID$",
  keyKind: "read-only",
  noKey: true,
};

/**
 * Why $NAME$'s content is not read beyond the live site, in one place so the answer, the docs page and the
 * tests say the same thing. TODO(new:adapter) replace the sentence with the real reason, in plain words.
 */
export const $P$_CONTENT_READ_PATH = Object.freeze({
  reason:
    "Not applicable to what Gaugeline can read from a $NAME$ site. TODO(new:adapter) say why $NAME$'s content cannot be read with a GET, then: What the live site publishes is read from its sitemap instead.",
});

export interface $PASCAL$AdapterOptions {
  fetcher: Fetcher;
  /** The site's address, from the run. The settings entry's `site` wins. */
  site?: string | undefined;
  /** The settings entry (`site`, `sitemaps`, `feeds`). `fingerprint` and `urls` mean nothing here. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * What a $NAME$ site publishes, read from the files the live site hands every visitor (the sitemap, through
 * the sitemap and feed adapter's reader), and could-not-check, with the reason, for the content behind
 * the platform. It never reads the environment: a key that happens to be set is not looked at, so it
 * cannot reach a request, a message or a report.
 *
 * Types are the first folder of an address. There are no fields, so every `fieldHashes` is empty, and
 * drafts live in the platform, not on the site.
 */
export function create$PASCAL$Adapter(options: $PASCAL$AdapterOptions): ContentAdapter {
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
        'No site address to read the $NAME$ site\'s sitemap from. Give the site on the command line, or set "site" on the $ID$ entry in gaugeline.adapters.json.',
      );
  };

  async function* published(opts?: PublishedOptions): AsyncGenerator<PublishedDoc> {
    requireSite();
    yield* pages.published(opts);
  }

  return {
    id: "$ID$",
    describe: () => $P$_DESCRIPTION,
    types: async () => {
      requireSite();
      return pages.types();
    },
    fieldCounts: () => Promise.reject(new AdapterCouldNotCheck($P$_CONTENT_READ_PATH.reason)),
    published,
    draftsReachable: () => Promise.resolve("not-applicable"),
    ...(pages.resolveUrl ? { resolveUrl: pages.resolveUrl } : {}),
  };
}
