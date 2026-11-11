import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import {
  devMarkers,
  embeddedPageData,
  isGatsbySite,
  isGraphiqlPage,
  isPageDataAddress,
  pageDataAddress,
  privateNames,
  readPageData,
} from "../../gatsby/detect.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { gatsbyDataAsPage } from "../gatsby-data-as-page.js";
import { gatsbyDataUnshown } from "../gatsby-data-unshown.js";
import { gatsbyDevServerLive } from "../gatsby-dev-server-live.js";
import { gatsbyGraphqlPublic } from "../gatsby-graphql-public.js";
import { gatsbyPreviewCanonical } from "../gatsby-preview-canonical.js";
import { gatsbyPrivateFields } from "../gatsby-private-fields.js";

const IDS = [
  "gatsby-data-as-page",
  "gatsby-data-unshown",
  "gatsby-dev-server-live",
  "gatsby-graphql-public",
  "gatsby-preview-canonical",
  "gatsby-private-fields",
];
const ALL = [
  gatsbyDataAsPage,
  gatsbyDataUnshown,
  gatsbyDevServerLive,
  gatsbyGraphqlPublic,
  gatsbyPreviewCanonical,
  gatsbyPrivateFields,
];

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
const GATSBY_HTML = (text = "Hello", path = "/") =>
  `<html><head><meta name="generator" content="Gatsby 5.14.4"></head><body><div id="___gatsby"><main>${text}</main></div><script>window.pagePath="${path}";window.___webpackCompilationHash="abc";</script></body></html>`;
const pd = (data: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    componentChunkName: "component---src-pages-index-js",
    path: "/",
    result: { data, pageContext: {} },
    staticQueryHashes: [],
    ...extra,
  });

describe("gatsby: unit", () => {
  it("a Gatsby site is recognised from its generator, its root element or its inline globals", () => {
    const u = "https://shop.example/";
    expect(isGatsbySite(page(u, GATSBY_HTML()))).toBe(true);
    expect(isGatsbySite(page(u, '<div id="___gatsby"></div>'))).toBe(true);
    expect(isGatsbySite(page(u, "<script>window.___webpackCompilationHash='x'</script>"))).toBe(
      true,
    );
    expect(isGatsbySite(page(u, '<meta name="generator" content="Gatsby 4.0.1">'))).toBe(true);
    expect(isGatsbySite(page(u, '<meta name="generator" content="WordPress 6">'))).toBe(false);
    expect(isGatsbySite(page(u, "<p>Gatsby ___gatsby in prose</p>"))).toBe(false);
  });

  it("the page-data address: index for the home page, a path prefix from window.pagePath, no query", () => {
    expect(pageDataAddress(page("https://shop.example/", GATSBY_HTML()))).toBe(
      "https://shop.example/page-data/index/page-data.json",
    );
    expect(
      pageDataAddress(page("https://shop.example/bouquets/?a=1", GATSBY_HTML("x", "/bouquets/"))),
    ).toBe("https://shop.example/page-data/bouquets/page-data.json");
    expect(
      pageDataAddress(page("https://shop.example/blog/about/", GATSBY_HTML("x", "/about/"))),
    ).toBe("https://shop.example/blog/page-data/about/page-data.json");
    expect(pageDataAddress(page("https://shop.example/blog/", GATSBY_HTML("x", "/")))).toBe(
      "https://shop.example/blog/page-data/index/page-data.json",
    );
    // No pagePath: the address is the page's own path.
    expect(pageDataAddress(page("https://shop.example/a/b", '<div id="___gatsby"></div>'))).toBe(
      "https://shop.example/page-data/a/b/page-data.json",
    );
  });

  it("page-data addresses: pages, app-data and static queries, nothing else", () => {
    for (const ok of [
      "https://a.example/page-data/index/page-data.json",
      "https://a.example/page-data/a/b/page-data.json",
      "https://a.example/page-data/app-data.json",
      "https://a.example/page-data/sq/d/2201.json",
      "https://a.example/blog/page-data/x/page-data.json",
    ])
      expect(isPageDataAddress(ok), ok).toBe(true);
    for (const no of [
      "https://a.example/",
      "https://a.example/page-data/",
      "https://a.example/data/page-data.json",
      "not a url",
    ])
      expect(isPageDataAddress(no), no).toBe(false);
  });

  it("page data gives field paths and kinds, static query hashes, and nothing from a wrong shape", () => {
    const r = readPageData(
      pd(
        { site: { title: "A" }, list: [{ n: 1 }, { n: 2 }], flag: true, none: null },
        {
          staticQueryHashes: ["12", "../x", "ab"],
        },
      ),
    );
    expect("fields" in r && r.fields).toEqual([
      { path: "data.site.title", kind: "string", value: "A" },
      { path: "data.list[].n", kind: "number", value: 1 },
      { path: "data.list[].n", kind: "number", value: 2 },
      { path: "data.flag", kind: "boolean", value: true },
      { path: "data.none", kind: "null" },
    ]);
    expect("hashes" in r && r.hashes).toEqual(["12", "ab"]);
    for (const wrong of ["<html>", "[]", "{}", '{"result":5}', "null"])
      expect(readPageData(wrong), wrong).toMatchObject({ unread: expect.any(String) });
  });

  it("private names are matched by their words, not by substrings", () => {
    expect(
      privateNames([
        "apiToken",
        "password_hash",
        "contactApiKey",
        "Secret",
        "tokenizer",
        "hashtag",
        "internalNotes",
        "title",
        "keyboard",
      ]),
    ).toEqual(["apiToken", "password_hash", "contactApiKey", "Secret", "internalNotes"]);
  });

  it("dev markers are the files the development server writes, by name", () => {
    const u = "https://shop.example/";
    expect(devMarkers(page(u, GATSBY_HTML()))).toEqual([]);
    const prod = page(u, '<div id="___gatsby"></div><script src="/framework-9d8e7f.js"></script>');
    expect(devMarkers(prod)).toEqual([]);
    const dev = page(
      u,
      '<div id="___gatsby"></div><script src="/socket.io/socket.io.js"></script><script src="/framework.js"></script><script src="/commons.js"></script>',
    );
    expect(devMarkers(dev)).toEqual(["/socket.io/socket.io.js", "/commons.js", "/framework.js"]);
  });

  it("the GraphiQL page is recognised by its title, not by any 200", () => {
    expect(isGraphiqlPage("<!doctype html><title>Gatsby - GraphiQL</title>")).toBe(true);
    expect(isGraphiqlPage("<title>Page not found</title>")).toBe(false);
    expect(isGraphiqlPage("")).toBe(false);
  });

  it("the page's inline pageData is read as JSON, and a cut one is unread", () => {
    const body = `<script>window.pagePath="/";window.pageData=${pd({ a: { password: "x" } })};</script>`;
    const r = embeddedPageData(page("https://shop.example/", body));
    expect(r && "fields" in r && r.fields.map((f) => f.path)).toEqual(["data.a.password"]);
    expect(embeddedPageData(page("https://shop.example/", "<p>none</p>"))).toBeUndefined();
    const cut = embeddedPageData(
      page("https://shop.example/", `<script>window.pageData={"result":{"data":{"a":"b`, {}, true),
    );
    expect(cut).toMatchObject({ unread: expect.stringMatching(/cut/) });
  });
});

describe("gatsby: integration (the gatsby-like and gatsby-dev fixtures)", () => {
  it("every check fires once on the florist fixture, and names are all it shows", async () => {
    const site = await startFixture("gatsby-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: IDS,
        ownerConsent: true,
      });
      const by = Object.fromEntries(result.findings.map((f) => [f.checkId, f.evidence]));
      expect(Object.keys(by).sort()).toEqual(
        IDS.filter((i) => i !== "gatsby-dev-server-live").sort(),
      );
      expect(by["gatsby-graphql-public"]).toBe(
        "/___graphql answers the GraphiQL page (Gatsby - GraphiQL)",
      );
      expect(by["gatsby-preview-canonical"]).toBe(
        "canonical https://marigold-fern.netlify.app/ is on a preview domain",
      );
      expect(by["gatsby-data-as-page"]).toBe("the sitemap lists 1 page-data address");
      expect(by["gatsby-private-fields"]).toBe(
        "/page-data/index/page-data.json has internalNotes; /page-data/sq/d/2201.json has contactApiKey (field names only)",
      );
      expect(by["gatsby-data-unshown"]).toBe(
        "/page-data/index/page-data.json has 1 text field not on the page: data.allFlower.nodes[].staffNote (field names only)",
      );
      expect(JSON.stringify(result.findings)).not.toMatch(
        /invented-fixture-value|Ask Hana|pays the grower/,
      );
      expect(result.failed).toEqual([]);
      // Only GET and HEAD ever left the machine.
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("without consent the GraphQL address is never asked, and the check says why", async () => {
    const site = await startFixture("gatsby-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["gatsby-graphql-public"],
      });
      expect(result.findings).toEqual([]);
      expect(site.hits.has("/___graphql")).toBe(false);
      expect(JSON.stringify(result.couldNotCheck)).toMatch(/--owner-consent/);
    } finally {
      await site.close();
    }
  });

  it("a development server is found from the page alone", async () => {
    const site = await startFixture("gatsby-dev");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["gatsby-dev-server-live"],
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "the page carries /socket.io/socket.io.js, /commons.js, /framework.js",
      ]);
    } finally {
      await site.close();
    }
  });
});

describe("gatsby: edge cases", () => {
  const hop = (
    url: string,
    status: number,
    headers: Record<string, string>,
    body: string,
  ): Hop => ({
    url,
    status,
    headers,
    body,
    ms: 1,
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
      fetcher: {
        get: async (url: string) => {
          asked.push(url);
          return answers[url] ?? [hop(url, 404, {}, "")];
        },
        getSite: async () => [],
        stats: { requests: 0, maxInFlight: 0 },
      },
      ...extra,
    };
    return { ctx, unread };
  };
  const PD = "https://shop.example/page-data/index/page-data.json";
  const json = (body: string, status = 200) => [
    hop(PD, status, { "content-type": "application/json" }, body),
  ];

  it("on a site that isn't Gatsby every check is silent and nothing is requested", async () => {
    const asked: string[] = [];
    const { ctx, unread } = ctxFor({}, asked, { ownerConsent: true });
    const plain = page(
      "https://shop.example/",
      '<link rel="canonical" href="https://x.netlify.app/">',
    );
    for (const c of ALL) expect(await c.run(plain, ctx), c.id).toEqual([]);
    expect(asked).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("a hostile payload (__proto__ keys, deep nesting, huge, not JSON) is read without a hang or a polluted object", () => {
    const hostile = readPageData(
      '{"result":{"data":{"__proto__":{"polluted":"yes please"},"constructor":{"prototype":"x"}}},"staticQueryHashes":[]}',
    );
    expect("fields" in hostile && hostile.fields.map((f) => f.path)).toEqual([
      "data.__proto__.polluted",
      "data.constructor.prototype",
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    let deep = '"leaf"';
    for (let i = 0; i < 3000; i += 1) deep = `{"n":${deep}}`;
    expect("fields" in readPageData(`{"result":{"data":${deep}},"staticQueryHashes":[]}`)).toBe(
      true,
    );
    const wide = JSON.stringify({
      result: { data: { l: Array.from({ length: 50_000 }, (_, i) => ({ k: `v${i}` })) } },
    });
    const r = readPageData(wide);
    expect("fields" in r && r.fields.length).toBeLessThanOrEqual(2000);
    expect(readPageData("x".repeat(1_100_000))).toEqual({
      unread: "the data answer is larger than is read",
    });
    expect(readPageData("{not json")).toMatchObject({ unread: expect.any(String) });
    expect(readPageData(pd({}), true)).toMatchObject({ unread: expect.any(String) });
  });

  it("lone surrogates and long strings in a value neither break the read nor reach a finding", async () => {
    const p = page("https://shop.example/", GATSBY_HTML("Hello there"));
    const { ctx } = ctxFor({
      [PD]: json(
        pd({
          note: `bad ${String.fromCharCode(0xd800)} value that is long enough`,
          ok: "Hello there",
        }),
      ),
    });
    const out = await gatsbyDataUnshown.run(p, ctx);
    expect(out.map((f) => f.evidence)).toEqual([
      "/page-data/index/page-data.json has 1 text field not on the page: data.note (field names only)",
    ]);
    expect(JSON.stringify(out)).not.toMatch(/bad|long enough/);
  });

  it("a page-data answer that is missing, refused, an HTML fallback or cut is could not check, never clean", async () => {
    const p = page("https://shop.example/", GATSBY_HTML());
    for (const answer of [
      json("", 404),
      json("denied", 403),
      json("<!doctype html><title>Home</title>"),
      [hop(PD, 200, {}, pd({ a: "x" })) as Hop & { truncated?: boolean }].map((h) => ({
        ...h,
        truncated: true,
      })),
    ]) {
      for (const c of [gatsbyDataUnshown, gatsbyPrivateFields]) {
        const { ctx, unread } = ctxFor({ [PD]: answer });
        expect(await c.run(p, ctx), c.id).toEqual([]);
        expect(unread.length, c.id).toBe(1);
      }
    }
  });

  it("the page's data is asked for once however many checks read it, and its static queries once each", async () => {
    const asked: string[] = [];
    const p = page("https://shop.example/", GATSBY_HTML("Hello"));
    const { ctx } = ctxFor(
      {
        [PD]: json(pd({ a: 1 }, { staticQueryHashes: ["7", "8", "../etc"] })),
        "https://shop.example/page-data/sq/d/7.json": [
          hop("x", 200, { "content-type": "application/json" }, '{"data":{"apiToken":"t"}}'),
        ],
      },
      asked,
    );
    await gatsbyPrivateFields.run(p, ctx);
    await gatsbyDataUnshown.run(p, ctx);
    expect(asked).toEqual([
      PD,
      "https://shop.example/page-data/sq/d/7.json",
      "https://shop.example/page-data/sq/d/8.json",
    ]);
  });

  it("private names in the inline pageData are found without any request", async () => {
    const asked: string[] = [];
    const body = `<div id="___gatsby"></div><script>window.pagePath="/";window.pageData=${pd({ staff: { passwordHash: "x" } })};</script>`;
    const { ctx } = ctxFor({}, asked, { fetcher: undefined });
    const out = await gatsbyPrivateFields.run(page("https://shop.example/", body), ctx);
    expect(out.map((f) => f.evidence)).toEqual([
      "the embedded page data has passwordHash (field names only)",
    ]);
    expect(asked).toEqual([]);
  });

  it("a page address that is itself page data, or a sitemap listing data files, is found", async () => {
    const data = buildSnapshot([
      hop(
        "https://shop.example/bouquets",
        200,
        { "content-type": "application/json" },
        pd({ a: 1 }),
      ),
    ]);
    const { ctx } = ctxFor({});
    expect((await gatsbyDataAsPage.run(data, ctx))[0]?.evidence).toBe(
      "this address answers application/json with page data",
    );
    const listed = (
      await gatsbyDataAsPage.run(page("https://shop.example/", GATSBY_HTML()), {
        ...ctx,
        site: async () => ({
          sitemapUrls: [
            "https://shop.example/page-data/a/page-data.json",
            "https://shop.example/page-data/sq/d/1.json",
            "https://shop.example/c",
          ],
        }),
      } as CheckContext)
    )[0];
    expect(listed?.evidence).toBe("the sitemap lists 2 page-data addresses");
  });

  it("the GraphQL address is asked once per run, with GET only, and only a GraphiQL page counts", async () => {
    const asked: string[] = [];
    const url = "https://shop.example/___graphql";
    const { ctx } = ctxFor(
      {
        [url]: [hop(url, 200, { "content-type": "text/html" }, "<title>Gatsby - GraphiQL</title>")],
      },
      asked,
      { ownerConsent: true },
    );
    const p = page("https://shop.example/", GATSBY_HTML());
    expect((await gatsbyGraphqlPublic.run(p, ctx)).length).toBe(1);
    expect(
      await gatsbyGraphqlPublic.run(page("https://shop.example/b", GATSBY_HTML()), ctx),
    ).toEqual([]);
    expect(asked).toEqual([url]);
    for (const answer of [
      hop(url, 200, { "content-type": "text/html" }, "<title>Shop</title>"),
      hop(url, 404, {}, ""),
      hop(url, 401, {}, "<title>Gatsby - GraphiQL</title>"),
      hop(url, 200, { "content-type": "application/json" }, "<title>Gatsby - GraphiQL</title>"),
    ]) {
      const { ctx: c2 } = ctxFor({ [url]: [answer] }, [], { ownerConsent: true });
      expect(await gatsbyGraphqlPublic.run(p, c2)).toEqual([]);
    }
  });

  it("a preview domain is a finding on a production page only, and a sitemap entry counts", async () => {
    const html = `<link rel="canonical" href="https://shop-git-main.vercel.app/">${GATSBY_HTML()}`;
    const { ctx } = ctxFor({});
    expect(
      (await gatsbyPreviewCanonical.run(page("https://shop.example/", html), ctx)).length,
    ).toBe(1);
    expect(
      await gatsbyPreviewCanonical.run(page("https://shop-git-main.vercel.app/", html), ctx),
    ).toEqual([]);
    const viaSitemap = await gatsbyPreviewCanonical.run(
      page("https://shop.example/", GATSBY_HTML()),
      {
        ...ctx,
        site: async () => ({
          sitemapUrls: ["https://shop.gatsbyjs.io/a", "https://shop.example/b"],
        }),
      } as CheckContext,
    );
    expect(viaSitemap[0]?.evidence).toBe(
      "the sitemap lists https://shop.gatsbyjs.io/a is on a preview domain",
    );
  });
});
