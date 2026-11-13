import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../model.js";
import type { Tracker } from "../../trackers/fingerprints.js";
import type { ContainerRead, Trackers } from "../../trackers/reader.js";
import { analyticsLoadedTwice } from "../analytics-loaded-twice.js";
import { createPageRegistry } from "../index.js";
import { page } from "./helpers.js";

const GTM = "GTM-AB12CD3";
const GA = "G-TEST123456";
const snippet = (id: string) =>
  `(function(w,d,s,l,i){j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','${id}');`;
const withScripts = (...tags: { src?: string; inline?: string }[]) =>
  page({ scriptTags: tags.map((t, position) => ({ ...t, position })) });
const gtagSrc = (id = GA) => ({ src: `https://www.googletagmanager.com/gtag/js?id=${id}` });
const config = (id = GA) => ({ inline: `gtag('config', '${id}');` });

const ga4Tracker = (...ids: string[]): Tracker => ({
  kind: "ga4",
  label: "Google Analytics 4",
  group: "analytics",
  ids,
  how: "script",
});
function trackers(reads: Record<string, ContainerRead>) {
  const asked: string[] = [];
  const t: Trackers = {
    config: {},
    container: async (id) => {
      asked.push(id);
      return reads[id] ?? { ok: false, id, reason: `${id} gave no answer.` };
    },
  };
  return { t, asked };
}
function ctxWith(t?: Trackers) {
  const notes: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (_u, r) => notes.push(r),
    ...(t ? { trackers: t } : {}),
  };
  return { ctx, notes };
}

describe("analytics-loaded-twice: the page's own code", () => {
  it("is a registered page check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("analytics-loaded-twice");
    expect(analyticsLoadedTwice.severity).toBe("high");
  });

  it("a container installed twice is one finding that names it and the count", async () => {
    const { ctx } = ctxWith();
    const found = await analyticsLoadedTwice.run(
      withScripts({ inline: snippet(GTM) }, { inline: snippet(GTM) }),
      ctx,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "analytics-loaded-twice", severity: "high" });
    expect(found[0]?.evidence).toBe(
      "Tag Manager container GTM-AB12CD3 is installed 2 times on this page, so every tag in it can fire twice",
    );
  });

  it("an inline snippet and a gtm.js address for one container count together", async () => {
    const { ctx } = ctxWith();
    const found = await analyticsLoadedTwice.run(
      withScripts(
        { inline: snippet(GTM) },
        { src: `https://www.googletagmanager.com/gtm.js?id=${GTM}` },
      ),
      ctx,
    );
    expect(found[0]?.evidence).toContain("installed 2 times");
  });

  it("two different containers are not a duplicate", async () => {
    const { ctx } = ctxWith();
    expect(
      await analyticsLoadedTwice.run(
        withScripts({ inline: snippet(GTM) }, { inline: snippet("GTM-ZZ99YY8") }),
        ctx,
      ),
    ).toEqual([]);
  });

  it("gtag.js loaded twice, or configured twice, for one measurement id is a finding", async () => {
    const { ctx } = ctxWith();
    const a = await analyticsLoadedTwice.run(withScripts(gtagSrc(), gtagSrc(), config()), ctx);
    expect(a[0]?.evidence).toBe(
      "Google Analytics 4 id G-TEST123456 is loaded by gtag.js 2 times, so each visit can be counted twice",
    );
    const b = await analyticsLoadedTwice.run(withScripts(gtagSrc(), config(), config()), ctx);
    expect(b[0]?.evidence).toBe(
      "Google Analytics 4 id G-TEST123456 is configured 2 times, so each page view is sent twice",
    );
  });

  it("the normal GA4 install (one gtag.js, one config) and a page with no analytics pass", async () => {
    const { ctx } = ctxWith();
    expect(await analyticsLoadedTwice.run(withScripts(gtagSrc(), config()), ctx)).toEqual([]);
    expect(await analyticsLoadedTwice.run(withScripts(), ctx)).toEqual([]);
  });

  it("makes no request without --trackers, and says nothing about containers it cannot read", async () => {
    const { ctx, notes } = ctxWith();
    expect(
      await analyticsLoadedTwice.run(
        withScripts({ inline: snippet(GTM) }, gtagSrc(), config()),
        ctx,
      ),
    ).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("analytics-loaded-twice: GA4 in the page and in the container (--trackers)", () => {
  const both = () => withScripts({ inline: snippet(GTM) }, gtagSrc(), config());

  it("the same measurement id in the page and in the container is a finding", async () => {
    const { t, asked } = trackers({
      [GTM]: { ok: true, id: GTM, trackers: [ga4Tracker(GA)], truncated: false },
    });
    const { ctx } = ctxWith(t);
    const found = await analyticsLoadedTwice.run(both(), ctx);
    expect(asked).toEqual([GTM]);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      "Google Analytics 4 id G-TEST123456 is sent by the page's own gtag code and by Tag Manager container GTM-AB12CD3, so each visit can be counted twice",
    );
  });

  it("a different measurement id in the container is two properties, not a duplicate", async () => {
    const { t } = trackers({
      [GTM]: { ok: true, id: GTM, trackers: [ga4Tracker("G-OTHER00001")], truncated: false },
    });
    const { ctx } = ctxWith(t);
    expect(await analyticsLoadedTwice.run(both(), ctx)).toEqual([]);
  });

  it("a container that cannot be read is could-not-check, never a pass", async () => {
    const { t } = trackers({ [GTM]: { ok: false, id: GTM, reason: `${GTM} answered 404.` } });
    const { ctx, notes } = ctxWith(t);
    expect(await analyticsLoadedTwice.run(both(), ctx)).toEqual([]);
    expect(notes).toEqual([
      "The Tag Manager container GTM-AB12CD3 answered 404. Whether it also sends the page's Google Analytics 4 id was not checked.",
    ]);
  });

  it("a truncated container file is could-not-check unless it already shows the id", async () => {
    const { t } = trackers({ [GTM]: { ok: true, id: GTM, trackers: [], truncated: true } });
    const { ctx, notes } = ctxWith(t);
    expect(await analyticsLoadedTwice.run(both(), ctx)).toEqual([]);
    expect(notes[0]).toContain("longer than Gaugeline reads");
  });

  it("reads nothing when the page has no hard-coded GA4 or no container, and at most three containers", async () => {
    const none = trackers({});
    await analyticsLoadedTwice.run(withScripts({ inline: snippet(GTM) }), ctxWith(none.t).ctx);
    await analyticsLoadedTwice.run(withScripts(gtagSrc(), config()), ctxWith(none.t).ctx);
    expect(none.asked).toEqual([]);
    const many = trackers({});
    await analyticsLoadedTwice.run(
      withScripts(
        gtagSrc(),
        ...["GTM-AAAA111", "GTM-BBBB222", "GTM-CCCC333", "GTM-DDDD444"].map((id) => ({
          inline: snippet(id),
        })),
      ),
      ctxWith(many.t).ctx,
    );
    expect(many.asked).toEqual(["GTM-AAAA111", "GTM-BBBB222", "GTM-CCCC333"]);
  });
});
