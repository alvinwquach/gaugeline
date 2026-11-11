import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import {
  appPrefix,
  dataAddress,
  devMarkers,
  isSveltekitSite,
  literalKeys,
  privateNames,
  readBootstrap,
  readDataJson,
} from "../../sveltekit/detect.js";
import { sveltekitDataAsPage } from "../sveltekit-data-as-page.js";
import { sveltekitDataUnshown } from "../sveltekit-data-unshown.js";
import { sveltekitDevServerLive } from "../sveltekit-dev-server-live.js";
import { sveltekitDraftPublic } from "../sveltekit-draft-public.js";
import { sveltekitPreviewCanonical } from "../sveltekit-preview-canonical.js";
import { sveltekitPrivateFields } from "../sveltekit-private-fields.js";
import { sveltekitStalePage } from "../sveltekit-stale-page.js";
import { sveltekitVaryMissing } from "../sveltekit-vary-missing.js";

const IDS = [
  "sveltekit-draft-public",
  "sveltekit-preview-canonical",
  "sveltekit-data-as-page",
  "sveltekit-vary-missing",
  "sveltekit-private-fields",
  "sveltekit-data-unshown",
  "sveltekit-dev-server-live",
  "sveltekit-stale-page",
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
const boot = (state: string, version = "v1", global = "__sveltekit_abc") =>
  `<script>{ ${global} = { base: "", version: "${version}" }; kit.start(app, element, { node_ids: [0], data: ${state}, form: null }); }</script>`;
const SK_HTML = `<html><head><link rel="modulepreload" href="/_app/immutable/entry/start.1.js"></head><body><main>Hi</main>${boot("[null]")}</body></html>`;

describe("sveltekit: unit", () => {
  it("a SvelteKit site is recognised from its header, its bootstrap script or its attributes", () => {
    const u = "https://gym.example/";
    expect(isSveltekitSite(page(u, "<p>x</p>", { "x-sveltekit-page": "true" }))).toBe(true);
    expect(isSveltekitSite(page(u, SK_HTML))).toBe(true);
    expect(isSveltekitSite(page(u, '<body data-sveltekit-preload-data="hover"></body>'))).toBe(
      true,
    );
    expect(isSveltekitSite(page(u, "<html><body>Plain</body></html>"))).toBe(false);
    // The word in prose or an equality test is not a bootstrap assignment.
    expect(isSveltekitSite(page(u, "<p>__sveltekit_abc == 1</p>"))).toBe(false);
  });

  it("the data address of a page, with and without a trailing slash or .html", () => {
    expect(dataAddress("https://gym.example/classes?week=2")).toBe(
      "https://gym.example/classes/__data.json",
    );
    expect(dataAddress("https://gym.example/classes/")).toBe(
      "https://gym.example/classes/__data.json",
    );
    expect(dataAddress("https://gym.example/")).toBe("https://gym.example/__data.json");
    expect(dataAddress("https://gym.example/old/page.html")).toBe(
      "https://gym.example/old/page.html__data.json",
    );
  });

  it("the bootstrap gives the global, the build version and the state literal", () => {
    const b = readBootstrap(page("https://gym.example/", SK_HTML));
    expect(b).toMatchObject({
      global: "__sveltekit_abc",
      dev: false,
      version: "v1",
      state: "[null]",
    });
    expect(
      readBootstrap(page("https://gym.example/", boot("[null]", "d", "__sveltekit_dev")))?.dev,
    ).toBe(true);
  });

  it("the app folder comes from the page's own modules, a custom one included", () => {
    expect(appPrefix(page("https://gym.example/a/b", SK_HTML))).toBe("https://gym.example/_app");
    const custom = page(
      "https://gym.example/",
      '<link rel="modulepreload" href="/base/assets/immutable/entry/start.js">',
    );
    expect(appPrefix(custom)).toBe("https://gym.example/base/assets");
    expect(appPrefix(page("https://gym.example/", "<p>none</p>"))).toBeUndefined();
  });

  it("dev markers: the dev global and the vite client", () => {
    expect(devMarkers(page("https://gym.example/", SK_HTML))).toEqual([]);
    const dev = page(
      "https://gym.example/",
      `<script type="module" src="/@vite/client"></script>${boot("[null]", "d", "__sveltekit_dev")}`,
    );
    expect(devMarkers(dev)).toEqual(["__sveltekit_dev", "/@vite/client"]);
  });

  it("names in a literal: keys only, strings skipped", () => {
    expect(
      literalKeys(
        '[{type:"data",data:{gymName:"A",note:"password: x, token: y","api-key":1},uses:{}},null]',
      ),
    ).toEqual(["type", "data", "gymName", "note", "api-key", "uses"]);
  });

  it("private names are matched by their words, not by substrings", () => {
    expect(
      privateNames([
        "apiToken",
        "password_hash",
        "api_key",
        "Secret",
        "tokenizer",
        "hashtag",
        "internalNotes",
        "title",
      ]),
    ).toEqual(["apiToken", "password_hash", "api_key", "Secret", "internalNotes"]);
  });

  it("a data payload gives field names and kinds, never the values in a finding", () => {
    const text = JSON.stringify({
      type: "data",
      nodes: [null, { type: "data", data: [{ a: 1, b: 2, c: 3 }, "x", [4], "y", 7], uses: {} }],
    });
    const r = readDataJson(text, "application/json");
    expect(r).toEqual({
      nodes: [
        [],
        [
          { path: "a", kind: "string", value: "x" },
          { path: "b[]", kind: "number", value: 7 },
          { path: "c", kind: "string", value: "y" },
        ],
      ],
    });
  });
});

describe("sveltekit: integration (the sveltekit-like and sveltekit-dev fixtures)", () => {
  it("every check fires once on the climbing-gym fixture, and names are all it shows", async () => {
    const site = await startFixture("sveltekit-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: IDS,
        ownerConsent: true,
      });
      const by = Object.fromEntries(result.findings.map((f) => [f.checkId, f.evidence]));
      expect(Object.keys(by).sort()).toEqual(
        IDS.filter((i) => i !== "sveltekit-dev-server-live").sort(),
      );
      expect(by["sveltekit-draft-public"]).toBe("/api/preview set preview_session with no secret");
      expect(by["sveltekit-preview-canonical"]).toBe(
        "canonical https://cragnorth-git-main-team.vercel.app/ is on a preview domain",
      );
      expect(by["sveltekit-data-as-page"]).toBe("the sitemap lists 1 data address");
      expect(by["sveltekit-private-fields"]).toBe(
        "the embedded state has apiToken; /__data.json has apiToken (field names only)",
      );
      expect(by["sveltekit-data-unshown"]).toBe(
        "/__data.json has 1 text field not on the page: coachNotes (field names only)",
      );
      expect(by["sveltekit-stale-page"]).toBe(
        "the page was built as version 1731000000000 and /_app/version.json says 1731099999999",
      );
      expect(by["sveltekit-vary-missing"]).toMatch(
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

  it("without consent the draft route is never asked, and the check says why", async () => {
    const site = await startFixture("sveltekit-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["sveltekit-draft-public"],
      });
      expect(result.findings).toEqual([]);
      expect([...site.hits.keys()].filter((k) => k.startsWith("/api/"))).toEqual([]);
      expect(JSON.stringify(result.couldNotCheck)).toMatch(/--owner-consent/);
    } finally {
      await site.close();
    }
  });

  it("a development server is found from the page alone", async () => {
    const site = await startFixture("sveltekit-dev");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["sveltekit-dev-server-live"],
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "the page carries __sveltekit_dev, /@vite/client, /.svelte-kit/",
      ]);
    } finally {
      await site.close();
    }
  });
});

describe("sveltekit: edge cases", () => {
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

  it("on a site that isn't SvelteKit every check is silent and nothing is requested", async () => {
    const asked: string[] = [];
    const { ctx, unread } = ctxFor({}, asked, { ownerConsent: true });
    const plain = page(
      "https://gym.example/",
      '<link rel="canonical" href="https://x.vercel.app/">',
    );
    for (const c of [
      sveltekitDraftPublic,
      sveltekitPreviewCanonical,
      sveltekitDataAsPage,
      sveltekitVaryMissing,
      sveltekitPrivateFields,
      sveltekitDataUnshown,
      sveltekitDevServerLive,
      sveltekitStalePage,
    ])
      expect(await c.run(plain, ctx), c.id).toEqual([]);
    expect(asked).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("a hostile payload (cycle, __proto__ keys, deep nesting, huge) is read without a hang or a polluted object", () => {
    const cyc =
      '{"type":"data","nodes":[{"type":"data","data":[{"self":0,"__proto__":1,"constructor":2},"a","b"]}]}';
    const r = readDataJson(cyc, "application/json");
    expect("nodes" in r && r.nodes[0]?.map((f) => f.path)).toEqual([
      "self",
      "__proto__",
      "constructor",
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const deep = Array.from({ length: 5000 }, (_, i) => ({ n: i + 1 }));
    expect(
      "nodes" in
        readDataJson(
          JSON.stringify({ type: "data", nodes: [{ type: "data", data: deep }] }),
          "application/json",
        ),
    ).toBe(true);
    expect(readDataJson("x".repeat(1_100_000), "application/json")).toEqual({
      unread: "the data answer is larger than is read",
    });
    expect(readDataJson("{not json", "application/json")).toMatchObject({
      unread: expect.any(String),
    });
    expect(readDataJson('{"type":"data","nodes":5}', "application/json")).toMatchObject({
      unread: expect.any(String),
    });
  });

  it("a streamed answer is read from its first line only", () => {
    const first = JSON.stringify({
      type: "data",
      nodes: [{ type: "data", data: [{ a: 1 }, "x"] }],
    });
    const r = readDataJson(`${first}\n{"type":"chunk","id":1,"data":[1]}\n`, "text/sveltekit-data");
    expect(r).toEqual({ nodes: [[{ path: "a", kind: "string", value: "x" }]] });
  });

  it("a truncated page is unread, not clean: the state is reported as could not check", async () => {
    const cut = `<html><script>{ __sveltekit_abc = { version: "v" }; start(app, el, { node_ids: [0], data: [{type:"data",data:{password:"x"`;
    const { ctx, unread } = ctxFor({}, [], { fetcher: undefined });
    const p = page("https://gym.example/", cut, {}, true);
    expect(readBootstrap(p)?.stateUnread).toBeDefined();
    expect(await sveltekitPrivateFields.run(p, ctx)).toEqual([]);
    expect(unread.join()).toMatch(/cut before its embedded state ended/);
  });

  it("lone surrogates, quotes and backslashes in the state do not break the key scan", () => {
    expect(literalKeys('[{a:"\\ud800 \\"b: c\\"",d:"\\\\",e:1}]')).toEqual(["a", "d", "e"]);
    expect(literalKeys('[{"x\\"y":1, "\ud800":2}]')).toContain('x\\"y');
  });

  it("a page whose version file is missing, another host's, or not JSON is could not check, never clean", async () => {
    const u = "https://gym.example/";
    const p = page(
      u,
      boot("[null]", "v1").replace("</head>", "") + '<link href="/_app/immutable/entry/s.js">',
    );
    for (const answer of [
      hop("x", 404, {}, ""),
      hop("x", 200, {}, "<html>"),
      hop("x", 200, {}, '{"version":5}'),
    ]) {
      const { ctx, unread } = ctxFor({ "https://gym.example/_app/version.json": [answer] });
      expect(await sveltekitStalePage.run(p, ctx)).toEqual([]);
      expect(unread.length).toBe(1);
    }
    const cdn = page(
      u,
      `${boot("[null]")}<link href="https://cdn.example/_app/immutable/entry/s.js">`,
    );
    const { ctx, unread } = ctxFor({});
    expect(await sveltekitStalePage.run(cdn, ctx)).toEqual([]);
    expect(unread[0]).toMatch(/another host/);
  });

  it("a page and its version file that agree are not reported; a dev page is not asked about its version", async () => {
    const { ctx } = ctxFor({
      "https://gym.example/_app/version.json": [hop("x", 200, {}, '{"version":"v1"}')],
    });
    expect(await sveltekitStalePage.run(page("https://gym.example/", SK_HTML), ctx)).toEqual([]);
  });

  it("Vary: Accept (or *) on either answer clears the check; JSON that is not offered is not a finding", async () => {
    const u = "https://gym.example/";
    const html = page(u, SK_HTML);
    const json = (vary?: string) =>
      hop(u, 200, { "content-type": "application/json", ...(vary ? { vary } : {}) }, "{}");
    for (const [answer, expected] of [
      [json(), 1],
      [json("Accept"), 0],
      [json("*"), 0],
      [hop(u, 200, { "content-type": "text/html" }, "<p>"), 0],
    ] as const) {
      const { ctx } = ctxFor({ [u]: [answer] });
      expect((await sveltekitVaryMissing.run(html, ctx)).length).toBe(expected);
    }
    const { ctx, unread } = ctxFor({ [u]: [hop(u, 503, {}, "")] });
    expect(await sveltekitVaryMissing.run(html, ctx)).toEqual([]);
    expect(unread.length).toBe(1);
  });

  it("a page address that is itself route data, or a sitemap listing data files, is found", async () => {
    const data = buildSnapshot([
      hop(
        "https://gym.example/classes",
        200,
        { "content-type": "text/sveltekit-data" },
        '{"type":"data","nodes":[]}\n',
      ),
    ]);
    const { ctx } = ctxFor({});
    expect((await sveltekitDataAsPage.run(data, ctx))[0]?.evidence).toBe(
      "this address answers text/sveltekit-data with route data",
    );
    const listed = (
      await sveltekitDataAsPage.run(page("https://gym.example/", SK_HTML), {
        ...ctx,
        site: async () => ({
          sitemapUrls: [
            "https://gym.example/a/__data.json",
            "https://gym.example/b.html__data.json",
            "https://gym.example/c",
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
        "https://gym.example/api/draft": [
          hop("x", 200, { "set-cookie": "theme=dark; Path=/" }, ""),
        ],
      },
      asked,
      { ownerConsent: true },
    );
    expect(await sveltekitDraftPublic.run(page("https://gym.example/", SK_HTML), ctx)).toEqual([]);
    expect(asked).toEqual([
      "https://gym.example/api/preview",
      "https://gym.example/api/draft",
      "https://gym.example/preview",
      "https://gym.example/draft",
    ]);
  });
});
