import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import {
  devMarkers as qwikDev,
  isQDataAddress,
  isQwikSite,
  looksLikeQData,
  namesOfSerialized,
  privateNames,
  qDataAddress,
  qfuncCount,
  readQData,
  readState,
} from "../../qwik/detect.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import {
  devMarkers as solidDev,
  isSolidStartSite,
  literalKeys,
  readHydration,
  serverFnCount,
} from "../../solidstart/detect.js";
import { qwikSolidDataAsPage } from "../qwik-solid-data-as-page.js";
import { qwikSolidDevServerLive } from "../qwik-solid-dev-server-live.js";
import { qwikSolidDraftPublic } from "../qwik-solid-draft-public.js";
import { qwikSolidPreviewCanonical } from "../qwik-solid-preview-canonical.js";
import { qwikSolidPrivateFields } from "../qwik-solid-private-fields.js";
import { qwikSolidServerEndpoints } from "../qwik-solid-server-endpoints.js";
import { qwikSolidVaryMissing } from "../qwik-solid-vary-missing.js";

const IDS = [
  "qwik-solid-draft-public",
  "qwik-solid-preview-canonical",
  "qwik-solid-data-as-page",
  "qwik-solid-vary-missing",
  "qwik-solid-private-fields",
  "qwik-solid-dev-server-live",
  "qwik-solid-server-endpoints",
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
const state = (json: string) => `<script type="qwik/json">${json}</script>`;
const QWIK_HTML = `<html q:container="paused" q:render="ssr"><body q:route="/"><main>Hi</main>${state(
  '{"refs":{},"ctx":{},"objs":[{"title":"A"}],"subs":[]}',
)}</body></html>`;
const SOLID_HTML = `<html><head><link rel="modulepreload" href="/_build/assets/c.js"></head><body><script>window._$HY||(_$HY={events:[],completed:new WeakSet,r:{},fe(){}});</script><main data-hk="0-0">Hi</main><script>_$HY.r["m"]={title:"A"};</script></body></html>`;

describe("qwik and solidstart: unit", () => {
  it("a Qwik site is recognised from its container, its state script or its build chunks", () => {
    const u = "https://shop.example/";
    expect(isQwikSite(page(u, QWIK_HTML))).toBe(true);
    expect(isQwikSite(page(u, '<body><link href="x"></body>'))).toBe(false);
    expect(isQwikSite(page(u, state("{}")))).toBe(true);
    // The word in prose, or another script type, is not a state script.
    expect(isQwikSite(page(u, "<p>type of qwik/json</p>"))).toBe(false);
    expect(isQwikSite(page(u, '<script type="application/json">qwik/json</script>'))).toBe(false);
  });

  it("a SolidStart site needs a Start marker besides _$HY; a /_server form alone is enough", () => {
    const u = "https://shop.example/";
    expect(isSolidStartSite(page(u, SOLID_HTML))).toBe(true);
    expect(isSolidStartSite(page(u, "<script>window._$HY||1</script>"))).toBe(false);
    expect(isSolidStartSite(page(u, '<form action="/_server?id=a&name=b">'))).toBe(true);
    expect(isSolidStartSite(page(u, "<p>Plain</p>"))).toBe(false);
  });

  it("the q-data address of a route, with and without a trailing slash, query or the root", () => {
    expect(qDataAddress("https://shop.example/repairs?x=1")).toBe(
      "https://shop.example/repairs/q-data.json",
    );
    expect(qDataAddress("https://shop.example/repairs/")).toBe(
      "https://shop.example/repairs/q-data.json",
    );
    expect(qDataAddress("https://shop.example/")).toBe("https://shop.example/q-data.json");
    expect(isQDataAddress("https://shop.example/a/q-data.json")).toBe(true);
    expect(isQDataAddress("https://shop.example/a")).toBe(false);
  });

  it("the Qwik state gives names from objs, and \\x3C escapes are undone", () => {
    const s = readState(
      page(
        "https://shop.example/",
        state('{"refs":{},"ctx":{},"objs":[{"a":1,"b":"\\x3C/script>"},3,[1],{"c":2}],"subs":[]}'),
      ),
    );
    expect(s).toEqual({ names: ["a", "b", "c"] });
    expect(readQData('{"_entry":"0","_objs":[{"loaders":"1"},{"k":"x"}]}')).toEqual({
      names: ["loaders", "k"],
    });
    expect(looksLikeQData('{"_entry":"0","_objs":[]}')).toBe(true);
    expect(looksLikeQData("<html>")).toBe(false);
  });

  it("dev markers: the dev render mode, the dev manifest hash and the vite client", () => {
    expect(qwikDev(page("https://shop.example/", QWIK_HTML))).toEqual([]);
    const dev = page(
      "https://shop.example/",
      '<html q:container="paused" q:render="ssr-dev" q:manifest-hash="devx9"><script type="module" src="/@vite/client"></script></html>',
    );
    expect(qwikDev(dev)).toEqual(["q:render ssr-dev", "q:manifest-hash dev", "/@vite/client"]);
    expect(
      solidDev(page("https://a.example/", '<script src="/_build/@fs/home/x/entry.tsx"></script>')),
    ).toEqual(["/_build/@fs/"]);
  });

  it("server addresses are counted from the markup, never called", () => {
    expect(
      qfuncCount(
        page("https://a.example/", '<a href="/?qfunc=a">x</a><form action="/?qaction=b">'),
      ),
    ).toBe(2);
    expect(serverFnCount(page("https://a.example/", SOLID_HTML))).toBe(0);
    expect(
      serverFnCount(
        page("https://a.example/", '<form action="/_server?id=a&amp;name=b"></form>/_serverless'),
      ),
    ).toBe(1);
  });

  it("solid hydration names come from literals, strings skipped", () => {
    expect(readHydration(page("https://a.example/", SOLID_HTML))).toEqual({ names: ["title"] });
    expect(literalKeys('{a:"password: x, token: y","api-key":1,b:{c:2}}')).toEqual([
      "a",
      "api-key",
      "b",
      "c",
    ]);
    expect(readHydration(page("https://a.example/", "<p>none</p>"))).toBeUndefined();
  });

  it("private names are matched by their words, not by substrings", () => {
    expect(
      privateNames([
        "apiToken",
        "password_hash",
        "Secret",
        "tokenizer",
        "hashtag",
        "internalNotes",
        "title",
      ]),
    ).toEqual(["apiToken", "password_hash", "Secret", "internalNotes"]);
  });
});

describe("qwik and solidstart: integration (the qwik-like and solidstart-like fixtures)", () => {
  it("every check fires once on the bike-repair fixture, and names are all it shows", async () => {
    const site = await startFixture("qwik-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: IDS,
        ownerConsent: true,
      });
      const by = Object.fromEntries(result.findings.map((f) => [f.checkId, f.evidence]));
      expect(Object.keys(by).sort()).toEqual(
        IDS.filter((i) => i !== "qwik-solid-dev-server-live").sort(),
      );
      expect(by["qwik-solid-draft-public"]).toBe("/api/preview set preview_session with no secret");
      expect(by["qwik-solid-preview-canonical"]).toBe(
        "canonical https://spokeandchain-git-main-team.vercel.app/ is on a preview domain",
      );
      expect(by["qwik-solid-data-as-page"]).toBe("the sitemap lists 1 data address");
      expect(by["qwik-solid-private-fields"]).toBe(
        "the embedded state has apiToken; /q-data.json has apiToken (field names only)",
      );
      expect(by["qwik-solid-server-endpoints"]).toBe(
        "the page names ?qfunc= or ?qaction= 1 time (not called)",
      );
      expect(by["qwik-solid-vary-missing"]).toMatch(
        /^The address returns HTML to a browser and JSON/,
      );
      // No value of the payload reaches a finding.
      expect(JSON.stringify(result.findings)).not.toMatch(
        /invented-fixture-value|Dee has the till/,
      );
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("without consent no draft route is asked, and the check says why", async () => {
    const site = await startFixture("qwik-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["qwik-solid-draft-public"],
      });
      expect(result.findings).toEqual([]);
      expect([...site.hits.keys()].filter((k) => k.startsWith("/api/"))).toEqual([]);
      expect(JSON.stringify(result.couldNotCheck)).toMatch(/--owner-consent/);
    } finally {
      await site.close();
    }
  });

  it("the coffee-cart SolidStart fixture: private hydration data and a /_server form, nothing else", async () => {
    const site = await startFixture("solidstart-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: IDS,
      });
      const by = Object.fromEntries(result.findings.map((f) => [f.checkId, f.evidence]));
      expect(by).toEqual({
        "qwik-solid-private-fields": "the embedded state has adminPassword (field names only)",
        "qwik-solid-server-endpoints": "the page names /_server 1 time (not called)",
      });
      expect(JSON.stringify(result.findings)).not.toMatch(/invented-fixture-value/);
      // SolidStart: the only requests are GET or HEAD, and no /_server address is asked for.
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
      expect([...site.hits.keys()].filter((k) => k.startsWith("/_server"))).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("qwik and solidstart: edge cases", () => {
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
  const ALL = [
    qwikSolidDraftPublic,
    qwikSolidPreviewCanonical,
    qwikSolidDataAsPage,
    qwikSolidVaryMissing,
    qwikSolidPrivateFields,
    qwikSolidDevServerLive,
    qwikSolidServerEndpoints,
  ];

  it("on a site that is neither framework every check is silent and nothing is requested", async () => {
    const asked: string[] = [];
    const { ctx, unread } = ctxFor({}, asked, { ownerConsent: true });
    const plain = page(
      "https://shop.example/",
      '<link rel="canonical" href="https://x.vercel.app/">',
    );
    for (const c of ALL) expect(await c.run(plain, ctx), c.id).toEqual([]);
    expect(asked).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("hostile state: __proto__ and constructor keys are names, nothing is polluted, huge lists are capped", () => {
    const r = namesOfSerialized('{"objs":[{"__proto__":1,"constructor":2,"password":3}]}', false);
    expect(r).toEqual({ names: ["__proto__", "constructor", "password"] });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const big = JSON.stringify({
      objs: Array.from({ length: 50_000 }, (_, i) => ({ ["k" + i]: i })),
    });
    const capped = namesOfSerialized(big, false);
    expect("names" in capped && capped.names.length).toBeLessThanOrEqual(2000);
    expect(namesOfSerialized("{not json", false)).toMatchObject({ unread: expect.any(String) });
    expect(namesOfSerialized('{"objs":5}', false)).toMatchObject({ unread: expect.any(String) });
    expect(readQData("x".repeat(1_100_000))).toEqual({
      unread: "the q-data answer is larger than is read",
    });
    expect(readQData("{}", true)).toMatchObject({ unread: expect.any(String) });
  });

  it("a truncated page, an unclosed or another-format state is could not check, never clean", async () => {
    const { ctx, unread } = ctxFor({}, [], { fetcher: undefined });
    const cut = page(
      "https://shop.example/",
      '<html q:container="paused"><script type="qwik/json">{"objs":[{"password":',
      {},
      true,
    );
    expect(await qwikSolidPrivateFields.run(cut, ctx)).toEqual([]);
    const v2 = page("https://shop.example/", `<html q:container="paused">${state('{"a":[1]}')}`);
    expect(await qwikSolidPrivateFields.run(v2, ctx)).toEqual([]);
    expect(unread[0]).toMatch(/cut before its embedded state ended/);
    expect(unread[1]).toMatch(/another Qwik version/);
    const solidCut = page(
      "https://shop.example/",
      `${SOLID_HTML.slice(0, SOLID_HTML.indexOf("<main"))}<script>_$HY.r["m"]={adminPassword:`,
      {},
      true,
    );
    expect(readHydration(solidCut)).toEqual({
      unread: "the page was cut before its hydration data ended",
    });
  });

  it("lone surrogates, quotes and backslashes in state do not break the key scan", () => {
    expect(literalKeys('{a:"\\ud800 \\"b: c\\"",d:"\\\\",e:1}')).toEqual(["a", "d", "e"]);
    expect(literalKeys('{"x\\"y":1, "\ud800":2}')).toContain('x\\"y');
    expect(namesOfSerialized('{"objs":[{"\\ud800":1}]}', false)).toMatchObject({
      names: ["\ud800"],
    });
  });

  it("a q-data answer that is unreadable, or an address that refuses, is could not check", async () => {
    const u = "https://shop.example/";
    for (const answer of [
      hop("x", 404, {}, ""),
      hop("x", 200, {}, "<html>"),
      hop("x", 200, {}, "[1]"),
    ]) {
      const { ctx, unread } = ctxFor({ "https://shop.example/q-data.json": [answer] });
      expect(await qwikSolidPrivateFields.run(page(u, QWIK_HTML), ctx)).toEqual([]);
      expect(unread.length).toBe(1);
    }
  });

  it("Vary: Accept (or *) on either answer clears the check; JSON that is not offered is not a finding", async () => {
    const u = "https://shop.example/";
    const html = page(u, QWIK_HTML);
    const json = (vary?: string) =>
      hop(u, 200, { "content-type": "application/json", ...(vary ? { vary } : {}) }, "{}");
    for (const [answer, expected] of [
      [json(), 1],
      [json("Accept"), 0],
      [json("*"), 0],
      [hop(u, 200, { "content-type": "text/html" }, "<p>"), 0],
    ] as const) {
      const { ctx } = ctxFor({ [u]: [answer] });
      expect((await qwikSolidVaryMissing.run(html, ctx)).length).toBe(expected);
    }
    const { ctx, unread } = ctxFor({ [u]: [hop(u, 503, {}, "")] });
    expect(await qwikSolidVaryMissing.run(html, ctx)).toEqual([]);
    expect(unread.length).toBe(1);
  });

  it("a page address that is itself q-data, or a sitemap listing data and /_server files, is found", async () => {
    const data = buildSnapshot([
      hop(
        "https://shop.example/repairs",
        200,
        { "content-type": "application/json" },
        '{"_entry":"0","_objs":[]}',
      ),
    ]);
    const { ctx } = ctxFor({});
    expect((await qwikSolidDataAsPage.run(data, ctx))[0]?.evidence).toBe(
      "this address answers application/json with route data",
    );
    const listed = (
      await qwikSolidDataAsPage.run(page("https://shop.example/", QWIK_HTML), {
        ...ctx,
        site: async () => ({
          sitemapUrls: [
            "https://shop.example/a/q-data.json",
            "https://shop.example/_server?id=x",
            "https://shop.example/c",
          ],
        }),
      } as CheckContext)
    )[0];
    expect(listed?.evidence).toBe("the sitemap lists 2 data addresses");
  });

  it("the draft check asks only its four routes and ignores a cookie that is not about preview", async () => {
    const asked: string[] = [];
    const { ctx } = ctxFor(
      {
        "https://shop.example/api/draft": [
          hop("x", 200, { "set-cookie": "theme=dark; Path=/" }, ""),
        ],
      },
      asked,
      { ownerConsent: true },
    );
    expect(await qwikSolidDraftPublic.run(page("https://shop.example/", QWIK_HTML), ctx)).toEqual(
      [],
    );
    expect(asked).toEqual([
      "https://shop.example/api/preview",
      "https://shop.example/api/draft",
      "https://shop.example/preview",
      "https://shop.example/draft",
    ]);
  });

  it("a production page whose preview-looking canonical is on a preview host itself is not reported", async () => {
    const { ctx } = ctxFor({});
    const onPreviewHost = page(
      "https://shop-git-main.vercel.app/",
      `${QWIK_HTML}<link rel="canonical" href="https://shop-git-main.vercel.app/">`,
    );
    expect(await qwikSolidPreviewCanonical.run(onPreviewHost, ctx)).toEqual([]);
  });

  it("dev server: found from the page alone, with no extra request", async () => {
    const asked: string[] = [];
    const { ctx } = ctxFor({}, asked);
    const dev = page(
      "https://shop.example/",
      '<html q:container="paused" q:render="ssr-dev"></html>',
    );
    expect((await qwikSolidDevServerLive.run(dev, ctx)).length).toBe(1);
    expect(asked).toEqual([]);
  });
});
