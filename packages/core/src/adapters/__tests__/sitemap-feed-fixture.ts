import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { Transport } from "../../fetcher.js";

/**
 * Oakline Bakery's invented site: a neighbourhood bakery whose freelancer built it on Squarespace.
 * Nothing here was recorded from a real site. It has a sitemap index with three children (one of them
 * gzip), a robots.txt that also names a sitemap on another host, a blog feed with a post that has no
 * date and a recipe that is in the feed and not in the sitemap, and a comments feed that must never be
 * read. The text in the feed (titles, descriptions, content) is what an adapter must never return.
 */
export const OAKLINE = "https://oakline-bakery.example";

export const OAKLINE_MARKERS = {
  spring: "Spring loaf is back, with a secret ingredient",
  winter: "Winter opening hours, before we announce them",
  rye: "Our rye starter, fed since 2019",
  comment: "Great bread, I will tell my neighbours",
} as const;

/** A reply: text or bytes with a 200, or a status with headers. */
export type Reply =
  string | Buffer | { status: number; headers?: Record<string, string>; body?: string | Buffer };

export const xml = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;

export const urlset = (urls: readonly { loc: string; lastmod?: string }[]): string =>
  xml(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map(
        (u) =>
          `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`,
      )
      .join("")}</urlset>`,
  );

export const sitemapIndex = (children: readonly string[]): string =>
  xml(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children
      .map((c) => `<sitemap><loc>${c}</loc></sitemap>`)
      .join("")}</sitemapindex>`,
  );

/** The answers of a site, by path and query. Anything not listed is 404. Every request is a GET or HEAD answered from memory. */
export function serve(
  routes: Readonly<Record<string, Reply>>,
  host = new URL(OAKLINE).host,
): Transport {
  return (url) => {
    const reply = url.host === host ? routes[`${url.pathname}${url.search}`] : undefined;
    const r =
      reply === undefined
        ? { status: 404, body: "not found" }
        : typeof reply === "string" || Buffer.isBuffer(reply)
          ? { status: 200, body: reply }
          : reply;
    const body = r.body === undefined ? Buffer.alloc(0) : Buffer.from(r.body);
    return Promise.resolve({
      status: r.status,
      headers: { "content-type": "application/xml", ...(r.headers ?? {}) },
      body: Readable.from([body]),
    });
  };
}

const HOME = `<!doctype html><html><head><title>${OAKLINE_MARKERS.winter}</title>
<link rel="alternate" type="application/rss+xml" title="Blog" href="/blog?format=rss">
<link rel="alternate" type="application/rss+xml" title="Comments Feed" href="/comments/feed">
</head><body><h1>Oakline Bakery</h1></body></html>`;

const BLOG_FEED =
  xml(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Oakline Bakery blog</title><link>${OAKLINE}/blog</link>
<item><title>${OAKLINE_MARKERS.spring}</title><link>${OAKLINE}/blog/spring-loaf/</link><guid>spring-1</guid>
<pubDate>Mon, 02 Mar 2026 08:00:00 GMT</pubDate><description>${OAKLINE_MARKERS.spring}</description></item>
<item><title>${OAKLINE_MARKERS.winter}</title><link>${OAKLINE}/blog/winter-hours</link><guid>winter-1</guid>
<description>${OAKLINE_MARKERS.winter}</description></item>
<item><title>${OAKLINE_MARKERS.rye}</title><link>${OAKLINE}/rye-recipe</link><guid>rye-1</guid>
<pubDate>Fri, 06 Nov 2026 07:30:00 GMT</pubDate><category>Recipes</category>
<content:encoded><![CDATA[<p>${OAKLINE_MARKERS.rye}</p>]]></content:encoded></item>
<item><title>Cross-posted</title><link>https://medium.example/oakline/cross-post</link><pubDate>Fri, 06 Nov 2026 07:30:00 GMT</pubDate></item>
</channel></rss>`);

const COMMENTS_FEED = xml(
  `<rss version="2.0"><channel><item><title>${OAKLINE_MARKERS.comment}</title><link>${OAKLINE}/blog/spring-loaf/#comment-1</link></item></channel></rss>`,
);

/** The healthy site's routes. A test changes one by spreading it into a new object. */
export function oaklineRoutes(): Record<string, Reply> {
  return {
    "/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nAllow: /\nSitemap: ${OAKLINE}/sitemap_index.xml\nSitemap: https://cdn.example.net/oakline/other-sitemap.xml\n`,
    },
    "/sitemap_index.xml": sitemapIndex([
      `${OAKLINE}/sitemap-pages.xml`,
      `${OAKLINE}/sitemap-blog.xml.gz`,
      `${OAKLINE}/sitemap-shop.xml`,
      "https://cdn.example.net/oakline/more.xml",
    ]),
    "/sitemap-pages.xml": urlset([
      { loc: `${OAKLINE}/`, lastmod: "2026-10-20" },
      { loc: `${OAKLINE}/about`, lastmod: "2026-06-01" },
      { loc: `${OAKLINE}/menu`, lastmod: "2026-11-05T09:30:00+01:00" },
    ]),
    "/sitemap-blog.xml.gz": {
      status: 200,
      headers: { "content-type": "application/gzip" },
      body: gzipSync(
        urlset([
          { loc: `${OAKLINE}/blog/spring-loaf`, lastmod: "2026-03-01" },
          { loc: `${OAKLINE}/blog/winter-hours`, lastmod: "2026-10-02" },
          { loc: `${OAKLINE}/blog/pop-up-saturday` },
        ]),
      ),
    },
    "/sitemap-shop.xml": urlset([
      { loc: `${OAKLINE}/shop/sourdough-box`, lastmod: "2026-09-12" },
      { loc: `${OAKLINE}/shop/gift-card`, lastmod: "2026-09-12" },
    ]),
    "/": { status: 200, headers: { "content-type": "text/html" }, body: HOME },
    "/blog?format=rss": BLOG_FEED,
    "/comments/feed": COMMENTS_FEED,
  };
}
