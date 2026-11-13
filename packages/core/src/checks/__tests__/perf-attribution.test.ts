import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../model.js";
import { addAttributionChecks } from "../../render/attribution-registry.js";
import type { RenderRequest, RenderResult, RenderedPage } from "../../render/types.js";
import { emptyBlocked } from "../../render/types.js";
import { createPageRegistry } from "../index.js";
import { ATTRIBUTION_CHECKS, perfAttribution } from "../perf-attribution.js";
import { page } from "./helpers.js";

const HOME = "https://quillfeather.example/";
const STORY = "An invented bakery, baking its bread at dawn. ".repeat(10);

const rendered = (
  perf: { lcpMs?: number; tbtMs?: number; scriptsRefused?: number },
  text = STORY,
): RenderedPage => ({
  kind: "rendered",
  finalUrl: HOME,
  status: 200,
  title: "Quillfeather" as never,
  text: text as never,
  requests: [],
  blocked: emptyBlocked(),
  totals: { requests: 1, bytes: 1 },
  truncated: [],
  performance: { scriptsRefused: 0, ...perf },
});

type Answer = RenderResult | ((o: Pick<RenderRequest, "variant" | "measure">) => RenderResult);

function setup(answers: { base?: Answer[]; variants?: Record<string, Answer> }, noRender = false) {
  const asked: Pick<RenderRequest, "variant" | "measure">[] = [];
  const notes: { url: string; reason: string }[] = [];
  const base = answers.base ?? [
    rendered({ lcpMs: 1550, tbtMs: 750 }),
    rendered({ lcpMs: 1580, tbtMs: 760 }),
  ];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(noRender
      ? {}
      : {
          render: (o = {}) => {
            asked.push({ variant: o.variant, measure: o.measure } as never);
            const v = o.variant;
            const key = !v
              ? undefined
              : v.reducedMotion
                ? "reduced-motion"
                : v.javaScript === false
                  ? "no-javascript"
                  : "no-third-party";
            const ans = key ? answers.variants?.[key] : base[o.measure?.sample ?? 0];
            const out = typeof ans === "function" ? ans(o) : ans;
            return Promise.resolve(
              out ??
                ({ kind: "could-not-check", reason: "no answer in this test" } as RenderResult),
            );
          },
        }),
  };
  return { ctx, notes, asked };
}
const home = () => page({ finalUrl: HOME });

describe("perf-attribution: unit", () => {
  it("is one low-severity check, not in the default registry, added for --attribution", () => {
    expect(ATTRIBUTION_CHECKS.map((c) => [c.id, c.severity])).toEqual([
      ["perf-attribution", "low"],
    ]);
    expect(
      perfAttribution.what && perfAttribution.why && perfAttribution.fix && perfAttribution.tech,
    ).toBeTruthy();
    const reg = createPageRegistry();
    expect(reg.has("perf-attribution")).toBe(false);
    addAttributionChecks(reg);
    addAttributionChecks(reg);
    expect(reg.all().filter((c) => c.id === "perf-attribution")).toHaveLength(1);
  });

  it("says it needs a renderer when there is none, and loads nothing", async () => {
    const { ctx, notes } = setup({}, true);
    expect(await perfAttribution.run(home(), ctx)).toEqual([]);
    expect(notes).toEqual([
      { url: HOME, reason: expect.stringContaining("--renderer playwright") },
    ]);
  });

  it("loads the page twice as it is, then once with each change, one after the other, measured", async () => {
    const { ctx, asked } = setup({
      variants: {
        "reduced-motion": rendered({ lcpMs: 1500, tbtMs: 750 }),
        "no-javascript": rendered({ lcpMs: 1500 }),
        "no-third-party": rendered({ lcpMs: 1500, tbtMs: 750 }),
      },
    });
    await perfAttribution.run(home(), ctx);
    expect(asked).toEqual([
      { measure: { sample: 0 } },
      { measure: { sample: 1 } },
      { variant: { reducedMotion: true }, measure: { sample: 0 } },
      { variant: { javaScript: false }, measure: { sample: 0 } },
      { variant: { blockThirdPartyScripts: true }, measure: { sample: 0 } },
    ]);
  });

  it("reports which change moves which number, and by how much, as low-severity advice", async () => {
    const { ctx } = setup({
      variants: {
        "reduced-motion": rendered({ lcpMs: 900, tbtMs: 760 }),
        "no-javascript": rendered({ lcpMs: 120 }),
        "no-third-party": rendered({ lcpMs: 1560, tbtMs: 40, scriptsRefused: 1 }),
      },
    });
    const out = await perfAttribution.run(home(), ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        "With reduced motion forced, Largest Contentful Paint went from 1565 ms to 900 ms (665 ms faster; the two plain loads differed by 30 ms). Measured in this computer's browser, unthrottled: compare the changes with each other, not with Lighthouse.",
      ],
      [
        "low",
        "With JavaScript off, Largest Contentful Paint went from 1565 ms to 120 ms (1445 ms faster; the two plain loads differed by 30 ms). Measured in this computer's browser, unthrottled: compare the changes with each other, not with Lighthouse.",
      ],
      [
        "low",
        "With scripts from other sites blocked, total blocking time went from 755 ms to 40 ms (715 ms faster; the two plain loads differed by 10 ms). Measured in this computer's browser, unthrottled: compare the changes with each other, not with Lighthouse.",
      ],
    ]);
    for (const f of out) expect(f.checkId).toBe("perf-attribution");
  });

  it("is quiet when nothing moves more than the page's own spread", async () => {
    const { ctx, notes } = setup({
      variants: {
        "reduced-motion": rendered({ lcpMs: 1570, tbtMs: 770 }),
        "no-javascript": rendered({ lcpMs: 1600 }),
        "no-third-party": rendered({ lcpMs: 1540, tbtMs: 700 }),
      },
    });
    expect(await perfAttribution.run(home(), ctx)).toEqual([]);
    // Speed Index is the one thing it says it did not measure.
    expect(notes.map((n) => n.reason)).toEqual([
      expect.stringContaining("Total blocking time is not measured with JavaScript off"),
      expect.stringContaining("Speed Index"),
    ]);
  });

  it("says a change for the worse too", async () => {
    const { ctx } = setup({
      variants: {
        "reduced-motion": rendered({ lcpMs: 1550, tbtMs: 750 }),
        "no-javascript": rendered({ lcpMs: 2900 }),
        "no-third-party": rendered({ lcpMs: 1550, tbtMs: 750 }),
      },
    });
    const out = await perfAttribution.run(home(), ctx);
    expect(out.some((f) => f.evidence.includes("2900 ms (1335 ms slower"))).toBe(true);
  });

  it("does not compare a page that shows much less without JavaScript: the timings are not like for like", async () => {
    const { ctx, notes } = setup({
      variants: {
        "reduced-motion": rendered({ lcpMs: 1550, tbtMs: 750 }),
        "no-javascript": rendered({ lcpMs: 100 }, "Loading..."),
        "no-third-party": rendered({ lcpMs: 1550, tbtMs: 750 }),
      },
    });
    const out = await perfAttribution.run(home(), ctx);
    expect(out.filter((f) => f.evidence.includes("JavaScript off"))).toEqual([]);
    expect(notes.some((n) => /shows much less without JavaScript/.test(n.reason))).toBe(true);
  });

  it("a load that could not be made is could-not-check for that change, and the others are still compared", async () => {
    const { ctx, notes } = setup({
      variants: {
        "reduced-motion": {
          kind: "could-not-check",
          reason: "the page took longer than the time cap allows",
        },
        "no-javascript": rendered({ lcpMs: 120 }),
        "no-third-party": rendered({ lcpMs: 1550, tbtMs: 40 }),
      },
    });
    const out = await perfAttribution.run(home(), ctx);
    expect(out.length).toBeGreaterThan(0);
    expect(
      notes.some((n) => n.reason.includes("reduced motion") && n.reason.includes("time cap")),
    ).toBe(true);
  });

  it("a baseline that could not be made, or has no timings, is could-not-check and nothing else is loaded", async () => {
    const a = setup({ base: [{ kind: "could-not-check", reason: "no browser" } as RenderResult] });
    expect(await perfAttribution.run(home(), a.ctx)).toEqual([]);
    expect(a.notes).toEqual([{ url: HOME, reason: expect.stringContaining("no browser") }]);
    expect(a.asked).toHaveLength(1);
    const noTimings = { ...rendered({}), performance: undefined } as RenderedPage;
    const b = setup({ base: [noTimings, noTimings] });
    expect(await perfAttribution.run(home(), b.ctx)).toEqual([]);
    expect(b.notes[0]?.reason).toContain("timings");
    expect(b.asked).toHaveLength(1);
  });

  it("a number the page never produced (no Largest Contentful Paint) is not guessed", async () => {
    const { ctx, notes } = setup({
      base: [rendered({ tbtMs: 750 }), rendered({ tbtMs: 760 })],
      variants: {
        "reduced-motion": rendered({ lcpMs: 100, tbtMs: 750 }),
        "no-javascript": rendered({ lcpMs: 100 }),
        "no-third-party": rendered({ lcpMs: 100, tbtMs: 40 }),
      },
    });
    const out = await perfAttribution.run(home(), ctx);
    expect(out.every((f) => f.evidence.includes("total blocking time"))).toBe(true);
    expect(notes.some((n) => n.reason.includes("Largest Contentful Paint"))).toBe(true);
  });

  it("gives the same findings for the same loads", async () => {
    const variants = { "no-third-party": rendered({ lcpMs: 1550, tbtMs: 40 }) };
    const a = await perfAttribution.run(home(), setup({ variants }).ctx);
    const b = await perfAttribution.run(home(), setup({ variants }).ctx);
    expect(a).toEqual(b);
  });

  it("never reports blocking time for the JavaScript-off load, even a huge drop, and says it is not measured", async () => {
    const { ctx, notes } = setup({
      base: [rendered({ lcpMs: 1550, tbtMs: 5000 }), rendered({ lcpMs: 1550, tbtMs: 5000 })],
      variants: {
        "reduced-motion": rendered({ lcpMs: 1550, tbtMs: 5000 }),
        "no-javascript": rendered({ lcpMs: 1550 }),
        "no-third-party": rendered({ lcpMs: 1550, tbtMs: 5000 }),
      },
    });
    const out = await perfAttribution.run(home(), ctx);
    expect(out).toEqual([]);
    expect(notes.some((n) => /not measured with JavaScript off/.test(n.reason))).toBe(true);
    // And it is not also reported as a missing number: said once.
    expect(notes.filter((n) => /Total blocking time/.test(n.reason))).toHaveLength(1);
  });
});
