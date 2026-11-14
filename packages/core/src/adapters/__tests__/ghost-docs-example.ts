import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createSitemapFeedAdapter } from "../sitemap-feed.js";
import { AdapterCouldNotCheck } from "../types.js";
import { serve, sitemapIndex, urlset, xml, type Reply } from "./sitemap-feed-fixture.js";

/**
 * What docs/integrations/ghost.md shows for Lowtide Roasters (an invented coffee roaster whose journal
 * and members newsletter a freelancer runs on Ghost): the settings entry, and what the sitemap and feeds
 * adapter reads over the invented site. Ghost's Content API is not used: it wants its key in the
 * address (open question 53). Nothing here was recorded from a real site, and the file names a Ghost
 * site publishes are uncited. The docs test compares the page's blocks with these, so the page cannot
 * drift from the tool.
 */
export const LOWTIDE = "https://lowtide-roasters.example";

export const LOWTIDE_SETTINGS = { id: "sitemap-feed", site: LOWTIDE } as const;

/** Text from the site's pages and feed that must never reach the docs page or an adapter's answer. */
export const LOWTIDE_MARKERS = {
  title: "Lowtide Roasters, small-batch coffee from a harbour shed",
  free: "How we roast the Harbour Blend on a Tuesday",
  members: "Members only: the green coffee prices we would never print",
} as const;

const HOME = `<!doctype html><html><head><title>${LOWTIDE_MARKERS.title}</title>
<meta name="generator" content="Ghost 5.0">
<link rel="alternate" type="application/rss+xml" title="Lowtide Roasters" href="${LOWTIDE}/rss/">
</head><body><h1>${LOWTIDE_MARKERS.title}</h1></body></html>`;

const FEED =
  xml(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Lowtide Roasters</title><link>${LOWTIDE}/</link>
<item><title>${LOWTIDE_MARKERS.free}</title><link>${LOWTIDE}/harbour-blend-tuesday/</link><guid>g1</guid>
<pubDate>Tue, 03 Nov 2026 08:00:00 GMT</pubDate><category>Roasting</category></item>
<item><title>${LOWTIDE_MARKERS.members}</title><link>${LOWTIDE}/green-coffee-prices/</link><guid>g2</guid>
<pubDate>Thu, 05 Nov 2026 08:00:00 GMT</pubDate><category>Members</category>
<content:encoded><![CDATA[<p>${LOWTIDE_MARKERS.members}</p>]]></content:encoded></item>
<item><title>Autumn opening hours</title><link>${LOWTIDE}/autumn-opening-hours/</link><guid>g3</guid>
<pubDate>Fri, 06 Nov 2026 07:00:00 GMT</pubDate></item>
</channel></rss>`);

/** The healthy site's routes. A test changes one by spreading it into a new object. */
export function lowtideRoutes(): Record<string, Reply> {
  return {
    "/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nSitemap: ${LOWTIDE}/sitemap.xml\nDisallow: /ghost/\n`,
    },
    "/sitemap.xml": sitemapIndex([
      `${LOWTIDE}/sitemap-posts.xml`,
      `${LOWTIDE}/sitemap-pages.xml`,
      `${LOWTIDE}/sitemap-tags.xml`,
    ]),
    "/sitemap-posts.xml": urlset([
      { loc: `${LOWTIDE}/harbour-blend-tuesday/`, lastmod: "2026-11-04" },
      { loc: `${LOWTIDE}/green-coffee-prices/`, lastmod: "2026-11-05" },
      { loc: `${LOWTIDE}/autumn-opening-hours/`, lastmod: "2026-11-06" },
      { loc: `${LOWTIDE}/summer-cold-brew/`, lastmod: "2026-07-20" },
    ]),
    "/sitemap-pages.xml": urlset([
      { loc: `${LOWTIDE}/`, lastmod: "2026-11-06" },
      { loc: `${LOWTIDE}/about/`, lastmod: "2026-02-11" },
    ]),
    "/sitemap-tags.xml": urlset([
      { loc: `${LOWTIDE}/tag/roasting/`, lastmod: "2026-11-04" },
      { loc: `${LOWTIDE}/tag/members/`, lastmod: "2026-11-05" },
    ]),
    "/": { status: 200, headers: { "content-type": "text/html" }, body: HOME },
    "/rss/": FEED,
  };
}

export async function lowtideReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: serve(lowtideRoutes(), new URL(LOWTIDE).host),
    timeoutMs: 5000,
  });
  const adapter = createSitemapFeedAdapter({
    fetcher,
    settings: LOWTIDE_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fieldCounts = await adapter.fieldCounts("top-level", ["title"]).then(
    () => "answered",
    (e: unknown) => (e instanceof AdapterCouldNotCheck ? `could not check: ${e.reason}` : "failed"),
  );
  const { docs } = await collectPublished(adapter, { since: "2026-11-01" });
  return JSON.stringify(
    {
      types,
      "field counts": fieldCounts,
      "drafts reachable": await adapter.draftsReachable(),
      "changed since 1 November": docs,
    },
    null,
    2,
  );
}
