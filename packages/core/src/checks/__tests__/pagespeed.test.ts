import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { createPageSpeed, type PageSpeed } from "../../pagespeed/reader.js";
import { addPageSpeedChecks } from "../../pagespeed/registry.js";
import {
  answer,
  pageSpeedTransport,
  type AnswerOptions,
  type Reply,
} from "../../pagespeed/__tests__/world.js";
import { createPageRegistry } from "../index.js";
import { PAGESPEED_CHECKS, pagespeedFieldVitals, pagespeedLabAdvice } from "../pagespeed.js";
import { page } from "./helpers.js";

const HOME = "https://bakery.example/";
const MENU = "https://bakery.example/menu";
const GOOD = [0.9, 0.05, 0.05] as const;
const ALL_GOOD = { lcp: GOOD, inp: GOOD, cls: GOOD };

const ok = (url: string, o: AnswerOptions): Reply => ({ status: 200, body: answer(url, o) });

function setup(replies: Record<string, Reply>, others: string[] = []) {
  const world = pageSpeedTransport(replies);
  const pageSpeed: PageSpeed = createPageSpeed(createFetcher({ transport: world.transport }));
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    pageSpeed,
    pages: () => Promise.resolve(others.map((u) => page({ finalUrl: u }))),
  };
  return { ctx, notes, seen: world.seen };
}
const home = () => page({ finalUrl: HOME });

describe("the PageSpeed checks: unit", () => {
  it("there are two, one for real visitors and one for the lab, and both say what they catch", () => {
    expect(PAGESPEED_CHECKS.map((c) => [c.id, c.severity])).toEqual([
      ["pagespeed-field-vitals", "medium"],
      ["pagespeed-lab-advice", "low"],
    ]);
    for (const c of PAGESPEED_CHECKS) expect(c.what && c.why && c.fix && c.tech).toBeTruthy();
  });

  it("do nothing without --pagespeed: no finding, no note, no request", async () => {
    const notes: string[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      couldNotCheck: (_u, r) => void notes.push(r),
    };
    expect(await pagespeedFieldVitals.run(home(), ctx)).toEqual([]);
    expect(await pagespeedLabAdvice.run(home(), ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("are not in the default registry, only added for --pagespeed", () => {
    const base = createPageRegistry();
    expect(base.has("pagespeed-field-vitals")).toBe(false);
    addPageSpeedChecks(base);
    expect(base.has("pagespeed-field-vitals")).toBe(true);
    expect(base.has("pagespeed-lab-advice")).toBe(true);
    // Adding twice leaves one of each.
    addPageSpeedChecks(base);
    expect(base.all().filter((c) => c.id.startsWith("pagespeed-"))).toHaveLength(2);
  });
});

describe("pagespeed-field-vitals: real visitors decide", () => {
  it("passes (no finding, no note) when all three vitals are good for real visitors", async () => {
    const { ctx, notes } = setup({ [HOME]: ok(HOME, { field: ALL_GOOD, lab: { score: 0.3 } }) });
    expect(await pagespeedFieldVitals.run(home(), ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("a bad lab score never fails a page whose real visitors are fine", async () => {
    const { ctx } = setup({
      [HOME]: ok(HOME, { field: ALL_GOOD, lab: { score: 0.05, lcp: 12000 } }),
    });
    expect(await pagespeedFieldVitals.run(home(), ctx)).toEqual([]);
  });

  it("a good lab score does not excuse real visitors who suffer", async () => {
    const { ctx } = setup({
      [HOME]: ok(HOME, {
        field: { lcp: [0.4, 0.2, 0.4], inp: GOOD, cls: GOOD },
        lab: { score: 0.99 },
      }),
    });
    const out = await pagespeedFieldVitals.run(home(), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("medium");
  });

  it("reports each vital that is not good, with the share of loads, and says it is real-user data", async () => {
    const { ctx } = setup({
      [HOME]: ok(HOME, {
        field: { lcp: [0.62, 0.22, 0.16], inp: [0.5, 0.15, 0.35], cls: [0.7, 0.2, 0.1] },
      }),
    });
    const out = await pagespeedFieldVitals.run(home(), ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        "Real visitors (Chrome, 75th percentile), https://bakery.example/: Largest Contentful Paint needs improvement. 62% of loads were 2.5 s or faster; 75% are needed. 16% took longer than 4 s.",
      ],
      [
        "medium",
        "Real visitors (Chrome, 75th percentile), https://bakery.example/: Interaction to Next Paint is poor. 50% of loads were 200 ms or faster; 75% are needed. 35% took longer than 500 ms.",
      ],
      [
        "low",
        "Real visitors (Chrome, 75th percentile), https://bakery.example/: Cumulative Layout Shift needs improvement. 70% of loads were 0.1 or lower; 75% are needed. 10% were worse than 0.25.",
      ],
    ]);
    expect(out.every((f) => f.checkId === "pagespeed-field-vitals" && f.url === HOME)).toBe(true);
  });

  it("says when the figures are the whole site's because the page has too few visitors", async () => {
    const { ctx } = setup({
      [HOME]: ok(HOME, { fallback: true, origin: { lcp: [0.4, 0.2, 0.4], inp: GOOD, cls: GOOD } }),
    });
    const out = await pagespeedFieldVitals.run(home(), ctx);
    expect(out[0]?.evidence).toContain(
      "the whole site's visitors, because this page has too few of its own",
    );
  });

  it("no real-user data is could-not-check, never a pass, even with a perfect lab score", async () => {
    const { ctx, notes } = setup({ [HOME]: ok(HOME, { lab: { score: 1 } }) });
    expect(await pagespeedFieldVitals.run(home(), ctx)).toEqual([]);
    expect(notes).toEqual([{ url: HOME, reason: expect.stringContaining("no real-user data") }]);
  });

  it("a vital Google does not report is could-not-check; the vitals it does report are still judged", async () => {
    const { ctx, notes } = setup({
      [HOME]: ok(HOME, { field: { lcp: [0.4, 0.2, 0.4], cls: GOOD } }),
    });
    const out = await pagespeedFieldVitals.run(home(), ctx);
    expect(out).toHaveLength(1);
    expect(notes).toEqual([
      { url: HOME, reason: expect.stringContaining("no Interaction to Next Paint") },
    ]);
  });

  it("a failed read (quota used up, page not loadable) is could-not-check with the reason", async () => {
    const { ctx, notes } = setup({ [HOME]: { status: 429, body: {} } });
    expect(await pagespeedFieldVitals.run(home(), ctx)).toEqual([]);
    expect(notes).toEqual([{ url: HOME, reason: expect.stringContaining("quota is used up") }]);
  });

  it("a private address is never sent, and is could-not-check", async () => {
    const { ctx, notes, seen } = setup({});
    expect(
      await pagespeedFieldVitals.run(page({ finalUrl: "http://127.0.0.1:4100/" }), ctx),
    ).toEqual([]);
    expect(seen).toEqual([]);
    expect(notes[0]?.reason).toContain("not one");
  });

  it("reads the checked page and the next pages of the sample, at most five, and says how many it left out", async () => {
    const urls = [1, 2, 3, 4, 5, 6, 7].map((n) => `https://bakery.example/p${n}`);
    const replies = Object.fromEntries(urls.map((u) => [u, ok(u, { field: ALL_GOOD })]));
    const { ctx, notes, seen } = setup({ [HOME]: ok(HOME, { field: ALL_GOOD }), ...replies }, [
      HOME,
      ...urls,
    ]);
    await pagespeedFieldVitals.run(home(), ctx);
    expect(seen).toHaveLength(5);
    expect(seen.map((s) => new URL(s.url).searchParams.get("url"))).toEqual([
      HOME,
      ...urls.slice(0, 4),
    ]);
    expect(notes).toEqual([
      {
        url: HOME,
        reason: expect.stringContaining("3 more pages were not sent to Google: at most 5"),
      },
    ]);
  });

  it("a second page with a poor vital is its own finding on its own address", async () => {
    const { ctx } = setup(
      {
        [HOME]: ok(HOME, { field: ALL_GOOD }),
        [MENU]: ok(MENU, { field: { lcp: [0.2, 0.2, 0.6], inp: GOOD, cls: GOOD } }),
      },
      [MENU],
    );
    const out = await pagespeedFieldVitals.run(home(), ctx);
    expect(out.map((f) => f.url)).toEqual([MENU]);
  });

  it("gives the same findings for the same answers", async () => {
    const replies = { [HOME]: ok(HOME, { field: { lcp: [0.4, 0.2, 0.4], inp: GOOD, cls: GOOD } }) };
    const a = await pagespeedFieldVitals.run(home(), setup(replies).ctx);
    const b = await pagespeedFieldVitals.run(home(), setup(replies).ctx);
    expect(a).toEqual(b);
  });
});

describe("pagespeed-lab-advice: a simulated phone, advice only", () => {
  it("says it is a lab run, not real visitors, and gives the numbers", async () => {
    const { ctx } = setup({
      [HOME]: ok(HOME, {
        field: ALL_GOOD,
        lab: { score: 0.42, lcp: 4210, tbt: 610, cls: 0.123, si: 5100 },
      }),
    });
    const out = await pagespeedLabAdvice.run(home(), ctx);
    expect(out).toEqual([
      {
        checkId: "pagespeed-lab-advice",
        severity: "low",
        title: pagespeedLabAdvice.title,
        evidence:
          "Lab run, not real visitors: Lighthouse on Google's servers scored https://bakery.example/ 42 out of 100 on a simulated phone (largest contentful paint 4.2 s, total blocking time 610 ms, layout shift 0.123, speed index 5.1 s). Advice only: one simulated load never passes or fails a page.",
        url: HOME,
      },
    ]);
  });

  it("is quiet for a score of 90 or more", async () => {
    const { ctx, notes } = setup({ [HOME]: ok(HOME, { lab: { score: 0.9 } }) });
    expect(await pagespeedLabAdvice.run(home(), ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("no Lighthouse run in the answer is could-not-check; a failed read is left to the field check", async () => {
    const a = setup({ [HOME]: ok(HOME, { field: ALL_GOOD }) });
    expect(await pagespeedLabAdvice.run(home(), a.ctx)).toEqual([]);
    expect(a.notes).toEqual([{ url: HOME, reason: expect.stringContaining("no Lighthouse run") }]);
    const b = setup({ [HOME]: { status: 429, body: {} } });
    expect(await pagespeedLabAdvice.run(home(), b.ctx)).toEqual([]);
    expect(b.notes).toEqual([]);
  });

  it("the two checks share one request per page", async () => {
    const { ctx, seen } = setup({ [HOME]: ok(HOME, { field: ALL_GOOD, lab: { score: 0.4 } }) });
    await Promise.all([pagespeedFieldVitals.run(home(), ctx), pagespeedLabAdvice.run(home(), ctx)]);
    expect(seen).toHaveLength(1);
  });
});
