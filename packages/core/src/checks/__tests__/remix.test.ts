import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import {
  devMarkers,
  isDataAddress,
  isRemixSite,
  privateNames,
  readEmbedded,
  turboNames,
} from "../../remix/detect.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { remixDataAsPage } from "../remix-data-as-page.js";
import { remixDevToolsLive } from "../remix-dev-tools-live.js";
import { remixDraftPublic } from "../remix-draft-public.js";
import { remixPreviewCanonical } from "../remix-preview-canonical.js";
import { remixPrivateFields } from "../remix-private-fields.js";

const IDS = [
  "remix-draft-public",
  "remix-preview-canonical",
  "remix-data-as-page",
  "remix-private-fields",
  "remix-dev-tools-live",
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

/** A small turbo-stream writer: the flat array react-router writes (objects are {"_<keyIndex>": valueIndex}). */
function turbo(input: unknown): string {
  const out: unknown[] = [];
  const strings = new Map<string, number>();
  const idx = (v: unknown): number => {
    if (v === null) return -5;
    if (typeof v === "string" && strings.has(v)) return strings.get(v) as number;
    const i = out.length;
    out.push(null);
    if (typeof v === "string") strings.set(v, i);
    if (Array.isArray(v)) out[i] = v.map(idx);
    else if (typeof v === "object") {
      const o: Record<string, number> = {};
      for (const [k, c] of Object.entries(v as object)) o[`_${idx(k)}`] = idx(c);
      out[i] = o;
    } else out[i] = v;
    return i;
  };
  idx(input);
  return JSON.stringify(out);
}
const rr7 = (state: unknown, extra = "") =>
  `<script>window.__reactRouterContext = {"basename":"/","ssr":true,"isSpaMode":false};window.__reactRouterContext.stream = new ReadableStream({});</script><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(`${turbo(state)}\n`)});</script>${extra}`;
const REMIX2 = (loaderData: unknown) =>
  `<script>window.__remixContext = ${JSON.stringify({ url: "/", state: { loaderData, actionData: null, errors: null }, future: {}, isSpaMode: false })};</script>`;
const URL0 = "https://studio.example/";
const RR_HTML = `<html><body><main>Hi</main>${rr7({ loaderData: { root: { data: { shopName: "x", apiToken: "y" } } } })}</body></html>`;

describe("remix: unit", () => {
  it("a site is recognised from its header or the context it embeds, not from prose", () => {
    expect(isRemixSite(page(URL0, "<p>x</p>", { "x-remix-response": "yes" }))).toBe(true);
    expect(isRemixSite(page(URL0, RR_HTML))).toBe(true);
    expect(isRemixSite(page(URL0, REMIX2({})))).toBe(true);
    expect(
      isRemixSite(
        page(URL0, '<script>window.__staticRouterHydrationData = JSON.parse("{}");</script>'),
      ),
    ).toBe(true);
    expect(isRemixSite(page(URL0, "<html><body>Plain</body></html>"))).toBe(false);
    // A word in prose, an equality test or a longer name is not an assignment.
    expect(isRemixSite(page(URL0, "<p>__remixContext == 2 and x__remixContext = 3</p>"))).toBe(
      false,
    );
  });

  it("the Remix v2 context gives field names from its JSON state", () => {
    const e = readEmbedded(page(URL0, REMIX2({ root: { shopName: "A", ownerPassword: "B" } })));
    expect(e?.marker).toBe("__remixContext");
    expect(e?.names).toEqual(
      expect.arrayContaining(["loaderData", "root", "shopName", "ownerPassword"]),
    );
    expect(e?.unread).toBeUndefined();
  });

  it("the React Router 7 stream gives names from its first chunk; later chunks mark deferred", () => {
    const e = readEmbedded(page(URL0, RR_HTML));
    expect(e?.marker).toBe("__reactRouterContext");
    expect(e?.names).toEqual(
      expect.arrayContaining(["loaderData", "root", "data", "shopName", "apiToken"]),
    );
    expect(e?.deferred).toBe(false);
    const more = RR_HTML.replace(
      "</body>",
      `<script>window.__reactRouterContext.streamController.enqueue("P5:[1]\\n");</script></body>`,
    );
    expect(readEmbedded(page(URL0, more))?.deferred).toBe(true);
  });

  it("static router hydration data is a string of JSON inside JSON.parse", () => {
    const json = JSON.stringify(JSON.stringify({ loaderData: { "0": { clientSecret: "z" } } }));
    const e = readEmbedded(
      page(URL0, `<script>window.__staticRouterHydrationData = JSON.parse(${json});</script>`),
    );
    expect(e?.names).toEqual(expect.arrayContaining(["loaderData", "clientSecret"]));
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

  it("data addresses end in .data or carry a _data query", () => {
    expect(isDataAddress("https://studio.example/shop.data")).toBe(true);
    expect(isDataAddress("https://studio.example/_root.data")).toBe(true);
    expect(isDataAddress("https://studio.example/shop?_data=routes%2Fshop")).toBe(true);
    expect(isDataAddress("https://studio.example/shop")).toBe(false);
    expect(isDataAddress("not a url")).toBe(false);
  });

  it("dev markers: the vite client, the refresh runtime and the hmr module", () => {
    expect(devMarkers(page(URL0, RR_HTML))).toEqual([]);
    const dev = page(
      URL0,
      '<script type="module" src="/@vite/client"></script><script type="module">import "/@id/__x00__virtual:remix/inject-hmr-runtime"</script>',
    );
    expect(devMarkers(dev)).toEqual(["/@vite/client", "inject-hmr-runtime"]);
  });
});

describe("remix: integration (the remix-like and remix-dev fixtures)", () => {
  it("every check fires once on the ceramics fixture, and names are all it shows", async () => {
    const site = await startFixture("remix-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: IDS,
        ownerConsent: true,
      });
      const by = Object.fromEntries(result.findings.map((f) => [f.checkId, f.evidence]));
      expect(Object.keys(by).sort()).toEqual(
        IDS.filter((i) => i !== "remix-dev-tools-live").sort(),
      );
      expect(by["remix-draft-public"]).toBe("/api/preview set preview_session with no secret");
      expect(by["remix-preview-canonical"]).toBe(
        "canonical https://marrowlane-git-main-studio.vercel.app/ is on a preview domain",
      );
      expect(by["remix-data-as-page"]).toBe("the sitemap lists 1 data address");
      expect(by["remix-private-fields"]).toBe(
        "__reactRouterContext has wholesaleToken (field names only)",
      );
      expect(JSON.stringify(result.findings)).not.toMatch(/invented-fixture-value|blue jar/);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("without consent the draft routes are never asked, and the check says why", async () => {
    const site = await startFixture("remix-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["remix-draft-public"],
      });
      expect(result.findings).toEqual([]);
      expect([...site.hits.keys()].filter((k) => k.startsWith("/api/"))).toEqual([]);
      expect(JSON.stringify(result.couldNotCheck)).toMatch(/--owner-consent/);
    } finally {
      await site.close();
    }
  });

  it("a development server is found from the page alone", async () => {
    const site = await startFixture("remix-dev");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["remix-dev-tools-live"],
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "the page carries /@vite/client, inject-hmr-runtime",
      ]);
    } finally {
      await site.close();
    }
  });
});

describe("remix: edge cases", () => {
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
    answers: Record<string, Hop[]> = {},
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

  it("on a site that isn't Remix every check is silent and nothing is requested", async () => {
    const asked: string[] = [];
    const { ctx, unread } = ctxFor({}, asked, { ownerConsent: true });
    const plain = page(URL0, '<link rel="canonical" href="https://x.vercel.app/">');
    for (const c of [
      remixDraftPublic,
      remixPreviewCanonical,
      remixDataAsPage,
      remixPrivateFields,
      remixDevToolsLive,
    ])
      expect(await c.run(plain, ctx), c.id).toEqual([]);
    expect(asked).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("a hostile turbo-stream (cycle, __proto__ keys, deep, huge, not an array) is read without a hang or pollution", () => {
    const names = new Set<string>();
    // 0 -> {_1: 0} refers to itself; keys __proto__ and constructor are only ever strings.
    expect(turboNames('[{"_1":0,"_2":0,"_3":0},"__proto__","constructor","self"]', names)).toBe(
      true,
    );
    expect([...names]).toEqual(["__proto__", "constructor", "self"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const deep = Array.from({ length: 20_000 }, (_, i) => ({ _0: i + 1 }));
    expect(turboNames(JSON.stringify(["k", ...deep]), new Set())).toBe(true);
    expect(turboNames("x".repeat(500_000), new Set())).toBe(false);
    expect(turboNames("{not json", new Set())).toBe(false);
    expect(turboNames("[]", new Set())).toBe(false);
    expect(turboNames('["D",1]', new Set())).toBe(true);
  });

  it("a JSON context with __proto__ keys and lone surrogates does not pollute and still names its keys", () => {
    const body = `<script>window.__remixContext = {"state":{"__proto__":{"polluted":1},"constructor":2,"a\\ud800":3,"password":"x"}};</script>`;
    const e = readEmbedded(page(URL0, body));
    expect(e?.names).toEqual(expect.arrayContaining(["__proto__", "constructor", "password"]));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a huge context ends in could not check, never in a clean pass", async () => {
    const huge = `<script>window.__remixContext = {"s":"${"a".repeat(450_000)}"}</script>`;
    const { ctx, unread } = ctxFor();
    expect(await remixPrivateFields.run(page(URL0, huge), ctx)).toEqual([]);
    expect(unread.join()).toMatch(/not closed within/);
  });

  it("a truncated page, an unparseable stream and deferred chunks are could not check", async () => {
    const cut = page(URL0, '<script>window.__remixContext = {"state":{"password":"x"', {}, true);
    const a = ctxFor();
    expect(await remixPrivateFields.run(cut, a.ctx)).toEqual([]);
    expect(a.unread.join()).toMatch(/cut before its embedded state ended/);
    const garbage = page(
      URL0,
      '<script>window.__reactRouterContext = {"ssr":true};window.__reactRouterContext.streamController.enqueue("not turbo\\n");</script>',
    );
    const b = ctxFor();
    expect(await remixPrivateFields.run(garbage, b.ctx)).toEqual([]);
    expect(b.unread.join()).toMatch(/not turbo-stream/);
    const deferred = page(
      URL0,
      RR_HTML.replace("apiToken", "title").replace(
        "</body>",
        '<script>window.__reactRouterContext.streamController.enqueue("P5:[1]\\n");</script></body>',
      ),
    );
    const c = ctxFor();
    expect(await remixPrivateFields.run(deferred, c.ctx)).toEqual([]);
    expect(c.unread.join()).toMatch(/deferred values/);
  });

  it("a private field in the state is a finding that shows names and never values", async () => {
    const { ctx } = ctxFor();
    const f = await remixPrivateFields.run(page(URL0, RR_HTML), ctx);
    expect(f.map((x) => x.evidence)).toEqual([
      "__reactRouterContext has apiToken (field names only)",
    ]);
    expect(JSON.stringify(f)).not.toMatch(/"y"/);
  });

  it("a page address that is itself data, or a sitemap or canonical naming data, is found", async () => {
    const { ctx } = ctxFor();
    const data = buildSnapshot([
      hop(
        "https://studio.example/shop",
        200,
        { "content-type": "text/x-script; charset=utf-8", "x-remix-response": "yes" },
        "[1]",
      ),
    ]);
    expect((await remixDataAsPage.run(data, ctx))[0]?.evidence).toBe(
      "this address answers text/x-script (single fetch data)",
    );
    const v2 = buildSnapshot([
      hop(
        "https://studio.example/shop?_data=routes%2Fshop",
        200,
        { "content-type": "application/json", "x-remix-response": "yes" },
        "{}",
      ),
    ]);
    expect((await remixDataAsPage.run(v2, ctx))[0]?.evidence).toMatch(/X-Remix-Response/);
    const listed = (
      await remixDataAsPage.run(
        page(URL0, `${RR_HTML}<link rel="canonical" href="https://studio.example/a.data">`),
        {
          ...ctx,
          site: async () => ({
            sitemapUrls: [
              "https://studio.example/a.data",
              "https://studio.example/b?_data=root",
              "https://studio.example/c",
            ],
          }),
        } as CheckContext,
      )
    )[0];
    expect(listed?.evidence).toBe(
      "the sitemap lists 2 data addresses; the canonical is a data address",
    );
  });

  it("the draft check asks only its four routes with GET and ignores a cookie that is not about preview", async () => {
    const asked: string[] = [];
    const { ctx } = ctxFor(
      {
        "https://studio.example/api/draft": [
          hop("x", 200, { "set-cookie": "theme=dark; Path=/" }, ""),
        ],
      },
      asked,
      { ownerConsent: true },
    );
    expect(await remixDraftPublic.run(page(URL0, RR_HTML), ctx)).toEqual([]);
    expect(asked).toEqual([
      "https://studio.example/api/preview",
      "https://studio.example/api/draft",
      "https://studio.example/preview",
      "https://studio.example/draft",
    ]);
  });
});
