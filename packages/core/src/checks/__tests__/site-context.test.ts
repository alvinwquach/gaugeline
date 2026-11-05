import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import { isAllowed, parseRobots } from "../../robots.js";
import { checkSite } from "../../site.js";
import {
  buildSiteContext,
  parseFeedLinks,
  parseSitemap,
  type FeedRead,
  type SiteContext,
} from "../../site-context.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { feedInvalid, startsLikeFeed } from "../feed-invalid.js";
import { FEED_MAX_BYTES, feedOversized } from "../feed-oversized.js";
import { feedBroken } from "../feed-broken.js";
import { createPageRegistry } from "../index.js";
import { robotsBlock } from "../robots-block.js";
import { sitemapDead } from "../sitemap-dead.js";
import { sitemapHost } from "../sitemap-host.js";
import { sitemapMissing } from "../sitemap-missing.js";
import { sitemapRedirects } from "../sitemap-redirects.js";
import { page } from "./helpers.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function serve(...args: Parameters<typeof startServer>) {
  const s = await startServer(...args);
  servers.push(s);
  return s;
}
const warn = () => undefined;

/** A handler that answers synchronously, so a test can call it from inside another. */
function send(
  body: string | Buffer,
  type: string,
  status = 200,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    res.writeHead(status, { "content-type": type }).end(body);
  };
}

const PAGE_HTML = "<!doctype html><title>Home</title><p>Home page.</p>";

/** A site context built against a local server, for the page at its root. */
async function contextFor(
  server: FixtureServer,
  feeds: string[] = [],
): Promise<{ site: SiteContext; finalUrl: string }> {
  const finalUrl = `${server.origin}/`;
  const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
  const site = await buildSiteContext({
    page: page({
      finalUrl,
      feeds: feeds.map((href) => ({
        href: `${server.origin}${href}`,
        type: "application/rss+xml",
      })),
    }),
    fetcher,
    budget: createBudget(),
  });
  return { site, finalUrl };
}

/** Run one check against a ready-made site context. */
async function runWith(
  check: { run: (p: ReturnType<typeof page>, ctx: never) => unknown },
  site: SiteContext,
  finalUrl = "https://tea.example/",
) {
  return check.run(page({ finalUrl }), { warn, site: async () => site } as never) as Promise<
    { checkId: string; evidence: string; url: string }[]
  >;
}

function emptySite(overrides: Partial<SiteContext> = {}): SiteContext {
  return {
    robotsUrl: "https://tea.example/robots.txt",
    robots: null,
    robotsState: "missing",
    sitemaps: [],
    sitemapUrls: [],
    sitemapAlternates: [],
    sitemapSample: [],
    feeds: [],
    llms: { url: "https://tea.example/llms.txt", state: "missing", file: null },
    ...overrides,
  };
}

function hop(url: string, status: number, extra: Partial<Hop> = {}): Hop {
  return { url, status, headers: {}, ms: 1, ...extra };
}

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><link>https://tea.example/a</link></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="/b"/></entry><entry><link rel="enclosure" href="/x.mp3"/><link rel="alternate" href="/c"/></entry></feed>`;

describe("robots matcher: unit (table)", () => {
  const cases: [name: string, robots: string, agent: string, path: string, allowed: boolean][] = [
    ["prefix disallow", "User-agent: *\nDisallow: /private", "*", "/private/x", false],
    ["prefix leaves others", "User-agent: *\nDisallow: /private", "*", "/public", true],
    ["* wildcard", "User-agent: *\nDisallow: /*.pdf", "*", "/files/menu.pdf?v=2", false],
    ["$ anchors the end", "User-agent: *\nDisallow: /*.pdf$", "*", "/files/menu.pdf", false],
    ["$ with a query after", "User-agent: *\nDisallow: /*.pdf$", "*", "/files/menu.pdf?v=2", true],
    ["$ on a longer path", "User-agent: *\nDisallow: /*.pdf$", "*", "/files/menu.pdfx", true],
    ["paths are case-sensitive", "User-agent: *\nDisallow: /fish", "*", "/Fish", true],
    [
      "longest match wins",
      "User-agent: *\nDisallow: /shop\nAllow: /shop/public",
      "*",
      "/shop/public/tea",
      true,
    ],
    [
      "longest disallow wins",
      "User-agent: *\nAllow: /shop\nDisallow: /shop/cart",
      "*",
      "/shop/cart",
      false,
    ],
    [
      "allow beats disallow on a tie",
      "User-agent: *\nDisallow: /page\nAllow: /page",
      "*",
      "/page",
      true,
    ],
    ["empty Disallow allows everything", "User-agent: *\nDisallow:", "*", "/", true],
    ["empty Allow is no rule", "User-agent: *\nDisallow: /\nAllow:", "*", "/menu", false],
    [
      "a named group replaces *",
      "User-agent: teabot\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp",
      "TeaBot",
      "/menu",
      false,
    ],
    [
      "other crawlers use *",
      "User-agent: teabot\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp",
      "otherbot",
      "/menu",
      true,
    ],
    [
      "* group of a multi-group file",
      "User-agent: teabot\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp",
      "*",
      "/tmp/a",
      false,
    ],
    [
      "agents listed together share rules",
      "User-agent: a\nUser-agent: b\nDisallow: /x",
      "b",
      "/x",
      false,
    ],
    [
      "two * groups combine",
      "User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b",
      "*",
      "/b",
      false,
    ],
    ["a leading BOM is ignored", "\uFEFFUser-agent: *\nDisallow: /", "*", "/", false],
    ["CRLF and comments", "User-agent: * # all\r\nDisallow: /x # not x\r\n", "*", "/x/1", false],
    ["robots.txt itself is always allowed", "User-agent: *\nDisallow: /", "*", "/robots.txt", true],
    [
      "rules before any group are ignored",
      "Disallow: /\nUser-agent: *\nAllow: /a",
      "*",
      "/b",
      true,
    ],
    [
      "non-ASCII patterns match encoded paths",
      "User-agent: *\nDisallow: /café",
      "*",
      "/caf%C3%A9/menu",
      false,
    ],
  ];
  it.each(cases)("%s", (_name, robots, agent, path, allowed) => {
    expect(isAllowed(parseRobots(robots), agent, path)).toBe(allowed);
  });

  it("Sitemap: lines are collected in order, outside any group", () => {
    const file = parseRobots(
      "Sitemap: https://tea.example/a.xml\nUser-agent: *\nDisallow:\nsitemap: https://tea.example/b.xml",
    );
    expect(file.sitemaps).toEqual(["https://tea.example/a.xml", "https://tea.example/b.xml"]);
  });
});

describe("sitemap XML: unit", () => {
  it("a urlset gives its locs in order, entities decoded and CDATA read", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc> https://tea.example/a?x=1&amp;y=2 </loc><lastmod>2026-01-01</lastmod></url>
      <url><loc><![CDATA[https://tea.example/b]]></loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual({
      kind: "urlset",
      locs: ["https://tea.example/a?x=1&y=2", "https://tea.example/b"],
    });
  });

  it("a sitemapindex gives its child sitemaps; an image:loc inside a url is not an entry", () => {
    expect(
      parseSitemap(
        `<sitemapindex><sitemap><loc>https://tea.example/s1.xml</loc></sitemap></sitemapindex>`,
      ),
    ).toEqual({ kind: "sitemapindex", locs: ["https://tea.example/s1.xml"] });
    expect(
      parseSitemap(
        `<urlset><url><loc>https://tea.example/a</loc><image:image><image:loc>https://tea.example/i.png</image:loc></image:image></url></urlset>`,
      ).locs,
    ).toEqual(["https://tea.example/a"]);
  });

  it("an HTML page is unknown and lists nothing", () => {
    expect(parseSitemap(PAGE_HTML)).toEqual({ kind: "unknown", locs: [] });
  });

  it("a gzip sitemap (sitemap.xml.gz) is decompressed and read", async () => {
    const xml = `<urlset><url><loc>http://127.0.0.1/menu</loc></url></urlset>`;
    const gz = await serve({
      "/robots.txt": (req, res) =>
        send(`Sitemap: http://${req.headers.host}/sitemap.xml.gz\n`, "text/plain")(req, res),
      "/sitemap.xml.gz": (req, res) =>
        send(
          gzipSync(xml.replace("http://127.0.0.1", `http://${req.headers.host}`)),
          "application/gzip",
        )(req, res),
      "/menu": send(PAGE_HTML, "text/html"),
    });
    const { site } = await contextFor(gz);
    expect(site.sitemaps[0]).toMatchObject({ kind: "urlset", entries: 1, status: 200 });
    expect(site.sitemapUrls).toEqual([`${gz.origin}/menu`]);
    expect(site.sitemapSample[0]?.at(-1)?.status).toBe(200);
  });

  it("a sitemap with 50,000 entries: all are listed, only 25 are requested", async () => {
    let entryRequests = 0;
    const server = await serve(
      {
        "/robots.txt": send("User-agent: *\nAllow: /\n", "text/plain"),
        "/sitemap.xml": (req, res) => {
          const locs = Array.from(
            { length: 50_000 },
            (_, i) => `<url><loc>http://${req.headers.host}/p/${i}</loc></url>`,
          ).join("");
          send(`<urlset>${locs}</urlset>`, "application/xml")(req, res);
        },
      },
      (req, res) => {
        if (req.url?.startsWith("/p/")) entryRequests += 1;
        send(PAGE_HTML, "text/html")(req, res);
      },
    );
    const { site } = await contextFor(server);
    expect(site.sitemapUrls).toHaveLength(50_000);
    expect(site.sitemapSample).toHaveLength(25);
    expect(entryRequests).toBe(25);
    expect(
      server.log
        .filter((r) => r.path.startsWith("/p/"))
        .map((r) => r.path)
        .sort(),
    ).toEqual(Array.from({ length: 25 }, (_, i) => `/p/${i}`).sort());
  }, 20_000);
});

describe("feed-invalid: unit", () => {
  it("RSS and Atom start like a feed; an HTML error page and an empty body do not", () => {
    expect(startsLikeFeed(RSS)).toBe(true);
    expect(startsLikeFeed(ATOM)).toBe(true);
    expect(startsLikeFeed('\uFEFF  <!-- generated -->\n<rss version="2.0"></rss>')).toBe(true);
    expect(startsLikeFeed("<!doctype html><html><title>Not found</title></html>")).toBe(false);
    expect(startsLikeFeed("")).toBe(false);
    expect(startsLikeFeed("<rssfeed>")).toBe(false);
  });

  it("the check names the HTML start and the empty body", async () => {
    const feeds: FeedRead[] = [
      {
        url: "https://tea.example/feed.xml",
        hops: [hop("https://tea.example/feed.xml", 200, { body: RSS })],
        bytes: 10,
        itemLinks: [],
      },
      {
        url: "https://tea.example/atom.xml",
        hops: [hop("https://tea.example/atom.xml", 200, { body: ATOM })],
        bytes: 10,
        itemLinks: [],
      },
      {
        url: "https://tea.example/news",
        hops: [hop("https://tea.example/news", 200, { body: "<!DOCTYPE html><h1>Oops</h1>" })],
        bytes: 10,
        itemLinks: [],
      },
      {
        url: "https://tea.example/empty",
        hops: [hop("https://tea.example/empty", 200, { body: "" })],
        bytes: 0,
        itemLinks: [],
      },
    ];
    const found = await runWith(feedInvalid, emptySite({ feeds }));
    expect(found.map((f) => f.url)).toEqual([
      "https://tea.example/news",
      "https://tea.example/empty",
    ]);
    expect(found[0]?.evidence).toContain('starts with "<!DOCTYPE html><h1>Oops</h1>"');
    expect(found[1]?.evidence).toContain("empty body");
  });

  it("item links: RSS <link> text and Atom alternate hrefs, resolved against the feed", () => {
    expect(parseFeedLinks(RSS, "https://tea.example/feed.xml")).toEqual(["https://tea.example/a"]);
    expect(parseFeedLinks(ATOM, "https://tea.example/atom.xml")).toEqual([
      "https://tea.example/b",
      "https://tea.example/c",
    ]);
  });
});

describe("robots, sitemap and feed checks: integration (fixture site)", () => {
  it("a sitemap listing a 404 and a 301 gives sitemap-dead and sitemap-redirects, one finding each", async () => {
    const site = await startFixture("sitemap-feeds");
    try {
      const fetcher = createFetcher({ hosts: site.hosts, timeoutMs: 5000 });
      const { result } = await checkSite({ address: site.origin, fetcher });
      const ids = result.findings.map((f) => f.checkId);
      expect(ids.filter((id) => id === "sitemap-dead")).toHaveLength(1);
      expect(ids.filter((id) => id === "sitemap-redirects")).toHaveLength(1);
      const dead = result.findings.find((f) => f.checkId === "sitemap-dead");
      expect(dead?.evidence).toBe(
        "1 of 25 sampled sitemap entries return an error: /closed-room (404)",
      );
      const moved = result.findings.find((f) => f.checkId === "sitemap-redirects");
      expect(moved?.evidence).toBe(
        "1 of 25 sampled sitemap entries redirect: /old-menu (301 to /menu/01)",
      );
      // The events feed is a 404; the other checks pass on this fixture.
      expect(ids.filter((id) => id === "feed-broken")).toEqual(["feed-broken"]);
      for (const id of [
        "robots-block",
        "sitemap-missing",
        "sitemap-host",
        "feed-invalid",
        "feed-oversized",
      ]) {
        expect(result.passed).toContain(id);
      }
    } finally {
      await site.close();
    }
  });

  it("the fixture's hits Map shows 25 or fewer sitemap page requests and 3 or fewer feed requests", async () => {
    const site = await startFixture("sitemap-feeds");
    try {
      const fetcher = createFetcher({ hosts: site.hosts, timeoutMs: 5000 });
      const { budget } = await checkSite({ address: site.origin, fetcher });
      // The sitemap's order: /menu/01 to /menu/30, with entries 3 and 5 replaced (see the README).
      const listed = Array.from({ length: 30 }, (_, i) =>
        i === 2
          ? "/old-menu"
          : i === 4
            ? "/closed-room"
            : `/menu/${String(i + 1).padStart(2, "0")}`,
      );
      const entryHits = listed.reduce((n, p) => n + (site.hits.get(p) ?? 0), 0);
      // /menu/01 is also where /old-menu redirects, so it may be asked for twice.
      expect(entryHits - Math.max(0, (site.hits.get("/menu/01") ?? 0) - 1)).toBeLessThanOrEqual(25);
      for (const p of listed.slice(25)) expect(site.hits.get(p) ?? 0, p).toBe(0);
      const feedHits = ["/feed.xml", "/atom.xml", "/events/feed", "/press.xml"].map(
        (p) => site.hits.get(p) ?? 0,
      );
      expect(feedHits).toEqual([1, 1, 1, 0]);
      expect(budget.summary().sitemapPages).toEqual({ limit: 25, sampled: 25, found: 30 });
      expect(budget.summary().feeds).toEqual({ limit: 3, sampled: 3, found: 4 });
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("a run that only needs the page builds no site context and requests no robots.txt", async () => {
    const site = await startFixture("sitemap-feeds");
    try {
      const fetcher = createFetcher({ hosts: site.hosts, timeoutMs: 5000 });
      await checkSite({ address: site.origin, fetcher, only: ["canonical-elsewhere"] });
      expect(site.hits.get("/robots.txt") ?? 0).toBe(0);
      expect(site.total).toBe(1);
    } finally {
      await site.close();
    }
  });
});

describe("robots, sitemap and feed checks: edge cases", () => {
  it("robots.txt 404 is allowed: no robots file, no robots-block", async () => {
    const server = await serve({ "/": send(PAGE_HTML, "text/html") });
    const { site, finalUrl } = await contextFor(server);
    expect(site.robots).toBeNull();
    expect(site.robotsState).toBe("missing");
    expect(await runWith(robotsBlock, site, finalUrl)).toEqual([]);
    // With no robots.txt and no /sitemap.xml, the sitemap is missing.
    const missing = await runWith(sitemapMissing, site, finalUrl);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.evidence).toBe(
      `${server.origin}/sitemap.xml returned 404; there is no robots.txt`,
    );
  });

  it("robots.txt 500 is unknown: neither robots-block nor sitemap-missing is reported", async () => {
    const server = await serve({ "/robots.txt": send("oops", "text/plain", 500) });
    const { site, finalUrl } = await contextFor(server);
    expect(site.robotsState).toBe("unknown");
    expect(await runWith(robotsBlock, site, finalUrl)).toEqual([]);
    expect(await runWith(sitemapMissing, site, finalUrl)).toEqual([]);
  });

  it("robots.txt answered with an HTML page is treated as no robots file", async () => {
    const server = await serve({
      "/robots.txt": send("<!doctype html><title>Home</title><p>Disallow: /</p>", "text/html"),
    });
    const { site, finalUrl } = await contextFor(server);
    expect(site.robots).toBeNull();
    expect(site.robotsState).toBe("missing");
    expect(await runWith(robotsBlock, site, finalUrl)).toEqual([]);
  });

  it("robots-block: Disallow: / for * is a finding; the same with Allow: / is not", async () => {
    const block = await serve({
      "/robots.txt": send("User-agent: *\nDisallow: /\n", "text/plain"),
    });
    const ctx = await contextFor(block);
    const found = await runWith(robotsBlock, ctx.site, ctx.finalUrl);
    expect(found).toEqual([
      expect.objectContaining({
        checkId: "robots-block",
        evidence: `${block.origin}/robots.txt has User-agent: * with Disallow: /`,
      }),
    ]);
    const tie = await serve({
      "/robots.txt": send("User-agent: *\nDisallow: /\nAllow: /\n", "text/plain"),
    });
    const ok = await contextFor(tie);
    expect(await runWith(robotsBlock, ok.site, ok.finalUrl)).toEqual([]);
  });

  it("a sitemap index that lists itself does not loop", async () => {
    const server = await serve({
      "/robots.txt": (req, res) =>
        send(`Sitemap: http://${req.headers.host}/index.xml\n`, "text/plain")(req, res),
      "/index.xml": (req, res) =>
        send(
          `<sitemapindex><sitemap><loc>http://${req.headers.host}/index.xml</loc></sitemap><sitemap><loc>http://${req.headers.host}/pages.xml</loc></sitemap></sitemapindex>`,
          "application/xml",
        )(req, res),
      "/pages.xml": (req, res) =>
        send(
          `<urlset><url><loc>http://${req.headers.host}/a</loc></url></urlset>`,
          "application/xml",
        )(req, res),
      "/a": send(PAGE_HTML, "text/html"),
    });
    const { site } = await contextFor(server);
    expect(server.log.filter((r) => r.path === "/index.xml")).toHaveLength(1);
    expect(site.sitemaps.map((s) => new URL(s.url).pathname)).toEqual(["/index.xml", "/pages.xml"]);
    expect(site.sitemapUrls).toEqual([`${server.origin}/a`]);
  });

  it("a feed served as text/html with a valid RSS body is not feed-invalid", async () => {
    const server = await serve({ "/feed": send(RSS, "text/html; charset=utf-8") });
    const { site, finalUrl } = await contextFor(server, ["/feed"]);
    expect(site.feeds[0]?.itemLinks).toEqual(["https://tea.example/a"]);
    expect(await runWith(feedInvalid, site, finalUrl)).toEqual([]);
  });

  it("a 2 MB feed exactly is not feed-oversized; one byte more is", async () => {
    const pad = (n: number) => {
      const head = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>`;
      const tail = "</channel></rss>";
      return head + "<!--" + "x".repeat(n - head.length - tail.length - 7) + "-->" + tail;
    };
    const server = await serve({
      "/exact.xml": send(pad(FEED_MAX_BYTES), "application/rss+xml"),
      "/over.xml": send(pad(FEED_MAX_BYTES + 1), "application/rss+xml"),
    });
    const { site, finalUrl } = await contextFor(server, ["/exact.xml", "/over.xml"]);
    expect(site.feeds.map((f) => f.bytes)).toEqual([FEED_MAX_BYTES, FEED_MAX_BYTES + 1]);
    const found = await runWith(feedOversized, site, finalUrl);
    expect(found.map((f) => f.url)).toEqual([`${server.origin}/over.xml`]);
    expect(found[0]?.evidence).toContain("2,097,153 bytes");
  });

  it("feed-broken names each feed that returns 4xx or 5xx; a feed that cannot be reached is not one", async () => {
    const site = emptySite({
      feeds: [
        {
          url: "https://tea.example/a.xml",
          hops: [hop("https://tea.example/a.xml", 410)],
          bytes: 0,
          itemLinks: [],
        },
        { url: "https://tea.example/b.xml", hops: [], bytes: 0, itemLinks: [] },
        {
          url: "https://tea.example/c.xml",
          hops: [hop("https://tea.example/c.xml", 200, { body: RSS })],
          bytes: 9,
          itemLinks: [],
        },
      ],
    });
    const found = await runWith(feedBroken, site);
    expect(found.map((f) => f.evidence)).toEqual(["https://tea.example/a.xml returned 410"]);
  });

  it("sitemap-host: every entry on another host is a finding; one entry on the site's host is not", async () => {
    const other = emptySite({
      sitemaps: [
        { url: "https://tea.example/sitemap.xml", status: 200, kind: "urlset", entries: 2 },
      ],
      sitemapUrls: ["https://staging.tea.example/a", "https://staging.tea.example/b"],
    });
    const found = await runWith(sitemapHost, other);
    expect(found[0]?.evidence).toBe(
      "all 2 sitemap entries use staging.tea.example; the site is tea.example",
    );
    const mixed = emptySite({
      sitemapUrls: ["https://staging.tea.example/a", "https://tea.example/b"],
    });
    expect(await runWith(sitemapHost, mixed)).toEqual([]);
    expect(await runWith(sitemapHost, emptySite())).toEqual([]);
  });

  it("sitemap-missing: a 200 HTML page at /sitemap.xml is not a sitemap; a named sitemap is never missing", async () => {
    const spa = emptySite({
      robots: parseRobots("User-agent: *\nAllow: /"),
      robotsState: "found",
      sitemaps: [
        { url: "https://tea.example/sitemap.xml", status: 200, kind: "unknown", entries: 0 },
      ],
    });
    const found = await runWith(sitemapMissing, spa);
    expect(found[0]?.evidence).toBe(
      "https://tea.example/sitemap.xml returned 200 but is not a sitemap (no urlset or sitemapindex); robots.txt has no Sitemap: line",
    );
    const named = emptySite({
      robots: parseRobots("Sitemap: https://tea.example/s.xml"),
      robotsState: "found",
      sitemaps: [{ url: "https://tea.example/s.xml", status: 404, kind: "unknown", entries: 0 }],
    });
    expect(await runWith(sitemapMissing, named)).toEqual([]);
  });

  it("a redirect that ends in an error is sitemap-dead only, not also sitemap-redirects", async () => {
    const site = emptySite({
      sitemapUrls: ["https://tea.example/a"],
      sitemapSample: [[hop("https://tea.example/a", 301), hop("https://tea.example/b", 404)]],
    });
    expect(await runWith(sitemapRedirects, site)).toEqual([]);
    expect(await runWith(sitemapDead, site)).toHaveLength(1);
  });

  it("the page checks registry includes all eight, sorted by id", () => {
    const ids = createPageRegistry()
      .all()
      .map((c) => c.id);
    for (const id of [
      "robots-block",
      "sitemap-missing",
      "sitemap-dead",
      "sitemap-redirects",
      "sitemap-host",
      "feed-broken",
      "feed-invalid",
      "feed-oversized",
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids).toEqual([...ids].sort());
  });
});
