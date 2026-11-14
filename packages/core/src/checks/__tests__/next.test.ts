import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget, formatSampleSummary } from "../../limits.js";
import { linkCandidates } from "../../links.js";
import type { CheckContext } from "../../model.js";
import { isNextSite, readCache } from "../../next/detect.js";
import { isFrameworkUrl } from "../../next/framework-urls.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { nextDraftPublic } from "../next-draft-public.js";
import { nextPreviewCanonical } from "../next-preview-canonical.js";
import { nextStaleAfterPublish } from "../next-stale-after-publish.js";
import { thinHtml } from "../thin-html.js";

const NEXT_CHECKS = ["next-draft-public", "next-preview-canonical", "next-stale-after-publish"];

function page(url: string, body: string, headers: Record<string, string> = {}) {
  return buildSnapshot([
    { url, status: 200, headers: { "content-type": "text/html", ...headers }, body, ms: 1 },
  ]);
}
const NEXT_HTML =
  '<html><head><script src="/_next/static/chunks/main-1a2b.js"></script></head><body><main>Hi</main></body></html>';

describe("next: unit", () => {
  it("classifying an address as a page or a framework address", () => {
    for (const u of [
      "https://pop.example/_next/static/chunks/main.js",
      "https://pop.example/_next/data/build-7/menu.json",
      "https://pop.example/_next/image?url=%2Fa.png&w=640&q=75",
      "https://pop.example/menu?_rsc=1x2y3",
      "https://pop.example/__nextjs_original-stack-frame",
    ])
      expect(isFrameworkUrl(u), u).toBe(true);
    for (const u of [
      "https://pop.example/menu",
      "https://pop.example/next/steps",
      "https://pop.example/blog?page=2",
    ])
      expect(isFrameworkUrl(u), u).toBe(false);
  });

  it("reading the cache headers", () => {
    expect(readCache({ "x-nextjs-cache": "HIT", age: "900" })).toEqual({
      state: "HIT",
      ageSeconds: 900,
    });
    expect(readCache({ "x-nextjs-cache": "stale", "x-vercel-cache": "STALE" })).toEqual({
      state: "STALE",
    });
    expect(readCache({ "x-vercel-cache": "MISS" })).toEqual({ state: "MISS" });
    // No cache header at all: nothing can be said.
    expect(readCache({})).toEqual({});
  });

  it("a Next.js site is recognised from its headers or, behind a proxy that strips them, its HTML", () => {
    expect(
      isNextSite(page("https://pop.example/", "<html></html>", { "x-powered-by": "Next.js" })),
    ).toBe(true);
    expect(isNextSite(page("https://pop.example/", NEXT_HTML))).toBe(true);
    expect(
      isNextSite(
        page(
          "https://pop.example/",
          '<script id="__NEXT_DATA__" type="application/json">{}</script>',
        ),
      ),
    ).toBe(true);
    expect(isNextSite(page("https://pop.example/", "<html><body>Plain</body></html>"))).toBe(false);
  });

  it("discovery ignores framework addresses, and the summary says how many", () => {
    const links = Array.from(
      { length: 3 },
      (_, i) => `<a href="/_next/data/b/p${i}.json">x</a>`,
    ).join("");
    const p = page("https://pop.example/", `${NEXT_HTML}${links}<a href="/menu">Menu</a>`);
    expect(linkCandidates(p).map((l) => l.url)).toEqual(["https://pop.example/menu"]);
    const budget = createBudget();
    budget.take("frameworkAddresses", ["a", "b", "c"]);
    budget.take("links", ["x"]);
    expect(formatSampleSummary(budget.summary())).toBe("3 framework addresses ignored.");
  });
});

describe("next: integration (the next-like fixture)", () => {
  it("one open draft route, one preview canonical, forty payload addresses ignored", async () => {
    const site = await startFixture("next-like");
    try {
      const { result, budget } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: [...NEXT_CHECKS, "broken-links"],
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        ["next-draft-public", "high", "/api/draft set __prerender_bypass with no secret"],
        [
          "next-preview-canonical",
          "high",
          "canonical https://larkspur-git-main-studio.vercel.app/ is on a preview domain",
        ],
      ]);
      expect(budget.summary().frameworkAddresses.found).toBe(40);
      // The payload addresses were never requested.
      expect([...site.hits.keys()].filter((k) => k.startsWith("/_next/data"))).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("next: edge cases", () => {
  const fetcherFor = (answers: Record<string, Hop[]>, asked: string[] = []) => ({
    get: async (url: string) => {
      asked.push(url);
      return answers[url] ?? [{ url, status: 404, headers: {}, body: "", ms: 1 }];
    },
    getSite: async () => [],
    stats: { requests: 0, maxInFlight: 0 },
  });

  it("a draft route that correctly asks for a secret is not reported", async () => {
    const u = "https://pop.example/api/draft";
    const ctx: CheckContext = {
      warn: () => undefined,
      budget: createBudget(),
      fetcher: fetcherFor({
        [u]: [{ url: u, status: 401, headers: {}, body: "Invalid token", ms: 1 }],
      }),
    };
    expect(await nextDraftPublic.run(page("https://pop.example/", NEXT_HTML), ctx)).toEqual([]);
  });

  it("on a site that isn't Next.js, every check in this branch is unchecked and nothing is requested", async () => {
    const asked: string[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      budget: createBudget(),
      fetcher: fetcherFor({}, asked),
    };
    const plain = page(
      "https://pop.example/",
      '<link rel="canonical" href="https://x.vercel.app/">',
    );
    for (const c of [nextDraftPublic, nextPreviewCanonical, nextStaleAfterPublish])
      expect(await c.run(plain, ctx), c.id).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("stale after publish: unchecked without a content source; with one, a cached copy older than 10 minutes is found", async () => {
    const p = page("https://pop.example/menu", NEXT_HTML, {
      "x-nextjs-cache": "HIT",
      age: "3600",
      date: "Thu, 05 Nov 2026 20:00:00 GMT",
    });
    const now = () => new Date("2026-11-05T20:00:00Z");
    expect(await nextStaleAfterPublish.run(p, { warn: () => undefined, now })).toEqual([]);
    const changed = (minutesAgo: number): CheckContext => ({
      warn: () => undefined,
      now,
      contentChanges: async () => [
        {
          url: "https://pop.example/menu",
          changedAt: new Date(now().getTime() - minutesAgo * 60_000),
        },
      ],
    });
    expect((await nextStaleAfterPublish.run(p, changed(30))).map((f) => f.evidence)).toEqual([
      "/menu is a cached copy (HIT, 60 minutes old) and its document changed 30 minutes ago",
    ]);
    expect(await nextStaleAfterPublish.run(p, changed(5))).toEqual([]);
    // No cache header: nothing can be said.
    const bare = page("https://pop.example/menu", NEXT_HTML);
    expect(await nextStaleAfterPublish.run(bare, changed(30))).toEqual([]);
  });

  it("a rendered-versus-sent finding on a Next.js site says the content arrives after the scripts run", async () => {
    const out = thinHtml.run(page("https://pop.example/", NEXT_HTML), { warn: () => undefined });
    expect((await out)[0]?.evidence).toMatch(
      / On this Next\.js site the content arrives only after the page's scripts run\.$/,
    );
    const plain = thinHtml.run(page("https://pop.example/", "<main>Hi</main>"), {
      warn: () => undefined,
    });
    expect((await plain)[0]?.evidence).not.toMatch(/Next\.js/);
  });
});
