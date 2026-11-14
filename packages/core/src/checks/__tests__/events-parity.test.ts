import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import {
  NO_OBSERVER,
  lazyEvents,
  recordedObserver,
  type EventObserver,
  type ObserveResult,
  type ObservedClick,
} from "../../events/observe.js";
import { eventsConfigSchema, type EventsConfig } from "../../events/types.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { eventsParity } from "../events-parity.js";

const config = eventsConfigSchema.parse({
  events: [{ selector: "a.track", event: "menu_click", params: ["link_text", "link_url"] }],
});
const html = `<body><a class="track" href="/a">A</a><a class="track" href="/b">B</a></body>`;
const A = "body > a:nth-of-type(1)";
const B = "body > a:nth-of-type(2)";

const sent = (path: string, data: Record<string, unknown>, atMs = 40): ObservedClick => ({
  path,
  pushes: [{ atMs, data }],
  blocked: [],
});
const ev = (text: string, url: string) => ({ event: "menu_click", link_text: text, link_url: url });
const page = () =>
  buildSnapshot([
    {
      url: "https://florist.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: html,
      ms: 1,
    },
  ]);

function ctxFor(observer?: EventObserver, plan: EventsConfig = config) {
  const p = page();
  const unchecked: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    eventsConfig: plan,
    events: lazyEvents({ page: p, config: plan, ...(observer ? { observer } : {}) }),
    couldNotCheck: (_url, reason) => unchecked.push(reason),
  };
  return { p, ctx, unchecked };
}
const run = async (result: ObserveResult) => {
  const { p, ctx, unchecked } = ctxFor(recordedObserver(result));
  return { findings: await eventsParity.run(p, ctx), unchecked };
};

describe("events-parity: unit", () => {
  it("names the link, both widths and what differs", async () => {
    const { findings, unchecked } = await run({
      clicks: [sent(A, ev("A", "/a")), sent(B, ev("B", "/b"))],
      phone: [sent(A, ev("A", "/a")), { path: B, pushes: [], blocked: [] }],
    });
    expect(findings).toEqual([
      {
        checkId: "events-parity",
        severity: "medium",
        title: eventsParity.title,
        evidence:
          '"B" (/b) reports differently at 375 px than at 1280 px: sent menu_click at 1280 px and nothing at 375 px',
        url: "https://florist.example/",
      },
    ]);
    expect(unchecked).toEqual([]);
  });

  it("joins what differs, a few at most", async () => {
    const { findings } = await run({
      clicks: [
        sent(A, {
          ...ev("A", "/a"),
          a1: "1",
          a2: "1",
          a3: "1",
          a4: "1",
          a5: "1",
          a6: "1",
          a7: "1",
        }),
      ],
      phone: [sent(A, { event: "menu_click", link_text: "", link_url: 3 })],
    });
    const text = findings[0]?.evidence ?? "";
    expect(text).toContain(
      "link_text is filled at 1280 px and empty at 375 px; link_url is text at 1280 px and a number at 375 px; a1 is sent at 1280 px and not at 375 px",
    );
    // At most six differences are written out, the rest are counted.
    expect(text).toMatch(/; and 3 more$/);
  });

  it("is a pass when both widths report the same: nothing is found and nothing is could not check", async () => {
    const { findings, unchecked } = await run({
      clicks: [sent(A, ev("A", "/a")), sent(B, ev("B", "/b"))],
      phone: [sent(A, ev("A", "/a")), sent(B, ev("B", "/b"))],
    });
    expect(findings).toEqual([]);
    expect(unchecked).toEqual([]);
  });

  it("a link silent on both widths is events-fire's: not a difference", async () => {
    const quiet: ObservedClick = { path: A, pushes: [], blocked: [] };
    const { findings } = await run({ clicks: [quiet], phone: [quiet] });
    expect(findings).toEqual([]);
  });

  it("without a phone read it is could not check with the observer's reason, never a pass", async () => {
    const { findings, unchecked } = await run({
      clicks: [sent(A, ev("A", "/a"))],
      phoneUnchecked: "the page did not load at 375 px: timeout",
    });
    expect(findings).toEqual([]);
    expect(unchecked).toEqual(["the page did not load at 375 px: timeout"]);
  });

  it("a read with no phone and no reason still says so", async () => {
    const { unchecked } = await run({ clicks: [sent(A, ev("A", "/a"))] });
    expect(unchecked).toEqual(["the plan's links were not read at 375 px"]);
  });

  it("a link not read at both widths is could not check, with the width and the reason", async () => {
    const { findings, unchecked } = await run({
      clicks: [sent(A, ev("A", "/a")), sent(B, ev("B", "/b"))],
      phone: [
        sent(A, ev("A", "/a")),
        { path: B, pushes: [], blocked: [], unobserved: "it is not visible at 375 px" },
      ],
    });
    expect(findings).toEqual([]);
    expect(unchecked).toEqual([
      `1 of the plan's links could not be compared at both widths ("B" (/b) at 375 px: it is not visible at 375 px)`,
    ]);
  });

  it("when no link could be compared at all it is could not check, not a pass", async () => {
    const gone = (path: string): ObservedClick => ({
      path,
      pushes: [],
      blocked: [],
      unobserved: "it is inside a form",
    });
    const { unchecked } = await run({
      clicks: [gone(A), gone(B)],
      phone: [gone(A), gone(B)],
    });
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toMatch(/^2 of the plan's links could not be compared at both widths/);
  });

  it("an observer that could not read the page makes it could not check, with its reason", async () => {
    const { findings, unchecked } = await run({ unchecked: "no browser" });
    expect(findings).toEqual([]);
    expect(unchecked).toEqual(["no browser"]);
  });

  it("no observer (no rendered read) is could not check", async () => {
    const { p, ctx, unchecked } = ctxFor();
    expect(await eventsParity.run(p, ctx)).toEqual([]);
    expect(unchecked).toEqual([NO_OBSERVER]);
  });

  it("a plan with only attribute rules has no click to compare", async () => {
    const attrs = eventsConfigSchema.parse({
      attributes: [{ region: "nav", require: ["data-t"] }],
    });
    const { p, ctx, unchecked } = ctxFor(undefined, attrs);
    expect(await eventsParity.run(p, ctx)).toEqual([]);
    expect(unchecked).toEqual([]);
  });

  it("cuts and cleans what the page wrote: a long text or a control character never reaches the evidence", async () => {
    const name = `${"n".repeat(90)}‮`;
    const { findings } = await run({
      clicks: [sent(A, { ...ev("A", "/a"), [name]: "v" })],
      phone: [sent(A, ev("A", "/a"))],
    });
    const text = findings[0]?.evidence ?? "";
    expect(text).not.toContain("‮");
    expect(text.length).toBeLessThan(300);
  });

  it("asks the observer once: the phone is read in the same observation as the desktop", async () => {
    let calls = 0;
    const spy: EventObserver = {
      observe: async () => {
        calls++;
        return { clicks: [], phone: [] };
      },
    };
    const { p, ctx } = ctxFor(spy);
    await eventsParity.run(p, ctx);
    await eventsParity.run(p, ctx);
    expect(calls).toBe(1);
  });
});

describe("events-parity: integration (the nav-tab-order fixture, a recorded observation)", () => {
  const dir = `${SITES_DIR}nav-tab-order/`;
  const plan = () =>
    eventsConfigSchema.parse(JSON.parse(readFileSync(`${dir}gaugeline.events.json`, "utf8")));
  const recording = () =>
    JSON.parse(readFileSync(`${dir}observations.json`, "utf8")) as ObserveResult;

  it("finds the three links the phone treats differently, each with both widths and what differs", async () => {
    const site = await startFixture("nav-tab-order");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["events-parity"],
        events: plan(),
        eventObserver: recordedObserver(recording()),
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        '"Weddings" (/weddings) reports differently at 375 px than at 1280 px: sent menu_click at 1280 px but menu_tap at 375 px',
        '"Delivery" (/delivery) reports differently at 375 px than at 1280 px: sent menu_click at 1280 px and nothing at 375 px',
        '"Contact" (/contact) reports differently at 375 px than at 1280 px: link_text is filled at 1280 px and empty at 375 px',
      ]);
      expect(result.couldNotCheck).toEqual([]);
      // The fixture server is the site: no analytics request reached it, and nothing but a GET or a HEAD.
      expect([...site.hits.keys()].some((p) => /collect|analytics|gtm/.test(p))).toBe(false);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("gives the same findings for the same observation, run twice", async () => {
    const site = await startFixture("nav-tab-order");
    try {
      const once = async () =>
        (
          await checkSite({
            address: site.origin,
            fetcher: createFetcher({ allowPrivate: true }),
            only: ["events-parity"],
            events: plan(),
            eventObserver: recordedObserver(recording()),
          })
        ).result.findings.map((f) => f.evidence);
      expect(await once()).toEqual(await once());
    } finally {
      await site.close();
    }
  });

  it("without an observer it is could not check, never passed", async () => {
    const site = await startFixture("nav-tab-order");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["events-parity"],
        events: plan(),
      });
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
        ["events-parity", NO_OBSERVER],
      ]);
    } finally {
      await site.close();
    }
  });
});
