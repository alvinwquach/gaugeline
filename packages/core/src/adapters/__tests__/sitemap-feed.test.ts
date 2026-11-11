import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetcher } from "../../fetcher.js";
import {
  parseFeed,
  parseFeedLinks,
  parseSitemap,
  parseSitemapEntries,
} from "../../site-context.js";
import { collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { adaptersOrDefault, createAdapters, resolveAdapters } from "../registry.js";
import { SITEMAP_FEED_LIMITS, TOP_LEVEL, createSitemapFeedAdapter } from "../sitemap-feed.js";
import { AdapterCouldNotCheck } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  OAKLINE,
  OAKLINE_MARKERS,
  oaklineRoutes,
  serve,
  sitemapIndex,
  urlset,
  xml,
  type Reply,
} from "./sitemap-feed-fixture.js";

afterEach(() => vi.restoreAllMocks());

const HOST = new URL(OAKLINE).host;

function build(
  routes: Record<string, Reply>,
  options: {
    site?: string;
    settings?: Parameters<typeof createSitemapFeedAdapter>[0]["settings"];
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(serve(routes, HOST), seen),
    timeoutMs: 5000,
  });
  const adapter = createSitemapFeedAdapter({
    fetcher,
    site: options.site ?? OAKLINE,
    settings: options.settings,
    sleep: () => Promise.resolve(),
  });
  return { adapter, seen };
}

const asked = (seen: readonly Seen[]): string[] =>
  seen.map((s) => {
    const u = new URL(s.url);
    return `${u.host}${u.pathname}${u.search}`;
  });

const docsOf = async (
  adapter: ReturnType<typeof build>["adapter"],
  options?: Parameters<typeof collectPublished>[1],
) => (await collectPublished(adapter, options)).docs;

const couldNot = async (promise: Promise<unknown>): Promise<string> => {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const html = (body: string): Reply => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body,
});
const text = (body: string): Reply => ({
  status: 200,
  headers: { "content-type": "text/plain" },
  body,
});

describe("sitemap and feed: an index with three children", () => {
  it("reads robots.txt, the index and its three children, in order, and returns every address once", async () => {
    const { adapter, seen } = build(oaklineRoutes());
    const docs = await docsOf(adapter);
    expect(docs.map((d) => d.id)).toEqual([
      `${OAKLINE}/`,
      `${OAKLINE}/about`,
      `${OAKLINE}/menu`,
      `${OAKLINE}/blog/spring-loaf`,
      `${OAKLINE}/blog/winter-hours`,
      `${OAKLINE}/blog/pop-up-saturday`,
      `${OAKLINE}/shop/sourdough-box`,
      `${OAKLINE}/shop/gift-card`,
      `${OAKLINE}/rye-recipe`,
    ]);
    expect(asked(seen).slice(0, 5)).toEqual([
      `${HOST}/robots.txt`,
      `${HOST}/sitemap_index.xml`,
      `${HOST}/sitemap-pages.xml`,
      `${HOST}/sitemap-blog.xml.gz`,
      `${HOST}/sitemap-shop.xml`,
    ]);
    expect(requestProblems(seen)).toEqual([]);
  });

  it("never asks a host other than the site, whatever robots.txt and the index name", async () => {
    const { adapter, seen } = build(oaklineRoutes());
    await adapter.types();
    await docsOf(adapter);
    for (const line of asked(seen)) expect(line.startsWith(`${HOST}/`)).toBe(true);
  });

  it("types() groups by folder, then by feed category, then top-level, and sorts by name", async () => {
    expect(await build(oaklineRoutes()).adapter.types()).toEqual([
      { name: "blog", count: 3 },
      { name: "recipes", count: 1 },
      { name: "shop", count: 2 },
      { name: TOP_LEVEL, count: 3 },
    ]);
  });

  it("a feed item and a sitemap entry for the same page are one item, whatever the slash, scheme or www", async () => {
    const routes = oaklineRoutes();
    routes["/blog?format=rss"] = xml(
      `<rss><channel><item><link>http://www.oakline-bakery.example/blog/spring-loaf/</link><pubDate>Mon, 02 Mar 2026 08:00:00 GMT</pubDate></item></channel></rss>`,
    );
    const docs = await docsOf(build(routes).adapter, { types: ["blog"] });
    expect(docs.map((d) => d.slug)).toEqual(["spring-loaf", "winter-hours", "pop-up-saturday"]);
    expect(docs[0]?.publishedAt).toBe("2026-03-02T08:00:00.000Z");
  });
});

describe("sitemap and feed: gzip sitemaps", () => {
  it("a sitemap.xml.gz is unpacked and read", async () => {
    const routes = {
      "/robots.txt": text(`Sitemap: ${OAKLINE}/sitemap.xml.gz\n`),
      "/sitemap.xml.gz": {
        status: 200,
        headers: { "content-type": "application/gzip" },
        body: gzipSync(urlset([{ loc: `${OAKLINE}/menu`, lastmod: "2026-11-01" }])),
      },
    };
    const docs = await docsOf(build(routes).adapter);
    expect(docs).toEqual([
      {
        id: `${OAKLINE}/menu`,
        type: TOP_LEVEL,
        url: `${OAKLINE}/menu`,
        slug: "menu",
        updatedAt: "2026-11-01T00:00:00.000Z",
        fieldHashes: {},
      },
    ]);
  });

  it("a decompression bomb is refused: could-not-check, never a partial list that looks whole", async () => {
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(200 * 1024);
    const routes = {
      "/robots.txt": text(`Sitemap: ${OAKLINE}/sitemap.xml.gz\n`),
      "/sitemap.xml.gz": {
        status: 200,
        headers: { "content-type": "application/gzip" },
        body: bomb,
      },
    };
    const { adapter } = build(routes);
    const reason = await couldNot(adapter.types());
    expect(reason).toContain("sitemap.xml.gz");
    expect(reason).toMatch(/larger than 5 MB once unpacked/);
    await couldNot(collectPublished(adapter));
  });

  it("a plain sitemap over the size cap is refused too", async () => {
    const big = urlset([{ loc: `${OAKLINE}/a` }]).replace(
      "</urlset>",
      `<!--${"x".repeat(SITEMAP_FEED_LIMITS.fileBytes)}--></urlset>`,
    );
    const reason = await couldNot(
      build({
        "/robots.txt": text(`Sitemap: ${OAKLINE}/big.xml\n`),
        "/big.xml": big,
      }).adapter.types(),
    );
    expect(reason).toMatch(/larger than 5 MB/);
  });
});

describe("sitemap and feed: dates", () => {
  const feedAtom = (updated: string) =>
    xml(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>${OAKLINE_MARKERS.spring}</title>
<link rel="self" href="${OAKLINE}/feed/1"/><link rel="alternate" href="${OAKLINE}/blog/spring-loaf"/><id>tag:oakline,2026:1</id>
<published>2026-01-05T08:00:00Z</published><updated>${updated}</updated><category term="Baking"/>
<summary>${OAKLINE_MARKERS.spring}</summary></entry></feed>`);
  const staleSite = (feed: Reply | undefined): Record<string, Reply> => ({
    "/robots.txt": text(`Sitemap: ${OAKLINE}/sitemap.xml\n`),
    "/sitemap.xml": urlset([
      { loc: `${OAKLINE}/blog/spring-loaf`, lastmod: "2026-01-06" },
      { loc: `${OAKLINE}/about`, lastmod: "2025-02-01" },
    ]),
    "/": html(`<link rel="alternate" type="application/atom+xml" href="/atom.xml">`),
    ...(feed === undefined ? {} : { "/atom.xml": feed }),
  });

  it("a stale lastmod gives way to a newer date in the feed: the newest is kept", async () => {
    const docs = await docsOf(build(staleSite(feedAtom("2026-10-15T10:00:00Z"))).adapter);
    const spring = docs.find((d) => d.slug === "spring-loaf");
    expect(spring?.updatedAt).toBe("2026-10-15T10:00:00.000Z");
    expect(spring?.publishedAt).toBe("2026-01-05T08:00:00.000Z");
  });

  it("with no feed to correct it, the lastmod stands, and `since` leaves the stale ones out", async () => {
    const { adapter } = build(staleSite(undefined));
    const all = await docsOf(adapter);
    expect(all.find((d) => d.slug === "spring-loaf")?.updatedAt).toBe("2026-01-06T00:00:00.000Z");
    expect(await docsOf(adapter, { since: "2026-10-01" })).toEqual([]);
    expect((await docsOf(adapter, { since: "2026-01-06" })).map((d) => d.slug)).toEqual([
      "spring-loaf",
    ]);
    expect(
      (
        await docsOf(build(staleSite(feedAtom("2026-10-15T10:00:00Z"))).adapter, {
          since: "2026-10-01",
        })
      ).map((d) => d.slug),
    ).toEqual(["spring-loaf"]);
  });

  it("an older date in the feed never lowers the lastmod", async () => {
    const docs = await docsOf(build(staleSite(feedAtom("2025-01-01T00:00:00Z"))).adapter);
    expect(docs.find((d) => d.slug === "spring-loaf")?.updatedAt).toBe("2026-01-06T00:00:00.000Z");
  });

  it("a feed with missing dates: the item is listed with no date, never one made up, and `since` keeps it", async () => {
    const routes: Record<string, Reply> = {
      "/": html(`<link rel="alternate" type="application/rss+xml" title="News" href="/news.rss">`),
      "/news.rss": xml(`<rss><channel>
<item><link>${OAKLINE}/news/dated</link><pubDate>Tue, 03 Nov 2026 09:00:00 GMT</pubDate></item>
<item><link>${OAKLINE}/news/undated</link></item>
<item><link>${OAKLINE}/news/garbled</link><pubDate>last Tuesday, probably</pubDate></item>
<item><link>${OAKLINE}/news/old</link><pubDate>Mon, 05 Jan 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`),
    };
    const { adapter } = build(routes);
    const docs = await docsOf(adapter);
    expect(docs.map((d) => [d.slug, d.publishedAt, d.updatedAt])).toEqual([
      ["dated", "2026-11-03T09:00:00.000Z", undefined],
      ["undated", undefined, undefined],
      ["garbled", undefined, undefined],
      ["old", "2026-01-05T09:00:00.000Z", undefined],
    ]);
    for (const d of docs) {
      expect("updatedAt" in d).toBe(false);
    }
    // The newest evidence is the publish date; an item with none is kept because nothing says it is old.
    expect((await docsOf(adapter, { since: "2026-11-01" })).map((d) => d.slug)).toEqual([
      "dated",
      "undated",
      "garbled",
    ]);
    expect(await adapter.types()).toEqual([{ name: "news", count: 4 }]);
  });

  it("a date with no zone is read as UTC, an offset is honoured, a date alone is midnight UTC, junk is no date", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": text(`Sitemap: ${OAKLINE}/sitemap.xml\n`),
      "/sitemap.xml": urlset([
        { loc: `${OAKLINE}/blog/a`, lastmod: "2026-11-02T10:00:00" },
        { loc: `${OAKLINE}/blog/b`, lastmod: "2026-11-02T10:00:00+02:00" },
        { loc: `${OAKLINE}/blog/c`, lastmod: "2026-11-02" },
        { loc: `${OAKLINE}/blog/d`, lastmod: "soon" },
        { loc: `${OAKLINE}/blog/e`, lastmod: "   " },
      ]),
    };
    const docs = await docsOf(build(routes).adapter);
    expect(docs.map((d) => d.updatedAt)).toEqual([
      "2026-11-02T10:00:00.000Z",
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
      undefined,
      undefined,
    ]);
  });

  it("a news sitemap's publication date is the published time", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": text(`Sitemap: ${OAKLINE}/news.xml\n`),
      "/news.xml": xml(
        `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>${OAKLINE}/news/x</loc><news:news><news:publication_date>2026-10-30T07:00:00Z</news:publication_date></news:news></url></urlset>`,
      ),
    };
    expect((await docsOf(build(routes).adapter))[0]?.publishedAt).toBe("2026-10-30T07:00:00.000Z");
  });

  it("since must be a date, and limit stops the list", async () => {
    const { adapter } = build(oaklineRoutes());
    await expect(collectPublished(adapter, { since: "last week" })).rejects.toThrow(TypeError);
    expect((await docsOf(adapter, { limit: 2 })).length).toBe(2);
    expect(await docsOf(adapter, { limit: 0 })).toEqual([]);
  });
});

describe("sitemap and feed: feed formats", () => {
  const withFeed = (path: string, type: string, feed: Reply): Record<string, Reply> => ({
    "/": html(`<link rel="alternate" type="${type}" href="${path}">`),
    [path]: feed,
  });

  it("Atom: the alternate link, published and updated, the category term", async () => {
    const routes = withFeed(
      "/atom.xml",
      "application/atom+xml",
      xml(
        `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="self" href="${OAKLINE}/atom/1"/><link href="/journal/first" /><published>2026-09-01T00:00:00Z</published><updated>2026-09-02T00:00:00Z</updated><category term="Journal"/></entry></feed>`,
      ),
    );
    expect(await docsOf(build(routes).adapter)).toEqual([
      {
        id: `${OAKLINE}/journal/first`,
        type: "journal",
        url: `${OAKLINE}/journal/first`,
        slug: "first",
        publishedAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        fieldHashes: {},
      },
    ]);
  });

  it("JSON Feed: url or an id that is an address, date_published, date_modified, the first tag", async () => {
    const routes = withFeed("/feed.json", "application/feed+json", {
      status: 200,
      headers: { "content-type": "application/feed+json" },
      body: JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: OAKLINE_MARKERS.spring,
        items: [
          {
            id: "1",
            url: `${OAKLINE}/notes/one`,
            date_published: "2026-10-01T00:00:00Z",
            date_modified: "2026-10-03T00:00:00Z",
            tags: ["Notes", "Other"],
            content_text: OAKLINE_MARKERS.rye,
          },
          { id: `${OAKLINE}/two`, title: OAKLINE_MARKERS.winter },
          { id: "three" },
          "not an item",
        ],
      }),
    });
    const docs = await docsOf(build(routes).adapter);
    expect(docs.map((d) => d.id)).toEqual([`${OAKLINE}/notes/one`, `${OAKLINE}/two`]);
    expect(docs[0]).toMatchObject({
      type: "notes",
      publishedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(JSON.stringify(docs)).not.toContain(OAKLINE_MARKERS.rye);
  });

  it("JSON Feed: an item whose id is an address is listed by it", async () => {
    const routes = withFeed("/feed.json", "application/feed+json", {
      status: 200,
      body: JSON.stringify({
        version: "https://jsonfeed.org/version/1",
        items: [{ id: `${OAKLINE}/two` }],
      }),
    });
    const docs = await docsOf(build(routes).adapter);
    expect(docs.map((d) => d.id)).toEqual([`${OAKLINE}/two`]);
  });

  it("JSON that is not a JSON Feed, and XML that is not a feed, are not read as one", async () => {
    const reason = await couldNot(
      build({
        ...withFeed("/feed.json", "application/feed+json", {
          status: 200,
          body: JSON.stringify({ items: [{ url: `${OAKLINE}/x` }] }),
        }),
      }).adapter.types(),
    );
    expect(reason).toMatch(/No sitemap or feed could be read/);
    expect(reason).toContain("/feed.json is not a feed");
  });

  it("RSS 1.0 reads dc:date, and an item with no link but a guid that is an address is listed by it", async () => {
    const routes = withFeed(
      "/index.rdf",
      "application/rss+xml",
      xml(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<item><link>${OAKLINE}/a</link><dc:date>2026-08-01T12:00:00Z</dc:date></item>
<item><guid isPermaLink="true">${OAKLINE}/b</guid></item>
<item><guid isPermaLink="false">urn:x:1</guid></item></rdf:RDF>`),
    );
    const docs = await docsOf(build(routes).adapter);
    expect(docs.map((d) => [d.id, d.publishedAt])).toEqual([
      [`${OAKLINE}/a`, "2026-08-01T12:00:00.000Z"],
      [`${OAKLINE}/b`, undefined],
    ]);
  });

  it("the comments feed a CMS advertises is not read", async () => {
    const { adapter, seen } = build(oaklineRoutes());
    await adapter.types();
    expect(asked(seen)).not.toContain(`${HOST}/comments/feed`);
    expect(asked(seen)).toContain(`${HOST}/blog?format=rss`);
  });

  it("with no feed advertised, a few usual paths are tried, and a 404 or a web page there is not an error", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": text(`Sitemap: ${OAKLINE}/sitemap.xml\n`),
      "/sitemap.xml": urlset([{ loc: `${OAKLINE}/about` }]),
      "/": html("<p>no feeds here</p>"),
      "/feed": html("<!doctype html><p>a page, not a feed</p>"),
      "/rss.xml": xml(
        `<rss><channel><item><link>${OAKLINE}/blog/in-rss</link></item></channel></rss>`,
      ),
    };
    const { adapter, seen } = build(routes);
    expect((await docsOf(adapter)).map((d) => d.slug)).toEqual(["about", "in-rss"]);
    expect(asked(seen)).toContain(`${HOST}/feed`);
    expect(seen.length).toBeLessThanOrEqual(1 + 1 + 1 + SITEMAP_FEED_LIMITS.feeds);
  });

  it("an advertised feed on another host is not read", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": text(`Sitemap: ${OAKLINE}/sitemap.xml\n`),
      "/sitemap.xml": urlset([{ loc: `${OAKLINE}/about` }]),
      "/": html(
        `<link rel="alternate" type="application/rss+xml" href="https://feeds.example.net/oakline">`,
      ),
    };
    const { adapter, seen } = build(routes);
    await docsOf(adapter);
    expect(asked(seen).every((l) => l.startsWith(`${HOST}/`))).toBe(true);
  });
});

describe("sitemap and feed: where it looks", () => {
  it("with no robots.txt it tries /sitemap.xml, then stops at the first that reads", async () => {
    const routes: Record<string, Reply> = {
      "/sitemap.xml": urlset([{ loc: `${OAKLINE}/menu` }]),
      "/sitemap_index.xml": urlset([{ loc: `${OAKLINE}/never-asked` }]),
    };
    const { adapter, seen } = build(routes);
    expect((await docsOf(adapter)).map((d) => d.slug)).toEqual(["menu"]);
    expect(asked(seen)).not.toContain(`${HOST}/sitemap_index.xml`);
  });

  it("a catch-all page at /sitemap.xml is not a sitemap; the next usual path is tried", async () => {
    const routes: Record<string, Reply> = {
      "/sitemap.xml": html("<!doctype html><p>Home</p>"),
      "/wp-sitemap.xml": sitemapIndex([`${OAKLINE}/wp-sitemap-posts-post-1.xml`]),
      "/wp-sitemap-posts-post-1.xml": urlset([
        { loc: `${OAKLINE}/2026/11/hello`, lastmod: "2026-11-02" },
      ]),
    };
    const docs = await docsOf(build(routes).adapter);
    expect(docs.map((d) => [d.slug, d.type])).toEqual([["hello", "2026"]]);
  });

  it("robots.txt reading is GET only and Sitemap: lines are matched whatever the case, with relative ones resolved", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": text(
        `User-agent: *\nDisallow: /private\nSITEMAP: /maps/all.xml\n# Sitemap: ${OAKLINE}/commented.xml\n`,
      ),
      "/maps/all.xml": urlset([{ loc: `${OAKLINE}/menu` }]),
    };
    const { adapter, seen } = build(routes);
    expect((await docsOf(adapter)).length).toBe(1);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(asked(seen)).not.toContain(`${HOST}/commented.xml`);
  });

  it("settings name the sitemaps and feeds to read: robots.txt and the guesses are skipped", async () => {
    const routes = oaklineRoutes();
    routes["/custom-sitemap.xml"] = urlset([{ loc: `${OAKLINE}/shop/x`, lastmod: "2026-11-01" }]);
    routes["/custom.rss"] = xml(
      `<rss><channel><item><link>${OAKLINE}/blog/y</link></item></channel></rss>`,
    );
    const { adapter, seen } = build(routes, {
      settings: { id: "sitemap-feed", sitemaps: ["/custom-sitemap.xml"], feeds: ["/custom.rss"] },
    });
    expect((await docsOf(adapter)).map((d) => d.slug)).toEqual(["x", "y"]);
    expect(asked(seen)).toEqual([`${HOST}/custom-sitemap.xml`, `${HOST}/custom.rss`]);
  });

  it("a sitemap named in settings that is on another site is refused, not read", async () => {
    const { adapter, seen } = build(oaklineRoutes(), {
      settings: { id: "sitemap-feed", sitemaps: ["https://other.example/sitemap.xml"] },
    });
    expect(await couldNot(adapter.types())).toContain("only the site's own sitemaps are read");
    expect(seen).toEqual([]);
  });

  it("the site comes from the settings entry before the run", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(serve(oaklineRoutes(), HOST), seen),
      timeoutMs: 5000,
    });
    const adapter = createSitemapFeedAdapter({
      fetcher,
      site: "https://wrong.example",
      settings: { id: "sitemap-feed", site: OAKLINE },
    });
    expect((await adapter.types()).length).toBeGreaterThan(0);
    expect(asked(seen)[0]).toBe(`${HOST}/robots.txt`);
  });

  it("with no site at all it is could-not-check and asks nothing", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({ transport: recording(serve({}, HOST), seen), timeoutMs: 5000 });
    for (const site of [undefined, "", "ftp://oakline-bakery.example", "not an address"]) {
      const adapter = createSitemapFeedAdapter({ fetcher, site });
      expect(await couldNot(adapter.types())).toMatch(/No site address/);
      await couldNot(collectPublished(adapter));
    }
    expect(seen).toEqual([]);
  });

  it("a site with no sitemap and no feed is could-not-check and says where it looked, never an empty list", async () => {
    const { adapter } = build({ "/": html("<p>hi</p>") });
    const reason = await couldNot(adapter.types());
    expect(reason).toContain("oakline-bakery.example");
    expect(reason).toMatch(/robots\.txt, \/sitemap\.xml/);
    expect(await couldNot(collectPublished(adapter))).toBe(reason);
  });

  it("a site that asks for a login says so", async () => {
    const reason = await couldNot(
      build({ "/sitemap.xml": { status: 401 }, "/robots.txt": { status: 401 } }).adapter.types(),
    );
    expect(reason).toContain("/sitemap.xml answered HTTP 401");
  });

  it("an address Gaugeline may not request (a private one) is could-not-check, through the real fetcher", async () => {
    const fetcher = createFetcher({
      resolver: () => Promise.resolve([{ address: "10.0.0.5", family: 4 }]),
      timeoutMs: 2000,
    });
    const adapter = createSitemapFeedAdapter({ fetcher, site: "https://intranet.example" });
    const reason = await couldNot(adapter.types());
    expect(reason).toMatch(/No sitemap or feed could be read/);
  });
});

describe("sitemap and feed: what a listed file must do", () => {
  const robots = (...locs: string[]): Reply => text(locs.map((l) => `Sitemap: ${l}\n`).join(""));

  it("a child the index names that is gone makes the read could-not-check, not a shorter list", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": robots(`${OAKLINE}/index.xml`),
      "/index.xml": sitemapIndex([`${OAKLINE}/a.xml`, `${OAKLINE}/gone.xml`]),
      "/a.xml": urlset([{ loc: `${OAKLINE}/menu` }]),
    };
    const { adapter } = build(routes);
    expect(await couldNot(adapter.types())).toContain(
      "/gone.xml is named as a sitemap but answers",
    );
    await couldNot(collectPublished(adapter));
  });

  it("a child that fails (500) or is not XML is could-not-check too", async () => {
    const base: Record<string, Reply> = {
      "/robots.txt": robots(`${OAKLINE}/index.xml`),
      "/index.xml": sitemapIndex([`${OAKLINE}/a.xml`]),
    };
    expect(await couldNot(build({ ...base, "/a.xml": { status: 503 } }).adapter.types())).toContain(
      "answered HTTP 503",
    );
    expect(
      await couldNot(build({ ...base, "/a.xml": html("<p>oops</p>") }).adapter.types()),
    ).toContain("is not a sitemap");
  });

  it("an index that lists itself, or two that list each other, are each read once", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": robots(`${OAKLINE}/a.xml`),
      "/a.xml": sitemapIndex([`${OAKLINE}/a.xml`, `${OAKLINE}/b.xml`]),
      "/b.xml": sitemapIndex([`${OAKLINE}/a.xml`, `${OAKLINE}/c.xml`]),
      "/c.xml": urlset([{ loc: `${OAKLINE}/menu` }]),
    };
    const { adapter, seen } = build(routes);
    expect((await docsOf(adapter)).map((d) => d.slug)).toEqual(["menu"]);
    for (const p of ["/a.xml", "/b.xml", "/c.xml"])
      expect(asked(seen).filter((l) => l === `${HOST}${p}`)).toHaveLength(1);
  });

  it("an index of too many files is could-not-check at the cap, and stops asking there", async () => {
    const children = Array.from(
      { length: SITEMAP_FEED_LIMITS.sitemapFiles + 10 },
      (_, i) => `${OAKLINE}/s${i}.xml`,
    );
    const routes: Record<string, Reply> = {
      "/robots.txt": robots(`${OAKLINE}/index.xml`),
      "/index.xml": sitemapIndex(children),
    };
    for (let i = 0; i < children.length; i++)
      routes[`/s${i}.xml`] = urlset([{ loc: `${OAKLINE}/p/${i}` }]);
    const { adapter, seen } = build(routes);
    expect(await couldNot(adapter.types())).toMatch(/more than 50 files/);
    expect(seen.length).toBeLessThanOrEqual(SITEMAP_FEED_LIMITS.sitemapFiles + 2);
  });

  it("more addresses than the cap is could-not-check, and exactly the cap is read whole", async () => {
    const many = (n: number): Record<string, Reply> => ({
      "/robots.txt": robots(`${OAKLINE}/big.xml`),
      "/big.xml": `<urlset>${Array.from({ length: n }, (_, i) => `<url><loc>${OAKLINE}/p/${i}</loc></url>`).join("")}</urlset>`,
    });
    const exact = await build(many(SITEMAP_FEED_LIMITS.entries)).adapter.types();
    expect(exact).toEqual([{ name: "p", count: SITEMAP_FEED_LIMITS.entries }]);
    expect(await couldNot(build(many(SITEMAP_FEED_LIMITS.entries + 1)).adapter.types())).toMatch(
      /50,000 addresses/,
    );
  });

  it("entries on another host, or that are not web addresses, are not the site's pages", async () => {
    const routes: Record<string, Reply> = {
      "/robots.txt": robots(`${OAKLINE}/s.xml`),
      "/s.xml": urlset([
        { loc: `${OAKLINE}/menu` },
        { loc: "https://staging.other-agency.example/menu" },
        { loc: "javascript:alert(1)" },
        { loc: "mailto:the-baker" },
        { loc: "http://oakline-bakery.example/about#team" },
        { loc: "not a url" },
      ]),
    };
    expect((await docsOf(build(routes).adapter)).map((d) => d.id)).toEqual([
      `${OAKLINE}/menu`,
      "http://oakline-bakery.example/about",
    ]);
  });
});

describe("sitemap and feed: XML that attacks the parser", () => {
  const entityBomb = `<?xml version="1.0"?>
<!DOCTYPE urlset [
<!ENTITY xxe SYSTEM "file:///etc/passwd">
<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
<!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
<urlset><url><loc>${OAKLINE}/&d;</loc></url><url><loc>${OAKLINE}/&xxe;</loc></url><url><loc>${OAKLINE}/safe</loc></url></urlset>`;

  it("an entity bomb and an external entity are read as the plain text they are: nothing expands, no file is read", () => {
    const started = Date.now();
    const parsed = parseSitemapEntries(entityBomb);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(parsed.kind).toBe("urlset");
    const joined = parsed.entries.map((e) => e.loc).join("\n");
    expect(joined).not.toContain("aaaa");
    expect(joined).not.toContain("root:");
    expect(joined.length).toBeLessThan(500);
    expect(parseSitemap(entityBomb).locs.join("")).not.toContain("aaaa");
  });

  it("through the adapter: the bomb lists the addresses it literally says and asks for nothing else", async () => {
    const { adapter, seen } = build({
      "/robots.txt": text(`Sitemap: ${OAKLINE}/s.xml\n`),
      "/s.xml": entityBomb,
    });
    const docs = await docsOf(adapter);
    expect(docs.map((d) => d.slug)).toContain("safe");
    expect(JSON.stringify(docs)).not.toContain("aaaa");
    expect(asked(seen).every((l) => l.startsWith(`${HOST}/`))).toBe(true);
  });
});

describe("sitemap and feed: types and addresses", () => {
  it("a category names the group only for an address with no folder; a folder wins", async () => {
    const routes: Record<string, Reply> = {
      "/": html(`<link rel="alternate" type="application/rss+xml" href="/f.xml">`),
      "/f.xml": xml(`<rss><channel>
<item><link>${OAKLINE}/one-post</link><category>Recipes &amp; Bakes</category></item>
<item><link>${OAKLINE}/blog/two</link><category>Recipes</category></item>
<item><link>${OAKLINE}/three</link><category>   </category></item>
<item><link>${OAKLINE}/Caf%C3%A9/menu</link></item>
</channel></rss>`),
    };
    const { adapter } = build(routes);
    expect(await adapter.types()).toEqual([
      { name: "blog", count: 1 },
      { name: "café", count: 1 },
      { name: "recipes-bakes", count: 1 },
      { name: TOP_LEVEL, count: 1 },
    ]);
  });

  it("an item has an id and an address that are the same, a slug from its last segment, and resolveUrl gives it back", async () => {
    const adapter = build(oaklineRoutes()).adapter;
    const doc = (await docsOf(adapter, { types: ["shop"] }))[0];
    expect(doc).toMatchObject({
      id: `${OAKLINE}/shop/sourdough-box`,
      url: `${OAKLINE}/shop/sourdough-box`,
      slug: "sourdough-box",
      fieldHashes: {},
    });
    expect(adapter.resolveUrl?.({ id: doc?.id ?? "", type: "shop" })).toBe(doc?.id);
    expect(adapter.resolveUrl?.({ id: "post-1", type: "post", slug: "x" })).toBe("");
    expect((await docsOf(adapter, { types: [TOP_LEVEL] }))[0]).not.toHaveProperty("slug");
  });

  it("no feed text appears in anything it returns, throws or asks", async () => {
    const { adapter, seen } = build(oaklineRoutes());
    const out = JSON.stringify([await adapter.types(), await docsOf(adapter), asked(seen)]);
    for (const marker of Object.values(OAKLINE_MARKERS)) expect(out).not.toContain(marker);
  });
});

describe("sitemap and feed: the parsers it shares with the site checks", () => {
  it("parseSitemap still gives the same answer, and the entries carry their dates", () => {
    const doc = `<urlset><url><loc>https://a.example/x</loc><lastmod>2026-01-01</lastmod></url><url><lastmod>2026-02-02</lastmod><loc>https://a.example/y</loc></url><url><loc>https://a.example/z</loc></url></urlset>`;
    expect(parseSitemap(doc)).toEqual({
      kind: "urlset",
      locs: ["https://a.example/x", "https://a.example/y", "https://a.example/z"],
    });
    expect(parseSitemapEntries(doc).entries).toEqual([
      { loc: "https://a.example/x", lastmod: "2026-01-01" },
      { loc: "https://a.example/y", lastmod: "2026-02-02" },
      { loc: "https://a.example/z" },
    ]);
    expect(parseSitemapEntries("<html></html>")).toEqual({ kind: "unknown", entries: [] });
  });

  it("parseFeedLinks gives the item links as before; parseFeed adds the dates and says what kind of feed it is", () => {
    const rss = `<rss><channel><item><title>t</title><link>/a</link><pubDate>Mon, 02 Mar 2026 08:00:00 GMT</pubDate></item></channel></rss>`;
    expect(parseFeedLinks(rss, "https://a.example/feed")).toEqual(["https://a.example/a"]);
    expect(parseFeed(rss, "https://a.example/feed")).toEqual({
      kind: "rss",
      entries: [{ links: ["https://a.example/a"], published: "Mon, 02 Mar 2026 08:00:00 GMT" }],
    });
    expect(
      parseFeed(`<feed><entry><link href="/b"/></entry></feed>`, "https://a.example/").kind,
    ).toBe("atom");
    expect(parseFeed("<html><body></body></html>", "https://a.example/")).toEqual({
      kind: "unknown",
      entries: [],
    });
  });
});

describe("sitemap and feed: the settings and the default", () => {
  it("is a built adapter a settings file can name, with its own settings", () => {
    const config = adaptersConfigSchema.parse({
      adapters: [
        {
          id: "sitemap-feed",
          site: OAKLINE,
          sitemaps: ["/sitemap.xml"],
          feeds: ["https://oakline-bakery.example/feed"],
        },
      ],
    });
    expect(resolveAdapters(config).map((b) => b.id)).toEqual(["sitemap-feed"]);
  });

  it("site, sitemaps and feeds belong to sitemap-feed; fingerprint and urls mean nothing to it", () => {
    const bad = (entry: unknown) => adaptersConfigSchema.safeParse({ adapters: [entry] });
    expect(bad({ id: "sanity", site: OAKLINE }).success).toBe(false);
    expect(bad({ id: "sanity", feeds: ["/f"] }).success).toBe(false);
    expect(bad({ id: "sitemap-feed", fingerprint: { post: ["title"] } }).success).toBe(false);
    expect(bad({ id: "sitemap-feed", urls: { post: "/blog/{slug}" } }).success).toBe(false);
    expect(bad({ id: "sitemap-feed", site: "javascript:alert(1)" }).success).toBe(false);
    expect(bad({ id: "sitemap-feed", sitemaps: ["ftp://x.example/s.xml"] }).success).toBe(false);
    expect(bad({ id: "sitemap-feed", sitemaps: ["/sitemap.xml"] }).success).toBe(true);
    expect(bad({ id: "sanity", fingerprint: { post: ["title"] } }).success).toBe(true);
  });

  it("with no settings file it is the default adapter, when the run has a site", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(serve(oaklineRoutes(), HOST), seen),
      timeoutMs: 5000,
    });
    const adapters = await adaptersOrDefault(undefined, { env: {}, fetcher, site: OAKLINE });
    expect(adapters.map((a) => a.id)).toEqual(["sitemap-feed"]);
    expect((await adapters[0]?.types())?.length).toBeGreaterThan(0);
    expect(await adaptersOrDefault(undefined, { env: {}, fetcher })).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("a settings file that names an adapter gets that one and no default beside it", async () => {
    const fetcher = createFetcher({ transport: serve({}, HOST) });
    const config = adaptersConfigSchema.parse({ adapters: [{ id: "sanity" }] });
    const adapters = await adaptersOrDefault(config, { env: {}, fetcher, site: OAKLINE });
    expect(adapters.map((a) => a.id)).toEqual(["sanity"]);
    expect((await createAdapters(config, { env: {}, fetcher })).map((a) => a.id)).toEqual([
      "sanity",
    ]);
  });

  it("it needs no key: it says so, and the environment is never read", async () => {
    const fetcher = createFetcher({ transport: serve({}, HOST) });
    const env = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the sitemap adapter must not read the environment");
        },
      },
    );
    const [adapter] = await adaptersOrDefault(undefined, { env, fetcher, site: OAKLINE });
    expect(adapter?.describe()).toMatchObject({
      name: "Sitemap and feeds",
      keyKind: "read-only",
      noKey: true,
    });
  });
});
