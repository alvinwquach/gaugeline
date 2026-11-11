import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext, Finding } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { copyDatePassed } from "../copy-date-passed.js";
import { copyrightStale } from "../copyright-stale.js";
import { PAGE_CHECKS } from "../index.js";

const NOV12 = new Date("2026-11-12T15:00:00Z");
const at = (iso: string): CheckContext => ({ warn: () => undefined, now: () => new Date(iso) });
const ctx = at("2026-11-12T15:00:00Z");

function snap(body: string, head = "", url = "https://bar.example/", truncated = false) {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html lang="en"><head><title>Pelican Tap</title>${head}</head><body>${body}</body></html>`,
      ms: 1,
      ...(truncated ? { truncated: true } : {}),
    },
  ]);
}
const run = async (body: string, c: CheckContext = ctx, head = "") =>
  (await copyDatePassed.run(snap(body, head), c)) as Finding[];

describe("copy-date-passed: unit", () => {
  it("flags a past promotion with the sentence, the date and the page", async () => {
    const [f, ...rest] = await run("<p>Halloween special through Oct 31</p>");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      checkId: "copy-date-passed",
      severity: "medium",
      url: "https://bar.example/",
    });
    expect(f?.evidence).toBe('"Halloween special through Oct 31" ended 2026-10-31');
  });
  it("is registered, deterministic and uses the run's clock", async () => {
    expect(PAGE_CHECKS).toContain(copyDatePassed);
    expect(
      await run("<p>Halloween special through Oct 31</p>", at("2026-10-20T10:00:00Z")),
    ).toEqual([]);
    const a = await run("<p>Halloween special through Oct 31</p>");
    expect(await run("<p>Halloween special through Oct 31</p>")).toEqual(a);
  });
  it("reads today in the venue's time zone", async () => {
    // 04:00 UTC on 2 Nov is still 1 Nov in Los Angeles: an offer ending 31 Oct is 1 day old (inside the grace).
    const body = "<p>Halloween special through Oct 31</p>";
    const la = { ...at("2026-11-02T04:00:00Z"), expect: { timeZone: "America/Los_Angeles" } };
    expect(await run(body, la)).toEqual([]);
    // The same instant in UTC is already 2 Nov: two days old, so it is flagged.
    expect(await run(body, at("2026-11-02T04:00:00Z"))).toHaveLength(1);
    expect(await run(body, { ...la, now: () => new Date("2026-11-03T04:00:00Z") })).toHaveLength(1);
  });
  it("handles the leap day", async () => {
    const body = "<p>Leap day special until Feb 29</p>";
    expect(await run(body, at("2028-03-05T12:00:00Z"))).toHaveLength(1);
    expect(await run(body, at("2028-02-20T12:00:00Z"))).toHaveLength(0);
  });
  it("does not flag dates in historic pages", async () => {
    const post =
      '<script type="application/ld+json">{"@type":"NewsArticle","headline":"x"}</script>';
    expect(await run("<p>Halloween special through Oct 31</p>", ctx, post)).toEqual([]);
    expect(
      await run(
        "<p>Halloween special through Oct 31</p>",
        ctx,
        '<meta property="og:type" content="article">',
      ),
    ).toEqual([]);
    const c = { ...ctx, staleDates: { historic: ["/**"] } };
    expect(await run("<p>Halloween special through Oct 31</p>", c)).toEqual([]);
  });
  it("does not flag a published date in a <time> or an <article>", async () => {
    expect(
      await run(
        '<p>Offer menu <time itemprop="datePublished" datetime="2025-10-31">Oct 31, 2025</time></p>',
      ),
    ).toEqual([]);
    expect(
      await run(
        '<article><p>Our menu <time datetime="2025-10-31">Oct 31, 2025</time></p></article>',
      ),
    ).toEqual([]);
  });
  it("reads only visible text", async () => {
    for (const body of [
      '<img src="a.png" alt="Happy hour through Oct 31">',
      '<a title="Happy hour through Oct 31" href="/">Menu</a>',
      "<script>var a='Happy hour through Oct 31'</script>",
      "<!-- Happy hour through Oct 31 -->",
      "<div hidden>Happy hour through Oct 31</div>",
      '<div style="display:none">Happy hour through Oct 31</div>',
      "<noscript>Happy hour through Oct 31</noscript>",
    ])
      expect(await run(body), body).toEqual([]);
  });
  it("honours graceDays and ignore from the config", async () => {
    const body = "<p>Weekend special ends Nov 10</p>";
    expect(await run(body, { ...ctx, staleDates: { graceDays: 2 } })).toEqual([]);
    expect(await run(body, { ...ctx, staleDates: { ignore: ["WEEKEND SPECIAL"] } })).toEqual([]);
    expect(await run(body)).toHaveLength(1);
  });
  it("reads the site's other languages", async () => {
    const body = "<p>Oferta de la casa hasta el 31 de octubre</p>";
    expect(await run(body)).toEqual([]);
    const es = snap(body).hops;
    const page = buildSnapshot(
      es.map((h) => ({ ...h, body: h.body?.replace('lang="en"', 'lang="es"') })),
    );
    expect(await copyDatePassed.run(page, ctx)).toHaveLength(1);
    const viaRules = { ...ctx, languageRules: { prefixes: { en: "/", es: "/es/" } } };
    expect(await run(body, viaRules)).toHaveLength(1);
  });
  it("says it could not check a page that was cut at the size limit", async () => {
    const asked: string[] = [];
    const c = { ...ctx, couldNotCheck: (_u: string, reason: string) => void asked.push(reason) };
    const page = snap("<p>Halloween special through Oct 31</p>", "", "https://bar.example/", true);
    expect(await copyDatePassed.run(page, c)).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("size limit");
  });
  it("is quick and safe on a hostile 4 MB page", async () => {
    const body = `<p>${"Oct 31 ".repeat(300_000)}\uD800 ${"1".repeat(1_000_000)}</p><p>Halloween special through Oct 31</p>`;
    const t = Date.now();
    await run(body);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it("caps the findings for one page", async () => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `<p>Special number ${i} ends Oct ${(i % 28) + 1}</p>`,
    ).join("");
    expect((await run(body)).length).toBeLessThanOrEqual(10);
  });
});

describe("copyright-stale: unit", () => {
  const foot = async (html: string, c: CheckContext = ctx) =>
    (await copyrightStale.run(snap(html), c)) as Finding[];
  it("flags an old footer year once, with the years", async () => {
    const out = await foot("<footer>\u00A9 2019-2023 Harbour Physio</footer>");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ checkId: "copyright-stale", severity: "low" });
    expect(out[0]?.evidence).toBe('the footer says "\u00A9 2019-2023"');
  });
  it("is quiet for the current year, a later year and a page with no notice", async () => {
    expect(await foot("<footer>\u00A9 2026 Harbour Physio</footer>")).toEqual([]);
    expect(await foot("<footer>Copyright 2019 - 2026 Harbour Physio</footer>")).toEqual([]);
    expect(await foot("<footer>\u00A9 2023 Harbour. Photos \u00A9 2026 Jo</footer>")).toEqual([]);
    expect(await foot("<footer>Open weekdays</footer>")).toEqual([]);
    expect(
      await foot("<main>\u00A9 2023 in the middle of a page</main><footer>Open weekdays</footer>"),
    ).toEqual([]);
  });
  it("gives New Year a grace period", async () => {
    const html = "<footer>\u00A9 2025 Harbour Physio</footer>";
    expect(await foot(html, at("2026-01-01T12:00:00Z"))).toEqual([]);
    expect(await foot(html, at("2026-01-02T12:00:00Z"))).toEqual([]);
    expect(await foot(html, at("2026-01-03T12:00:00Z"))).toHaveLength(1);
    expect(await foot("<footer>\u00A9 2024 H</footer>", at("2026-01-01T12:00:00Z"))).toHaveLength(
      1,
    );
  });
  it("uses the venue's zone for the year", async () => {
    const html = "<footer>\u00A9 2025 H</footer>";
    const nz = { ...at("2026-12-31T20:00:00Z"), expect: { timeZone: "Pacific/Auckland" } };
    expect(await foot(html, at("2026-12-31T20:00:00Z"))).toHaveLength(1);
    expect(await foot("<footer>\u00A9 2026 H</footer>", nz)).toEqual([]);
  });
  it("still judges the footer year on an article page: it is about the site", async () => {
    const out = (await copyrightStale.run(
      snap("<footer>\u00A9 2023 H</footer>", '<meta property="og:type" content="article">'),
      ctx,
    )) as Finding[];
    expect(out).toHaveLength(1);
  });
});

describe("integration: the fixture sites", () => {
  it("a bar's home page with a Halloween special on a run dated 12 Nov gives one warning", async () => {
    const site = await startFixture("copy-date-passed");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["copy-date-passed", "copyright-stale"],
        now: () => NOV12,
      });
      expect(result.findings.map((f) => f.checkId)).toEqual(["copy-date-passed"]);
      expect(result.findings[0]?.evidence).toContain("Halloween special through Oct 31");
      expect(site.requests.every((l) => l.method === "GET" || l.method === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });
  it("a blog post dated last year gives nothing", async () => {
    const site = await startFixture("copy-date-passed");
    try {
      const { result } = await checkSite({
        address: `${site.origin}/clean.html`,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["copy-date-passed", "copyright-stale"],
        now: () => NOV12,
      });
      expect(result.findings).toEqual([]);
    } finally {
      await site.close();
    }
  });
  it("a footer (c) 2023 on a run in 2026 gives one info finding", async () => {
    const site = await startFixture("copyright-stale");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["copy-date-passed", "copyright-stale"],
        now: () => NOV12,
      });
      expect(result.findings.map((f) => [f.checkId, f.severity])).toEqual([
        ["copyright-stale", "low"],
      ]);
    } finally {
      await site.close();
    }
  });
});
