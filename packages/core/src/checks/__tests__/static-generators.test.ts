import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import {
  devMarkers,
  draftMarker,
  generatorOf,
  normalizePath,
  pageDates,
  parseWhen,
  readSearchIndex,
  versionBanner,
} from "../../static-generators/detect.js";
import { staticDevServerLive } from "../static-dev-server-live.js";
import { staticDraftMarkerLive } from "../static-draft-marker-live.js";
import { staticFuturePostLive } from "../static-future-post-live.js";
import { staticOldVersionIndexed } from "../static-old-version-indexed.js";
import { staticPreviewCanonical } from "../static-preview-canonical.js";
import { staticSearchIndexHidden } from "../static-search-index-hidden.js";

const IDS = [
  "static-future-post-live",
  "static-draft-marker-live",
  "static-old-version-indexed",
  "static-search-index-hidden",
  "static-preview-canonical",
  "static-dev-server-live",
];
const NOW = new Date("2026-11-11T12:00:00Z");

function page(url: string, body: string, headers: Record<string, string> = {}, truncated = false) {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html", ...headers },
      body,
      ms: 1,
      ...(truncated ? { truncated: true } : {}),
    },
  ]);
}
const hugo = (head = "", body = "") =>
  `<html><head><meta name="generator" content="Hugo 0.139.0">${head}</head><body>${body}</body></html>`;
const U = "https://bakery.example/posts/loaf/";

describe("static generators: unit", () => {
  it("the generator comes from its meta tag, with a version when there is one", () => {
    const of = (c: string) =>
      generatorOf(page(U, `<head><meta name="generator" content="${c}"></head>`));
    expect(of("Hugo 0.139.0")).toEqual({ name: "hugo", version: "0.139.0" });
    expect(of("Jekyll v4.3.2")).toEqual({ name: "jekyll", version: "4.3.2" });
    expect(of("Eleventy v3.1.8")).toEqual({ name: "eleventy", version: "3.1.8" });
    expect(of("Docusaurus v3.10.2")).toEqual({ name: "docusaurus", version: "3.10.2" });
    expect(of("VitePress v1.6.4")).toEqual({ name: "vitepress", version: "1.6.4" });
    // Docusaurus's development template writes the name alone.
    expect(of("Docusaurus")).toEqual({ name: "docusaurus" });
    expect(of("WordPress 6.5")).toBeUndefined();
    expect(
      generatorOf(
        page(U, "<p>&lt;meta name=&quot;generator&quot; content=&quot;Hugo&quot;&gt;</p>"),
      ),
    ).toBeUndefined();
  });

  it("dates: ISO forms are read, a date with no zone is UTC, anything else is not a date", () => {
    expect(parseWhen("2031-01-04")).toBe(Date.UTC(2031, 0, 4));
    expect(parseWhen("2031-01-04 08:00:00")).toBe(Date.UTC(2031, 0, 4, 8));
    expect(parseWhen("2031-01-04T08:00:00+02:00")).toBe(Date.UTC(2031, 0, 4, 6));
    expect(parseWhen("soon")).toBeUndefined();
    expect(parseWhen("9".repeat(500))).toBeUndefined();
    expect(parseWhen("")).toBeUndefined();
  });

  it("page dates come from article:published_time and JSON-LD datePublished, @graph included", () => {
    const p = page(
      U,
      hugo(
        `<meta property="article:published_time" content="2031-01-04T08:00:00Z">` +
          `<script type="application/ld+json">{"@graph":[{"@type":"BlogPosting","datePublished":"2032-02-02"}]}</script>`,
      ),
    );
    expect(pageDates(p).map((d) => d.source)).toEqual(["article:published_time", "datePublished"]);
  });

  it("a future post is a finding only when it is a day or more ahead of the run's clock", async () => {
    const run = (date: string, body = hugo()) =>
      staticFuturePostLive.run(
        page(
          U,
          body.replace(
            "</head>",
            `<meta property="article:published_time" content="${date}"></head>`,
          ),
        ),
        { warn: () => undefined, now: () => NOW },
      );
    const far = await run("2031-01-04T08:00:00Z");
    expect(far.map((f) => f.evidence)).toEqual([
      "article:published_time is 2031-01-04, in the future",
    ]);
    // 20 hours ahead is inside the day of grace; +14:00 on the 12th is already past.
    expect(await run("2026-11-12T08:00:00Z")).toEqual([]);
    expect(await run("2026-11-12T01:00:00+14:00")).toEqual([]);
    expect(await run("2026-11-13T00:00:00Z")).toHaveLength(1);
    // Not a generator site: nothing to say.
    expect(await run("2031-01-04", "<html><head></head></html>")).toEqual([]);
  });

  it("draft markers: a class token, the Docusaurus banners; not words in prose or longer class names", () => {
    const of = (b: string) => draftMarker(page(U, hugo("", b)));
    expect(of('<span class="badge draft">Draft</span>')).toEqual({
      kind: "draft",
      marker: 'class "draft"',
    });
    expect(of('<div class="theme-draft-banner alert">x</div>')?.kind).toBe("draft");
    expect(of('<div class="theme-unlisted-banner">x</div>')).toEqual({
      kind: "unlisted",
      marker: 'class "theme-unlisted-banner"',
    });
    expect(of('<ul class="drafts-list"><li class="redraft">x</li></ul>')).toBeUndefined();
    expect(of("<p>This is a draft of the menu.</p>")).toBeUndefined();
  });

  it("a draft that is indexable, or listed in the sitemap, is a finding; a noindex draft outside it is not", async () => {
    const draft = hugo("", '<span class="draft">Draft</span>');
    const ctxWith = (urls: string[]): CheckContext => ({
      warn: () => undefined,
      site: async () => ({ sitemapUrls: urls }) as never,
    });
    const open = await staticDraftMarkerLive.run(page(U, draft), ctxWith([]));
    expect(open.map((f) => f.evidence)).toEqual([
      'marked as a draft (class "draft") and search engines may index it',
    ]);
    const noindex = draft.replace("</head>", '<meta name="robots" content="noindex"></head>');
    expect(await staticDraftMarkerLive.run(page(U, noindex), ctxWith([]))).toEqual([]);
    const listed = await staticDraftMarkerLive.run(page(U, noindex), ctxWith([U]));
    expect(listed.map((f) => f.evidence)).toEqual([
      'marked as a draft (class "draft") and the sitemap lists it',
    ]);
    // No sitemap read at all and a noindex: nothing proves it is public.
    expect(await staticDraftMarkerLive.run(page(U, noindex), { warn: () => undefined })).toEqual(
      [],
    );
  });

  it("an old Docusaurus version that is open to search engines is a finding", async () => {
    const banner =
      '<div class="theme-doc-version-banner">This is documentation for Shop 1.x, which is no longer actively maintained.</div>';
    const head = '<meta name="docusaurus_version" content="1.x">';
    const dg = (h: string, b: string) =>
      `<html><head><meta name="generator" content="Docusaurus v3.10.2">${h}</head><body>${b}</body></html>`;
    expect(versionBanner(page(U, dg(head, banner)))).toEqual({
      kind: "unmaintained",
      version: "1.x",
    });
    const run = (html: string, headers: Record<string, string> = {}) =>
      staticOldVersionIndexed.run(page(U, html, headers), { warn: () => undefined });
    expect((await run(dg(head, banner))).map((f) => f.evidence)).toEqual([
      "version 1.x is no longer actively maintained and is open to search engines",
    ]);
    expect(
      await run(dg(head + '<meta name="robots" content="noindex, nofollow">', banner)),
    ).toEqual([]);
    expect(await run(dg(head, banner), { "x-robots-tag": "noindex" })).toEqual([]);
    expect(
      await run(
        dg(head + '<link rel="canonical" href="https://bakery.example/docs/intro">', banner),
      ),
    ).toEqual([]);
    expect(await run(dg(head, "<p>current docs</p>"))).toEqual([]);
    // A banner word in prose is not the theme's banner.
    expect(
      versionBanner(page(U, dg(head, "<p>no longer actively maintained</p>"))),
    ).toBeUndefined();
  });

  it("a development server is a finding that names the markers only", async () => {
    const dev = page(U, hugo('<script src="/livereload.js?port=1313" defer></script>'));
    const out = await staticDevServerLive.run(dev, { warn: () => undefined });
    expect(out.map((f) => f.evidence)).toEqual(["the page loads /livereload.js"]);
    expect(await staticDevServerLive.run(page(U, hugo()), { warn: () => undefined })).toEqual([]);
  });

  it("dev markers: livereload, the Eleventy reload client, the Vite client on VitePress, an unversioned Docusaurus", () => {
    expect(devMarkers(page(U, hugo()))).toEqual([]);
    expect(
      devMarkers(
        page(U, hugo('<script src="/livereload.js?port=1313&amp;mindelay=10" defer></script>')),
      ),
    ).toEqual(["/livereload.js"]);
    expect(
      devMarkers(page(U, '<script type="module" src="/.11ty/reload-client.js"></script>')),
    ).toEqual(["/.11ty/reload-client.js"]);
    expect(
      devMarkers(
        page(
          U,
          '<script type="module" src="/@vite/client"></script><script type="module" src="/@fs/app/node_modules/vitepress/dist/client/app/index.js"></script>',
        ),
      ),
    ).toEqual(["/@vite/client"]);
    // The Vite client on a site that is not VitePress is left to other checks.
    expect(devMarkers(page(U, '<script type="module" src="/@vite/client"></script>'))).toEqual([]);
    expect(devMarkers(page(U, '<meta name="generator" content="Docusaurus">'))).toEqual([
      "a Docusaurus generator tag with no version",
    ]);
  });

  it("a placeholder or preview host in the canonical, og:url or sitemap is a finding on a production page", async () => {
    const run = (head: string, urls: string[] = [], url = U) =>
      staticPreviewCanonical.run(page(url, hugo(head)), {
        warn: () => undefined,
        site: async () => ({ sitemapUrls: urls }) as never,
      });
    expect(
      (await run('<link rel="canonical" href="https://example.org/posts/loaf/">')).map(
        (f) => f.evidence,
      ),
    ).toEqual(["canonical https://example.org/posts/loaf/ is on a placeholder or preview domain"]);
    expect((await run('<meta property="og:url" content="http://127.0.0.1:1313/">')).length).toBe(1);
    expect((await run("", ["https://bakery-git-main.netlify.app/a"])).length).toBe(1);
    expect(await run('<link rel="canonical" href="https://bakery.example/posts/loaf/">')).toEqual(
      [],
    );
    // A page that is itself on a preview host is judged by other checks.
    expect(
      await run(
        '<link rel="canonical" href="https://example.org/">',
        [],
        "https://bakery.pages.dev/",
      ),
    ).toEqual([]);
  });

  it("the search index is read from an array, a docs/pages wrapper, lunr, MiniSearch or a VitePress chunk", () => {
    const paths = (r: ReturnType<typeof readSearchIndex>) => ("paths" in r ? r.paths : r);
    expect(
      paths(
        readSearchIndex(
          '[{"permalink":"/a/"},{"url":"https://bakery.example/b"},{"uri":"/c/#x"}]',
          "https://bakery.example",
        ),
      ),
    ).toEqual(["/a", "/b", "/c"]);
    expect(
      paths(readSearchIndex('{"docs":[{"href":"/d.html"}]}', "https://bakery.example")),
    ).toEqual(["/d"]);
    expect(
      paths(readSearchIndex('{"store":{"/e/":{"title":"x"}}}', "https://bakery.example")),
    ).toEqual(["/e"]);
    const mini = JSON.stringify({
      documentCount: 2,
      documentIds: { "0": "/guide/f", "1": "/guide/f#g" },
    });
    expect(
      paths(readSearchIndex(`export default ${JSON.stringify(mini)}`, "https://bakery.example")),
    ).toEqual(["/guide/f"]);
    expect(
      paths(readSearchIndex('[{"url":"https://elsewhere.example/z"}]', "https://bakery.example")),
    ).toEqual([]);
  });

  it("paths are normalised the same way for the index and the sitemap", () => {
    const o = "https://bakery.example";
    expect(normalizePath("https://bakery.example/a/b/?q=1#top", o)).toBe("/a/b");
    expect(normalizePath("/a/index.html", o)).toBe("/a");
    expect(normalizePath("/index.html", o)).toBe("/");
    expect(normalizePath("a/b", o)).toBe("/a/b");
    expect(normalizePath("https://other.example/a", o)).toBeUndefined();
    expect(normalizePath("javascript:alert(1)", o)).toBeUndefined();
  });
});

describe("static generators: integration (the hugo-like and docusaurus-old fixtures)", () => {
  it("every check fires on the bakery fixture, and shows paths and counts only", async () => {
    const site = await startFixture("hugo-like");
    try {
      const run = async (path: string, ownerConsent = true) =>
        (
          await checkSite({
            address: `${site.origin}${path}`,
            fetcher: createFetcher({ hosts: site.hosts }),
            only: IDS,
            now: () => NOW,
            ...(ownerConsent ? { ownerConsent: true } : {}),
          })
        ).result;
      const home = await run("/");
      expect(home.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        [
          "static-preview-canonical",
          "canonical https://example.org/, og:url https://example.org/ are on a placeholder or preview domain",
        ],
        [
          "static-search-index-hidden",
          "/index.json lists 1 page the sitemap leaves out (first: /posts/wedding-cakes-draft); 1 of 1 read is noindex or marked draft",
        ],
      ]);
      expect((await run("/posts/new-year-loaf/")).findings.map((f) => f.checkId)).toContain(
        "static-future-post-live",
      );
      const draft = await run("/posts/winter-wheat-draft/");
      expect(draft.findings.find((f) => f.checkId === "static-draft-marker-live")?.evidence).toBe(
        'marked as a draft (class "draft") and search engines may index it and the sitemap lists it',
      );
      // Nothing but GET and HEAD, and no page text in any finding.
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
      expect(JSON.stringify([home, draft])).not.toMatch(/Winter wheat|Wedding cakes|invented/);
    } finally {
      await site.close();
    }
  });

  it("without consent the conventional index addresses are never asked, and the check says why", async () => {
    const site = await startFixture("hugo-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["static-search-index-hidden"],
        now: () => NOW,
      });
      expect(result.findings).toEqual([]);
      expect(site.hits.has("/index.json")).toBe(false);
      expect(JSON.stringify(result.couldNotCheck)).toMatch(/--owner-consent/);
    } finally {
      await site.close();
    }
  });

  it("an old documentation version is found from its page alone", async () => {
    const site = await startFixture("docusaurus-old");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["static-old-version-indexed"],
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "version 1.x is no longer actively maintained and is open to search engines",
      ]);
    } finally {
      await site.close();
    }
  });
});

describe("static generators: edge cases", () => {
  const hop = (
    url: string,
    status: number,
    body: string,
    headers: Record<string, string> = {},
    truncated = false,
  ): Hop => ({
    url,
    status,
    headers,
    body,
    ms: 1,
    ...(truncated ? { truncated: true } : {}),
  });
  const ctxFor = (
    answers: Record<string, Hop[]>,
    asked: string[] = [],
    extra: Partial<CheckContext> = {},
  ) => {
    const unread: string[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      budget: createBudget(),
      couldNotCheck: (_u, r) => unread.push(r),
      site: async () => ({ sitemapUrls: ["https://bakery.example/"] }) as never,
      fetcher: {
        get: async (url: string) => {
          asked.push(url);
          return answers[url] ?? [hop(url, 404, "")];
        },
        getSite: async () => [],
        stats: { requests: 0, maxInFlight: 0 },
      },
      ownerConsent: true,
      ...extra,
    };
    return { ctx, unread, asked };
  };
  const home = page("https://bakery.example/", hugo());
  const INDEX = "https://bakery.example/index.json";

  it("an index that is too big, cut short, not JSON or of an unknown shape is could not check, never clean", async () => {
    for (const answer of [
      hop(INDEX, 200, "[" + "1,".repeat(3_000_000) + "1]"),
      hop(INDEX, 200, '[{"permalink":"/a"', {}, true),
      hop(INDEX, 200, "<html>not json</html>"),
      hop(INDEX, 200, '{"hello":"world"}'),
      hop(INDEX, 200, "5"),
    ]) {
      const { ctx, unread } = ctxFor({ [INDEX]: [answer] });
      expect(await staticSearchIndexHidden.run(home, ctx)).toEqual([]);
      expect(unread.length).toBe(1);
    }
  });

  it("more than 50,000 entries is unread, not a quiet cut", () => {
    const big = JSON.stringify(Array.from({ length: 50_001 }, (_, i) => ({ url: `/p${i}` })));
    expect(readSearchIndex(big, "https://bakery.example")).toEqual({
      unread: "the search index lists more than 50,000 addresses",
    });
  });

  it("__proto__, constructor and lone surrogates in an index are plain text, never keys or crashes", () => {
    const o = "https://bakery.example";
    const hostile = '[{"__proto__":{"url":"/x"},"constructor":{"url":"/y"},"url":"/ok\\ud800"}]';
    const r = readSearchIndex(hostile, o);
    expect("paths" in r && r.paths.length).toBe(1);
    expect(({} as Record<string, unknown>).url).toBeUndefined();
    expect(readSearchIndex('{"store":{"__proto__":{"a":1},"/z":1}}', o)).toEqual({ paths: ["/z"] });
    expect(normalizePath("/\ud800a", o)).toBeTypeOf("string");
  });

  it("deeply nested JSON in an index does not overflow the stack", () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect("unread" in readSearchIndex(deep, "https://bakery.example")).toBe(true);
  });

  it("no sitemap to compare with is could not check", async () => {
    const { ctx, unread } = ctxFor({ [INDEX]: [hop(INDEX, 200, '[{"url":"/a"}]')] }, [], {
      site: async () => ({ sitemapUrls: [] }) as never,
    });
    expect(await staticSearchIndexHidden.run(home, ctx)).toEqual([]);
    expect(unread.join()).toMatch(/no sitemap/);
  });

  it("pages in the index that are plain and public are not a finding", async () => {
    const A = "https://bakery.example/a";
    const { ctx } = ctxFor({
      [INDEX]: [hop(INDEX, 200, '[{"url":"/a"}]')],
      [A]: [hop(A, 200, hugo(), { "content-type": "text/html" })],
    });
    expect(await staticSearchIndexHidden.run(home, ctx)).toEqual([]);
  });

  it("a VitePress search chunk named by the site's own module is read without consent", async () => {
    const vp = page(
      "https://docs.example/guide/",
      '<html><head><meta name="generator" content="VitePress v1.6.4"><link rel="modulepreload" href="/assets/chunks/theme.AbC123.js"></head></html>',
    );
    const chunk = "https://docs.example/assets/chunks/@localSearchIndexroot.Zz9.js";
    const mini = JSON.stringify({ documentIds: { "0": "/guide/hidden-page" } });
    const asked: string[] = [];
    const { ctx } = ctxFor(
      {
        "https://docs.example/assets/chunks/theme.AbC123.js": [
          hop("x", 200, 'import("./@localSearchIndexroot.Zz9.js")'),
        ],
        [chunk]: [hop(chunk, 200, `export default ${JSON.stringify(mini)}`)],
        "https://docs.example/guide/hidden-page": [
          hop("x", 200, '<html><head><meta name="robots" content="noindex"></head></html>', {
            "content-type": "text/html",
          }),
        ],
      },
      asked,
      {
        ownerConsent: false,
        site: async () => ({ sitemapUrls: ["https://docs.example/guide/"] }) as never,
      },
    );
    const out = await staticSearchIndexHidden.run(vp, ctx);
    expect(out).toHaveLength(1);
    expect(asked).not.toContain("https://docs.example/index.json");
  });

  it("a truncated page never makes a draft, date or version finding", async () => {
    const cut = page(
      U,
      hugo('<meta property="article:published_time" content="2031-01-04">', '<span class="draft">'),
      {},
      true,
    );
    expect(await staticFuturePostLive.run(cut, { warn: () => undefined, now: () => NOW })).toEqual(
      [],
    );
    const unread: string[] = [];
    expect(
      await staticDraftMarkerLive.run(cut, {
        warn: () => undefined,
        couldNotCheck: (_u, r) => unread.push(r),
      }),
    ).toEqual([]);
    expect(unread[0]).toMatch(/cut short/);
  });

  it("without a fetcher the probing check asks nothing", async () => {
    expect(await staticSearchIndexHidden.run(home, { warn: () => undefined })).toEqual([]);
  });
});
