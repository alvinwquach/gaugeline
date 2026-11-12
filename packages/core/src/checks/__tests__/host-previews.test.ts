import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Fetcher, type Hop } from "../../fetcher.js";
import { classifyPreviewHost, previewAddressOf, saysNoindex } from "../../host-previews.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import type { SiteContext } from "../../site-context.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { hostPreviewIndexable } from "../host-preview-indexable.js";
import { hostPreviewNamed } from "../host-preview-named.js";

const NETLIFY = "deploy-preview-12--fernlight-demo-0000.netlify.app";
const PAGES = "a1b2c3d4.fernlight-demo-0000.pages.dev";
const AMPLIFY = "pr-7.d0000fernlight.amplifyapp.com";
const VERCEL_DEPLOY = "fernlight-demo-k3j9x2m1a-fernlight-team.vercel.app";
const VERCEL_BRANCH = "fernlight-demo-git-menu-edit-fernlight-team.vercel.app";

function page(url: string, head = "", headers: Record<string, string> = {}): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html", ...headers },
      body: `<html><head>${head}</head><body><main>Hi</main></body></html>`,
      ms: 1,
    },
  ]);
}

function siteWith(parts: Partial<SiteContext>): () => Promise<SiteContext> {
  const base = {
    robotsUrl: "",
    robots: null,
    robotsState: "missing",
    sitemaps: [],
    sitemapUrls: [],
    sitemapAlternates: [],
    sitemapSample: [],
    feeds: [],
    llms: { url: "", state: "missing", file: null },
  } as SiteContext;
  return async () => ({ ...base, ...parts });
}

describe("host previews: unit (address patterns)", () => {
  it("the four hosts' preview and deploy addresses", () => {
    expect(classifyPreviewHost(NETLIFY)).toEqual({
      vendor: "netlify",
      kind: "pull-request",
      host: NETLIFY,
    });
    expect(classifyPreviewHost("staging--fernlight-demo-0000.netlify.app")?.kind).toBe("branch");
    expect(
      classifyPreviewHost(`${"0123456789abcdef01234567"}--fernlight-demo-0000.netlify.app`)?.kind,
    ).toBe("deploy");
    expect(classifyPreviewHost(PAGES)).toEqual({
      vendor: "cloudflare-pages",
      kind: "deploy",
      host: PAGES,
    });
    expect(classifyPreviewHost("menu-edit.fernlight-demo-0000.pages.dev")?.kind).toBe("branch");
    expect(classifyPreviewHost(AMPLIFY)).toEqual({
      vendor: "amplify",
      kind: "pull-request",
      host: AMPLIFY,
    });
    expect(classifyPreviewHost("menu-edit.d0000fernlight.amplifyapp.com")?.kind).toBe("branch");
    expect(classifyPreviewHost(VERCEL_DEPLOY)).toEqual({
      vendor: "vercel",
      kind: "deploy",
      host: VERCEL_DEPLOY,
    });
    expect(classifyPreviewHost(VERCEL_BRANCH)?.kind).toBe("branch");
  });

  it("a project's own address and the live branch are not preview addresses", () => {
    for (const h of [
      "fernlight-demo.vercel.app",
      "fernlight-cafe-roasters.vercel.app", // a 9-letter word is not a hash
      "fernlight-demo-0000.netlify.app",
      "main--fernlight-demo-0000.netlify.app",
      "fernlight-demo-0000.pages.dev",
      "production.fernlight-demo-0000.pages.dev",
      "main.d0000fernlight.amplifyapp.com",
      "vercel.app",
      "netlify.app",
      "pages.dev",
    ])
      expect(classifyPreviewHost(h), h).toBeUndefined();
  });

  it("suffix tricks, userinfo, ports, trailing dots, case and IDN", () => {
    for (const u of [
      `https://${NETLIFY}.example.com/`,
      `https://${NETLIFY}.evil.test/menu`,
      `https://evil.test/${NETLIFY}/`,
      `https://${NETLIFY}@evil.test/`,
      "https://deploy-preview-12--site.notnetlify.app/",
      `https://${NETLIFY.replace("deploy", "dep.loy")}/`,
      "https://xn--caf-dma--fernlight.netlify.app/", // an IDN site name is not a branch deploy
      "https://a.b.fernlight-demo-0000.pages.dev/",
      "https://x.y.vercel.app/",
      "mailto:deploy-preview-12--fernlight-demo-0000.netlify.app",
      "/relative/path",
      "not a url",
    ])
      expect(previewAddressOf(u), u).toBeUndefined();
    for (const u of [
      `https://${NETLIFY.toUpperCase()}/menu`,
      `https://${NETLIFY}:8443/menu?x=1#top`,
      `https://${NETLIFY}./`,
      `//${NETLIFY}/menu`,
      `https://user:pw@${NETLIFY}/`,
    ])
      expect(previewAddressOf(u)?.host, u).toBe(NETLIFY);
  });

  it("noindex and none, alone or in a list, in a meta tag or a header", () => {
    for (const v of ["noindex", "NOINDEX, nofollow", "none", "googlebot: noindex", "nofollow,none"])
      expect(saysNoindex(v), v).toBe(true);
    for (const v of ["index, follow", "all", "noindexed-not", undefined, ""])
      expect(saysNoindex(v), String(v)).toBe(false);
  });

  it("a hostile address list is read in bounded time", () => {
    const p = page("https://fernlight-cafe.example/");
    p.scripts = Array.from(
      { length: 200_000 },
      (_, i) => `https://cdn.example/${"a".repeat(50)}${i}.js`,
    );
    const t = Date.now();
    void hostPreviewNamed.run(p, { warn: () => undefined });
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("host-preview-named: unit", () => {
  const ctx = (parts: Partial<SiteContext> = {}): CheckContext => ({
    warn: () => undefined,
    site: siteWith(parts),
  });

  it("canonical, og:url, a language version, a script, a feed link, the sitemap and a feed item", async () => {
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="canonical" href="https://${NETLIFY}/">
       <meta property="og:url" content="https://${PAGES}/">
       <link rel="alternate" hreflang="fr" href="https://${AMPLIFY}/fr/">
       <link rel="alternate" type="application/rss+xml" href="https://${VERCEL_DEPLOY}/feed.xml">
       <script src="https://${VERCEL_BRANCH}/app.js"></script>`,
    );
    const out = await hostPreviewNamed.run(
      p,
      ctx({
        sitemapUrls: [`https://${NETLIFY}/menu?token=abc`],
        feeds: [
          {
            url: "https://fernlight-cafe.example/feed.xml",
            hops: [],
            bytes: 0,
            itemLinks: [`https://${PAGES}/news`],
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("high");
    expect(out[0]?.evidence).toBe(
      `7 places name a preview address (AWS Amplify pull request preview, Cloudflare Pages deploy, Netlify pull request preview, Vercel branch deploy, Vercel deploy): canonical ${NETLIFY}/, og:url ${PAGES}/, hreflang fr ${AMPLIFY}/fr/ and 4 more`,
    );
    // Host and path only: no query, no token.
    expect(JSON.stringify(out)).not.toContain("token");
  });

  it("a clean page, a project address and an ordinary link pass", async () => {
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="canonical" href="https://fernlight-cafe.example/">
       <link rel="alternate" hreflang="fr" href="https://fernlight-demo.vercel.app/fr/">`,
    );
    p.links = [{ href: `https://${NETLIFY}/`, text: "preview", sameSite: false }];
    expect(await hostPreviewNamed.run(p, ctx())).toEqual([]);
  });

  it("a page served from a temporary host is not checked: it is the preview", async () => {
    const p = page(`https://${NETLIFY}/`, `<link rel="canonical" href="https://${PAGES}/">`);
    expect(await hostPreviewNamed.run(p, ctx())).toEqual([]);
  });

  const COVERED: [string, string, Record<string, string>][] = [
    ["Astro", '<astro-island uid="1"></astro-island>', {}],
    ["SvelteKit", "<main>Hi</main>", { "x-sveltekit-page": "true" }],
    ["Angular", '<app-root ng-version="18.2.0"></app-root>', {}],
    ["Gatsby", '<div id="___gatsby"></div>', {}],
    ["Hugo", '<meta name="generator" content="Hugo 0.121.0">', {}],
  ];

  it.each(COVERED)(
    "a %s site's canonical, og:url and sitemap are left to its own preview check",
    async (_name, marker, headers) => {
      const p = page(
        "https://fernlight-cafe.example/",
        `${marker}<link rel="canonical" href="https://${NETLIFY}/"><meta property="og:url" content="https://${NETLIFY}/">`,
        headers,
      );
      expect(
        await hostPreviewNamed.run(p, ctx({ sitemapUrls: [`https://${NETLIFY}/menu`] })),
      ).toEqual([]);
    },
  );

  it("a framework site still gets a finding for what its own check does not read", async () => {
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="alternate" hreflang="fr" href="https://${AMPLIFY}/fr/">`,
      { "x-sveltekit-page": "true" },
    );
    const out = await hostPreviewNamed.run(p, ctx());
    expect(out[0]?.evidence).toContain(`hreflang fr ${AMPLIFY}/fr/`);
  });

  it("an Amplify canonical on a framework site is still reported: the framework's check does not read amplifyapp.com", async () => {
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="canonical" href="https://${AMPLIFY}/"><meta property="og:url" content="https://${NETLIFY}/">`,
      { "x-sveltekit-page": "true" },
    );
    const out = await hostPreviewNamed.run(p, ctx({ sitemapUrls: [`https://${AMPLIFY}/menu`] }));
    expect(out[0]?.evidence).toBe(
      `2 places name a preview address (AWS Amplify pull request preview): canonical ${AMPLIFY}/, sitemap ${AMPLIFY}/menu`,
    );
  });

  it("a plain site with the same preview canonical and sitemap still gets the finding", async () => {
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="canonical" href="https://${NETLIFY}/"><meta property="og:url" content="https://${NETLIFY}/">`,
    );
    const out = await hostPreviewNamed.run(p, ctx({ sitemapUrls: [`https://${NETLIFY}/menu`] }));
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toContain("3 places name a preview address");
  });

  it("a Next.js site's canonical, og:url and sitemap are left to next-preview-canonical", async () => {
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="canonical" href="https://${NETLIFY}/"><link rel="alternate" hreflang="fr" href="https://${AMPLIFY}/fr/">`,
      { "x-powered-by": "Next.js" },
    );
    const out = await hostPreviewNamed.run(p, ctx({ sitemapUrls: [`https://${NETLIFY}/menu`] }));
    expect(out[0]?.evidence).toBe(
      `1 place names a preview address (AWS Amplify pull request preview): hreflang fr ${AMPLIFY}/fr/`,
    );
  });
});

/** A fetcher stand-in: each answer by address, every call recorded. */
function stub(answers: Record<string, Partial<Hop> | null>) {
  const calls: { url: string; method?: string }[] = [];
  const fetcher: Fetcher = {
    get: async (url, opts) => {
      calls.push({ url, method: opts?.method });
      const a = answers[url];
      if (a === undefined || a === null) {
        const { NetworkError } = await import("../../errors.js");
        throw new NetworkError("no answer", { url });
      }
      return [
        {
          url,
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html></html>",
          ms: 1,
          ...a,
        },
      ];
    },
    getSite: async () => [],
    stats: { requests: 0, maxInFlight: 0 },
  } as Fetcher;
  const unread: [string, string][] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    fetcher,
    couldNotCheck: (u, why) => void unread.push([u, why]),
  };
  return { calls, ctx, unread };
}

describe("host-preview-indexable: unit", () => {
  const url = `https://${NETLIFY}/menu`;
  const named = (urls: string[]) =>
    page(
      "https://fernlight-cafe.example/",
      urls.map((u) => `<link rel="alternate" hreflang="fr" href="${u}">`).join(""),
    );
  const ctxSite = (ctx: CheckContext, sitemapUrls: string[] = []): CheckContext => ({
    ...ctx,
    site: siteWith({ sitemapUrls }),
  });

  it("200, no noindex, canonical missing or its own: one finding with host and path", async () => {
    for (const body of [
      "<html></html>",
      `<link rel="canonical" href="https://${NETLIFY}/menu">`,
      '<link rel="canonical" href="/menu">',
    ]) {
      const s = stub({ [url]: { body } });
      const out = await hostPreviewIndexable.run(
        named([url + "?a=1#x"].map((u) => u.split("?")[0] ?? u)),
        ctxSite(s.ctx),
      );
      expect(
        out.map((f) => [f.checkId, f.severity, f.evidence]),
        body,
      ).toEqual([
        [
          "host-preview-indexable",
          "high",
          `${NETLIFY}/menu answers 200 with no noindex in meta robots or X-Robots-Tag and no canonical elsewhere`,
        ],
      ]);
      expect(s.calls).toEqual([{ url, method: undefined }]);
    }
  });

  it("noindex in the header or the meta tag, a login, a canonical elsewhere, a redirect away and a 404 pass", async () => {
    const cases: Record<string, Partial<Hop>> = {
      header: { headers: { "x-robots-tag": "noindex" } },
      meta: { body: '<meta name="robots" content="noindex, nofollow">' },
      protected401: { status: 401 },
      protected403: { status: 403 },
      elsewhere: { body: '<link rel="canonical" href="https://fernlight-cafe.example/menu">' },
      gone: { status: 404 },
      away: { url: "https://fernlight-cafe.example/menu" },
    };
    for (const [name, a] of Object.entries(cases)) {
      const s = stub({ [url]: a });
      expect(await hostPreviewIndexable.run(named([url]), ctxSite(s.ctx)), name).toEqual([]);
      expect(s.unread, name).toEqual([]);
    }
  });

  it("no answer or a cut-off body is could-not-check, never a pass or a finding", async () => {
    const none = stub({ [url]: null });
    expect(await hostPreviewIndexable.run(named([url]), ctxSite(none.ctx))).toEqual([]);
    expect(none.unread).toEqual([[url, `${NETLIFY}/menu did not answer`]]);
    const cut = stub({ [url]: { truncated: true } });
    expect(await hostPreviewIndexable.run(named([url]), ctxSite(cut.ctx))).toEqual([]);
    expect(cut.unread[0]?.[1]).toContain("larger than the part read");
  });

  it("asks only about addresses the site names, GET only, at most three, never a script or a project address", async () => {
    const urls = [
      `https://${NETLIFY}/a`,
      `https://${PAGES}/b`,
      `https://${AMPLIFY}/c`,
      `https://${VERCEL_DEPLOY}/d`,
      "https://fernlight-demo.vercel.app/e",
    ];
    const s = stub({});
    const p = page(
      "https://fernlight-cafe.example/",
      `<script src="https://${VERCEL_BRANCH}/app.js"></script>`,
    );
    await hostPreviewIndexable.run(p, ctxSite(s.ctx, urls));
    expect(s.calls.map((c) => c.url)).toEqual(urls.slice(0, 3));
    expect(s.calls.every((c) => c.method === undefined)).toBe(true);
    // Nothing named, nothing asked.
    const quiet = stub({});
    await hostPreviewIndexable.run(page("https://fernlight-cafe.example/"), ctxSite(quiet.ctx));
    expect(quiet.calls).toEqual([]);
  });

  it("a framework site's preview canonical and sitemap are not asked about: its own check reports them", async () => {
    const s = stub({});
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">`,
      { "x-sveltekit-page": "true" },
    );
    expect(await hostPreviewIndexable.run(p, ctxSite(s.ctx, [url]))).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(s.unread).toEqual([]);
  });

  it("a framework site's other preview addresses are still asked about", async () => {
    const s = stub({ [url]: {} });
    const p = page(
      "https://fernlight-cafe.example/",
      `<link rel="canonical" href="https://${PAGES}/"><link rel="alternate" hreflang="fr" href="${url}">`,
      { "x-sveltekit-page": "true" },
    );
    const out = await hostPreviewIndexable.run(p, ctxSite(s.ctx));
    expect(s.calls.map((c) => c.url)).toEqual([url]);
    expect(out).toHaveLength(1);
  });

  it("a plain site with a preview canonical is still asked about", async () => {
    const s = stub({ [url]: null });
    const p = page("https://fernlight-cafe.example/", `<link rel="canonical" href="${url}">`);
    await hostPreviewIndexable.run(p, ctxSite(s.ctx));
    expect(s.calls.map((c) => c.url)).toEqual([url]);
    expect(s.unread).toEqual([[url, `${NETLIFY}/menu did not answer`]]);
  });

  it("a page on a temporary host, or a run without a fetcher, asks nothing", async () => {
    const s = stub({});
    expect(
      await hostPreviewIndexable.run(
        page(`https://${PAGES}/`, `<link rel="canonical" href="https://${NETLIFY}/">`),
        s.ctx,
      ),
    ).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(await hostPreviewIndexable.run(named([url]), { warn: () => undefined })).toEqual([]);
  });
});

describe("host previews: integration (the host-previews fixture)", () => {
  it("the sitemap names a Netlify deploy preview that answers 200 and can be indexed", async () => {
    const site = await startFixture("host-previews");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["host-preview-named", "host-preview-indexable"],
      });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        [
          "host-preview-indexable",
          "deploy-preview-12--fernlight-demo-0000.netlify.app/menu answers 200 with no noindex in meta robots or X-Robots-Tag and no canonical elsewhere",
        ],
        [
          "host-preview-named",
          "1 place names a preview address (Netlify pull request preview): sitemap deploy-preview-12--fernlight-demo-0000.netlify.app/menu",
        ],
      ]);
      expect(result.failed).toEqual([]);
      // The preview was read once, with a GET, because the sitemap named it.
      expect(site.methods.get("POST") ?? 0).toBe(0);
    } finally {
      await site.close();
    }
  });
});
