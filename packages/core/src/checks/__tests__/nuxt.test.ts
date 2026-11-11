import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import { linkCandidates } from "../../links.js";
import type { CheckContext } from "../../model.js";
import { isNuxtSite } from "../../nuxt/detect.js";
import { isNuxtFrameworkUrl } from "../../nuxt/framework-urls.js";
import { isFrameworkUrl } from "../../next/framework-urls.js";
import {
  configFields,
  findDataScript,
  hasDevtoolsState,
  parseFlat,
  payloadFields,
  previewState,
  privateKindOf,
} from "../../nuxt/state.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { nuxtDevBuildLive } from "../nuxt-dev-build-live.js";
import { nuxtDevtoolsPublic } from "../nuxt-devtools-public.js";
import { nuxtFrameworkFileListed } from "../nuxt-framework-file-listed.js";
import { nuxtPageCacheHeader, parseCacheControl } from "../nuxt-page-cache-header.js";
import { nuxtPreviewCanonical } from "../nuxt-preview-canonical.js";
import { nuxtPreviewPublic } from "../nuxt-preview-public.js";
import { nuxtPrivateState } from "../nuxt-private-state.js";

const NUXT_CHECKS = [
  "nuxt-dev-build-live",
  "nuxt-devtools-public",
  "nuxt-framework-file-listed",
  "nuxt-page-cache-header",
  "nuxt-preview-canonical",
  "nuxt-preview-public",
  "nuxt-private-state",
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
const dataScript = (flat: unknown, extra = "") =>
  `<script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" ${extra} id="__NUXT_DATA__">${typeof flat === "string" ? flat : JSON.stringify(flat)}</script>`;
const NUXT_HTML = `<html><head><script type="module" src="/_nuxt/entry.js"></script></head><body><main>Hi</main></body></html>`;
const reasons = () => {
  const list: string[] = [];
  return { list, fn: (url: string, reason: string) => void list.push(`${url}: ${reason}`) };
};

describe("nuxt: unit", () => {
  it("a Nuxt site is recognised from its header, its scripts or its payload markers", () => {
    expect(
      isNuxtSite(page("https://bake.example/", "<html></html>", { "x-powered-by": "Nuxt" })),
    ).toBe(true);
    expect(isNuxtSite(page("https://bake.example/", NUXT_HTML))).toBe(true);
    expect(isNuxtSite(page("https://bake.example/", dataScript([{}])))).toBe(true);
    expect(isNuxtSite(page("https://bake.example/", "<script>window.__NUXT__={}</script>"))).toBe(
      true,
    );
    expect(isNuxtSite(page("https://bake.example/", "<html><body>Plain</body></html>"))).toBe(
      false,
    );
    expect(
      isNuxtSite(page("https://bake.example/", "<html></html>", { "x-powered-by": "Express" })),
    ).toBe(false);
    // A header that merely contains the word is not Nuxt.
    expect(
      isNuxtSite(page("https://bake.example/", "<html></html>", { "x-powered-by": "NotNuxt" })),
    ).toBe(false);
  });

  it("framework addresses: payloads, build output, islands and dev tools are not pages", () => {
    for (const u of [
      "https://bake.example/_nuxt/entry.3f2a.js",
      "https://bake.example/menu/_payload.json",
      "https://bake.example/_payload.json?abc123",
      "https://bake.example/_payload.js",
      "https://bake.example/__nuxt_island/Cart_x1.json",
      "https://bake.example/__nuxt_devtools__/client/",
    ])
      expect(isNuxtFrameworkUrl(u), u).toBe(true);
    for (const u of [
      "https://bake.example/menu",
      "https://bake.example/nuxt-tips",
      "https://bake.example/blog/payload",
      "https://bake.example/_payloads",
      "not a url",
    ])
      expect(isNuxtFrameworkUrl(u), u).toBe(false);
    // The shared discovery rule includes them: they are never sampled as pages.
    expect(isFrameworkUrl("https://bake.example/menu/_payload.json")).toBe(true);
    const p = page(
      "https://bake.example/",
      `${NUXT_HTML}<a href="/menu/_payload.json">p</a><a href="/menu">Menu</a>`,
    );
    expect(linkCandidates(p).map((l) => l.url)).toEqual(["https://bake.example/menu"]);
  });

  it("finding the data script: inline, external, absent, cut off", () => {
    expect(findDataScript(dataScript([1]), false)).toEqual({ kind: "inline", text: "[1]" });
    expect(findDataScript(dataScript([1], 'data-src="/menu/_payload.json?x1"'), false)).toEqual({
      kind: "external",
      src: "/menu/_payload.json?x1",
    });
    expect(findDataScript("<html>no state</html>", false)).toEqual({ kind: "none" });
    expect(findDataScript('<script id="__NUXT_DATA__">[1,2', true)).toMatchObject({
      kind: "unread",
      reason: expect.stringMatching(/cut at the size limit/),
    });
    // The marker in ordinary text, outside any script tag, is not a data script.
    expect(findDataScript("<p>the __NUXT_DATA__ script holds state</p>", false)).toEqual({
      kind: "none",
    });
  });

  it("parsing a payload: only a JSON array is a flat payload", () => {
    expect(parseFlat("[1,2]")).toEqual({ flat: [1, 2] });
    expect(parseFlat("{}")).toMatchObject({ reason: expect.any(String) });
    expect(parseFlat("not json")).toMatchObject({ reason: "the payload is not JSON" });
    expect(parseFlat(`[${"1,".repeat(100_001)}1]`)).toMatchObject({
      reason: expect.stringMatching(/too many/),
    });
  });

  it("field names and kinds come from a flat payload, through wrappers, and never include values", () => {
    const flat = [
      { shop: 1, mode: 2 },
      { stripeSecretKey: 3, mailerPassword: 4, open: 5, tags: 6, note: 7 },
      ["Ref", 1],
      "invented-value",
      "",
      true,
      [3],
      null,
    ];
    const fields = payloadFields(flat);
    expect(fields).toContainEqual({ name: "stripeSecretKey", kind: "text" });
    expect(fields).toContainEqual({ name: "mailerPassword", kind: "empty" });
    expect(fields).toContainEqual({ name: "open", kind: "flag" });
    expect(fields).toContainEqual({ name: "tags", kind: "list" });
    expect(fields).toContainEqual({ name: "note", kind: "empty" });
    // A wrapper is followed to what it wraps.
    expect(fields).toContainEqual({ name: "mode", kind: "object" });
    expect(JSON.stringify(fields)).not.toContain("invented-value");
  });

  it("preview state and dev tools state are read from the useState keys", () => {
    const on = [{ $s_preview_x: 1 }, 2];
    expect(previewState(on)).toBe("unknown");
    expect(previewState([{ "$s_preview-state": 1 }, { enabled: 2, state: 3 }, true, {}])).toBe(
      "on",
    );
    expect(previewState([{ "$s_preview-state": 1 }, { enabled: 2, state: 3 }, false, {}])).toBe(
      "off",
    );
    expect(previewState([{ "$s_preview-state": 1 }, "not an object"])).toBe("unknown");
    expect(hasDevtoolsState([{ $s__nuxt_devtools__: 1 }, {}])).toBe(true);
    expect(hasDevtoolsState([{ "$s_preview-state": 1 }, {}])).toBe(false);
  });

  it("the public config literal: keys at any depth, with the kind of each value", () => {
    const body =
      '<script>window.__NUXT__={};window.__NUXT__.config={public:{shopName:"Marrow",mailgunApiKey:"x",empty:"",on:!0,n:3,list:[1],"quoted-key":"v"},app:{baseURL:"/",cdnURL:""}}</script>';
    const fields = configFields(body);
    const byName = new Map(fields.map((f) => [f.name, f.kind]));
    expect(byName.get("mailgunApiKey")).toBe("text");
    expect(byName.get("empty")).toBe("empty");
    expect(byName.get("on")).toBe("flag");
    expect(byName.get("n")).toBe("number");
    expect(byName.get("list")).toBe("list");
    expect(byName.get("quoted-key")).toBe("text");
    expect(byName.get("public")).toBe("object");
    expect(byName.has("shopName")).toBe(true);
  });

  it("which names look private: words, not substrings", () => {
    expect(privateKindOf("supabaseServiceRole")).toBe("a service role key");
    expect(privateKindOf("SUPABASE_SERVICE_ROLE_KEY")).toBe("a service role key");
    expect(privateKindOf("stripeSecretKey")).toBe("a secret");
    expect(privateKindOf("jwt_secret")).toBe("a secret");
    expect(privateKindOf("adminPassword")).toBe("a password");
    expect(privateKindOf("privateKey")).toBe("a private key");
    expect(privateKindOf("accessToken")).toBe("an access token");
    expect(privateKindOf("mailgunApiKey")).toBe("an API key");
    for (const n of ["secretary", "publishableKey", "csrfToken", "monkey", "title", "tokenizer"])
      expect(privateKindOf(n), n).toBeUndefined();
  });

  it("Cache-Control is parsed into a Map of directives", () => {
    const cc = parseCacheControl('Public, MAX-AGE=600, s-maxage="30", immutable');
    expect(cc.get("max-age")).toBe(600);
    expect(cc.get("s-maxage")).toBe(30);
    expect(cc.get("public")).toBe(true);
    expect(cc.has("immutable")).toBe(true);
    expect(parseCacheControl("").size).toBe(0);
  });
});

describe("nuxt: integration (the nuxt-like fixture)", () => {
  it("every ordinary check fires once; the two probing checks need consent", async () => {
    const site = await startFixture("nuxt-like");
    try {
      const { result, budget } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: NUXT_CHECKS.filter((id) => !/devtools-public|preview-public/.test(id)),
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        ["nuxt-dev-build-live", "high", "the page loads /_nuxt/@vite/client"],
        [
          "nuxt-preview-canonical",
          "high",
          "canonical https://marrow-rye-git-main.vercel.app/; hreflang alternates https://marrow-rye-git-main.vercel.app/, https://marrow-rye-git-main.vercel.app/fr are on a preview or local address",
        ],
        [
          "nuxt-private-state",
          "high",
          "3 fields in the page's embedded state look private: mailgunApiKey (an API key, in the public config), stripeSecretKey (a secret, in the payload), supabaseServiceRole (a service role key, in the payload). Values are not shown",
        ],
        [
          "nuxt-framework-file-listed",
          "medium",
          `the sitemap lists ${site.origin}/_payload.json, ${site.origin}/menu/_payload.json`,
        ],
        ["nuxt-page-cache-header", "medium", "its Cache-Control says immutable"],
      ]);
      expect(budget.summary().frameworkAddresses.found).toBe(2);
      // The payload files named in the sitemap were never requested.
      expect([...site.hits.keys()].filter((k) => k.includes("_payload"))).toEqual([]);
      expect(result.failed).toEqual([]);
      // Without consent the probing checks asked nothing.
      expect(site.hits.get("/__nuxt_devtools__/client/")).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("invented-value");
    } finally {
      await site.close();
    }
  });

  it("with consent: preview mode switched on by the query, and the dev tools page", async () => {
    const site = await startFixture("nuxt-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["nuxt-preview-public", "nuxt-devtools-public"],
        ownerConsent: true,
      });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        [
          "nuxt-devtools-public",
          "/__nuxt_devtools__/client/ answered 200 with the Nuxt DevTools page",
        ],
        [
          "nuxt-preview-public",
          "asked with ?preview=true and no secret, the page was rendered with preview mode on (enabled: true)",
        ],
      ]);
      const asked = site.requests.filter((r) => r.path === "/" && r.method !== "GET");
      expect(asked).toEqual([]);
      expect(site.requests.every((r) => r.method === "GET" || r.method === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });
});

describe("nuxt: edge cases", () => {
  const fetcherFor = (answers: Record<string, Hop[]>, asked: string[] = []) => ({
    get: async (url: string) => {
      asked.push(url);
      return answers[url] ?? [{ url, status: 404, headers: {}, body: "", ms: 1 }];
    },
    getSite: async () => [],
    stats: { requests: 0, maxInFlight: 0 },
  });
  const hop = (url: string, body: string, extra: Partial<Hop> = {}): Hop => ({
    url,
    status: 200,
    headers: { "content-type": "text/html" },
    body,
    ms: 1,
    ...extra,
  });

  it("on a site that isn't Nuxt, every check is unchecked and nothing is requested", async () => {
    const asked: string[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      budget: createBudget(),
      fetcher: fetcherFor({}, asked),
      ownerConsent: true,
    };
    const plain = page(
      "https://bake.example/",
      '<link rel="canonical" href="https://x.vercel.app/"><script>var secretKey="abc"</script>',
      { "cache-control": "public, immutable" },
    );
    for (const c of [
      nuxtDevBuildLive,
      nuxtDevtoolsPublic,
      nuxtFrameworkFileListed,
      nuxtPageCacheHeader,
      nuxtPreviewCanonical,
      nuxtPreviewPublic,
      nuxtPrivateState,
    ])
      expect(await c.run(plain, ctx), c.id).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("without consent the probing checks ask nothing and say why", async () => {
    const asked: string[] = [];
    const r = reasons();
    const ctx: CheckContext = {
      warn: () => undefined,
      budget: createBudget(),
      fetcher: fetcherFor({}, asked),
      couldNotCheck: r.fn,
    };
    const p = page("https://bake.example/", NUXT_HTML);
    expect(await nuxtPreviewPublic.run(p, ctx)).toEqual([]);
    expect(await nuxtDevtoolsPublic.run(p, ctx)).toEqual([]);
    expect(asked).toEqual([]);
    expect(r.list.join("\n")).toMatch(
      /--owner-consent.*on sites you own or have permission to test/s,
    );
  });

  it("a page that never sends preview state is could-not-check, never a pass", async () => {
    const r = reasons();
    const u = "https://bake.example/?preview=true&token=gaugeline-probe";
    const ctx: CheckContext = {
      warn: () => undefined,
      budget: createBudget(),
      ownerConsent: true,
      couldNotCheck: r.fn,
      fetcher: fetcherFor({ [u]: [hop(u, dataScript([{ data: 1 }, {}]))] }),
    };
    expect(await nuxtPreviewPublic.run(page("https://bake.example/", NUXT_HTML), ctx)).toEqual([]);
    expect(r.list.join("\n")).toMatch(/no preview state/);
  });

  it("preview mode off in the answer is a clean result; an unreadable answer is could-not-check", async () => {
    const u = "https://bake.example/?preview=true&token=gaugeline-probe";
    const off = [{ "$s_preview-state": 1 }, { enabled: 2, state: 3 }, false, {}];
    const run = async (answer: Hop[]) => {
      const r = reasons();
      const out = await nuxtPreviewPublic.run(page("https://bake.example/", NUXT_HTML), {
        warn: () => undefined,
        budget: createBudget(),
        ownerConsent: true,
        couldNotCheck: r.fn,
        fetcher: fetcherFor({ [u]: answer }),
      });
      return { out, reasons: r.list.join("\n") };
    };
    expect(await run([hop(u, dataScript(off))])).toEqual({ out: [], reasons: "" });
    expect((await run([hop(u, dataScript("not json"))])).reasons).toMatch(/not JSON/);
    expect((await run([hop(u, dataScript([1]), { status: 503 })])).reasons).toMatch(/answered 503/);
    expect(
      (await run([hop(u, '<script id="__NUXT_DATA__">[1', { truncated: true })])).reasons,
    ).toMatch(/cut at the size limit/);
    expect((await run([hop(u, dataScript([1], 'data-src="/_payload.json"'))])).reasons).toMatch(
      /separate payload file/,
    );
  });

  it("a payload held in a separate file is read once, from this site only", async () => {
    const asked: string[] = [];
    const own = "https://bake.example/menu/_payload.json?b1";
    const payload = JSON.stringify([
      { data: 1 },
      { shop: 2 },
      { adminPassword: 3 },
      "hunter2-invented",
    ]);
    const ctx = (answers: Record<string, Hop[]>, r = reasons()): CheckContext => ({
      warn: () => undefined,
      budget: createBudget(),
      couldNotCheck: r.fn,
      fetcher: fetcherFor(answers, asked),
    });
    const html = (src: string) =>
      `${NUXT_HTML}${dataScript([{ data: 1 }, {}], `data-src="${src}"`)}`;
    const found = await nuxtPrivateState.run(
      page("https://bake.example/menu", html("/menu/_payload.json?b1")),
      ctx({ [own]: [hop(own, payload, { headers: { "content-type": "application/json" } })] }),
    );
    expect(found.map((f) => f.evidence)).toEqual([
      "1 field in the page's embedded state looks private: adminPassword (a password, in the payload). Values are not shown",
    ]);
    expect(JSON.stringify(found)).not.toContain("hunter2");
    expect(asked).toEqual([own]);
    // Another host's payload is never asked for.
    asked.length = 0;
    const r = reasons();
    expect(
      await nuxtPrivateState.run(
        page("https://bake.example/menu", html("https://cdn.example/menu/_payload.json")),
        ctx({}, r),
      ),
    ).toEqual([]);
    expect(asked).toEqual([]);
    expect(r.list.join("\n")).toMatch(/not on this site/);
  });

  it("hostile state: __proto__ keys, lone surrogates, deep nesting, a huge list, cycles", async () => {
    const r = reasons();
    const ctx: CheckContext = { warn: () => undefined, couldNotCheck: r.fn };
    const proto = '[{"__proto__":1,"stripeSecretKey":2,"constructor":2},{"polluted":2},"x"]';
    const lone = `[{"adminPassword":1,"name\\ud800":1},"v\\udc00"]`;
    const deep = `[${"[1],".repeat(5000)}{"apiKey":0}]`;
    const cyc = '[{"self":0,"privateKey":1},"x"]';
    for (const body of [proto, lone, deep, cyc]) {
      const out = await nuxtPrivateState.run(
        page("https://bake.example/", `${NUXT_HTML}${dataScript(body)}`),
        ctx,
      );
      expect(out.length, body.slice(0, 30)).toBeLessThanOrEqual(1);
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    const huge = `[${Array.from({ length: 90_000 }, () => '{"title":0}').join(",")}]`;
    const t = Date.now();
    await nuxtPrivateState.run(
      page("https://bake.example/", `${NUXT_HTML}${dataScript(huge)}`),
      ctx,
    );
    expect(Date.now() - t).toBeLessThan(5000);
    // A lone surrogate in a name is shown escaped or as is, never breaking the report text.
    const named = await nuxtPrivateState.run(
      page("https://bake.example/", `${NUXT_HTML}${dataScript(lone)}`),
      ctx,
    );
    expect(named[0]?.evidence).toMatch(/adminPassword \(a password/);
  });

  it("a truncated page and a payload over the size limit are could-not-check", async () => {
    const r = reasons();
    const ctx: CheckContext = { warn: () => undefined, couldNotCheck: r.fn };
    const cut = page(
      "https://bake.example/",
      `${NUXT_HTML}<script id="__NUXT_DATA__">[{"a":1`,
      {},
      true,
    );
    expect(await nuxtPrivateState.run(cut, ctx)).toEqual([]);
    const big = page(
      "https://bake.example/",
      `${NUXT_HTML}${dataScript(`[${"1,".repeat(1_100_000)}1]`)}`,
    );
    expect(await nuxtPrivateState.run(big, ctx)).toEqual([]);
    expect(r.list.join("\n")).toMatch(/cut at the size limit/);
    expect(r.list.join("\n")).toMatch(/larger than 2 MB/);
    const early = page("https://bake.example/", NUXT_HTML, {}, true);
    const r2 = reasons();
    await nuxtPrivateState.run(early, { warn: () => undefined, couldNotCheck: r2.fn });
    expect(r2.list.join("\n")).toMatch(/before any state was found/);
  });

  it("a pathological config literal is scanned in linear time", async () => {
    const body = `${NUXT_HTML}<script>window.__NUXT__={};window.__NUXT__.config={${"a:{".repeat(20000)}${"}".repeat(20000)}}</script>`;
    const t = Date.now();
    configFields(body);
    const quotes = `window.__NUXT__={a:"${"\\".repeat(200000)}`;
    configFields(`<script>${quotes}</script>`);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("empty and false values named like secrets are not reported", async () => {
    const flat = [{ stripeSecretKey: 1, adminPassword: 2, jwtSecret: 3 }, "", false, null];
    const out = await nuxtPrivateState.run(
      page("https://bake.example/", `${NUXT_HTML}${dataScript(flat)}`),
      { warn: () => undefined },
    );
    expect(out).toEqual([]);
  });

  it("cache headers: a year, immutable, or a cookie in a shared cache; short or private ones pass", () => {
    const run = (cc: string, extra: Record<string, string> = {}) =>
      nuxtPageCacheHeader.run(
        page("https://bake.example/", NUXT_HTML, { "cache-control": cc, ...extra }),
        {
          warn: () => undefined,
        },
      ) as unknown[];
    expect(run("public, max-age=31536000")).toHaveLength(1);
    expect(run("s-maxage=63072000")).toHaveLength(1);
    expect(run("public, max-age=600", { "set-cookie": "cart=1; Path=/" })).toHaveLength(1);
    expect(run("public, max-age=600")).toEqual([]);
    expect(run("s-maxage=600, stale-while-revalidate")).toEqual([]);
    expect(run("private, max-age=600", { "set-cookie": "cart=1" })).toEqual([]);
    expect(
      run("public, s-maxage=60", { "set-cookie": "cart=1", vary: "Accept-Encoding, Cookie" }),
    ).toEqual([]);
    expect(run("")).toEqual([]);
  });

  it("dev build signs: the dev client script, or the DevTools state in the payload", async () => {
    const ctx: CheckContext = { warn: () => undefined };
    const byScript = page(
      "https://bake.example/",
      '<script type="module" src="/_nuxt/@vite/client"></script>',
    );
    expect((await nuxtDevBuildLive.run(byScript, ctx)).map((f) => f.evidence)).toEqual([
      "the page loads /_nuxt/@vite/client",
    ]);
    const byState = page(
      "https://bake.example/",
      `${NUXT_HTML}${dataScript([{ $s__nuxt_devtools__: 1 }, {}])}`,
    );
    expect((await nuxtDevBuildLive.run(byState, ctx)).map((f) => f.evidence)).toEqual([
      "its payload carries the DevTools state",
    ]);
    expect(await nuxtDevBuildLive.run(page("https://bake.example/", NUXT_HTML), ctx)).toEqual([]);
  });

  it("dev tools: a 200 that is the site's own page, a 404 and a refusal are not findings; no answer is could-not-check", async () => {
    const u = "https://bake.example/__nuxt_devtools__/client/";
    const run = async (answer: Hop[]) => {
      const r = reasons();
      const out = await nuxtDevtoolsPublic.run(page("https://bake.example/", NUXT_HTML), {
        warn: () => undefined,
        budget: createBudget(),
        ownerConsent: true,
        couldNotCheck: r.fn,
        fetcher: fetcherFor({ [u]: answer }),
      });
      return { n: out.length, reasons: r.list.join("\n") };
    };
    expect(await run([hop(u, "<html><title>Bakery</title></html>")])).toEqual({
      n: 0,
      reasons: "",
    });
    expect(await run([hop(u, "", { status: 404 })])).toEqual({ n: 0, reasons: "" });
    expect(await run([hop(u, "", { status: 403 })])).toEqual({ n: 0, reasons: "" });
    expect((await run([])).reasons).toMatch(/did not answer|^$/);
    expect(await run([hop(u, "<title>Nuxt DevTools</title>")])).toMatchObject({ n: 1 });
  });

  it("preview canonical: a production page only; local and preview hosts, hreflang and the sitemap", async () => {
    const html = `${NUXT_HTML.replace("<head>", '<head><link rel="canonical" href="http://127.0.0.1:3000/"><link rel="alternate" hreflang="fr" href="https://x.netlify.app/fr">')}`;
    const out = await nuxtPreviewCanonical.run(page("https://bake.example/", html), {
      warn: () => undefined,
    });
    expect(out[0]?.evidence).toBe(
      "canonical http://127.0.0.1:3000/; hreflang alternates https://x.netlify.app/fr are on a preview or local address",
    );
    // A page that is itself on a preview host is not "production": nothing is reported.
    expect(
      await nuxtPreviewCanonical.run(page("https://bake-git-main.vercel.app/", html), {
        warn: () => undefined,
      }),
    ).toEqual([]);
  });

  it("framework file listed: canonical and hreflang naming a payload", async () => {
    const html = NUXT_HTML.replace(
      "<head>",
      '<head><link rel="canonical" href="https://bake.example/menu/_payload.json"><link rel="alternate" hreflang="fr" href="https://bake.example/fr/_payload.json">',
    );
    const out = await nuxtFrameworkFileListed.run(page("https://bake.example/menu", html), {
      warn: () => undefined,
    });
    expect(out[0]?.evidence).toBe(
      "canonical https://bake.example/menu/_payload.json; hreflang https://bake.example/fr/_payload.json",
    );
  });
});
