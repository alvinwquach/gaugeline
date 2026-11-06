import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import {
  EVENT_WAIT_MS,
  NO_OBSERVER,
  clickTargets,
  judgeClick,
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
import { eventsDistinct } from "../events-distinct.js";
import { eventsFire } from "../events-fire.js";

const EVENTS = ["events-fire", "events-distinct"];
const RULE = { event: "menu_click", params: ["link_text", "link_url"] };

const click = (pushes: ObservedClick["pushes"], path = "a"): ObservedClick => ({
  path,
  pushes,
  blocked: [],
});
const push = (atMs: number, data: Record<string, unknown>) => ({ atMs, data });

const page = (body: string) =>
  buildSnapshot([
    {
      url: "https://roast.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);

function ctxFor(html: string, config: EventsConfig, observer?: EventObserver) {
  const p = page(html);
  const unchecked: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    events: lazyEvents({ page: p, config, ...(observer ? { observer } : {}) }),
    couldNotCheck: (_url, reason) => unchecked.push(reason),
  };
  return { p, ctx, unchecked };
}

describe("click events: unit (matching expected against observed parameters)", () => {
  it("one push with the name and every parameter filled is ok", () => {
    expect(
      judgeClick(
        RULE,
        click([push(80, { event: "menu_click", link_text: "Coffee", link_url: "/coffee" })]),
      ),
    ).toEqual({
      state: "ok",
      sent: { event: "menu_click", link_text: "Coffee", link_url: "/coffee" },
    });
  });

  it("an empty or missing parameter is listed; numbers and booleans count as filled", () => {
    expect(
      judgeClick(RULE, click([push(80, { event: "menu_click", link_text: " ", link_url: 3 })])),
    ).toMatchObject({ state: "missing", params: ["link_text"] });
    expect(
      judgeClick(RULE, click([push(80, { event: "menu_click", link_text: true })])),
    ).toMatchObject({ state: "missing", params: ["link_url"] });
  });

  it("other events don't count; no click observed is silent", () => {
    expect(judgeClick(RULE, click([push(80, { event: "gtm.linkClick" })]))).toEqual({
      state: "silent",
    });
    expect(judgeClick(RULE, undefined)).toEqual({ state: "silent" });
  });

  it("the plan reads links in a region, with text, destination, parent menu and new tab", () => {
    const targets = clickTargets(
      page(`<nav><ul><li><a href="/shop">Shop</a><ul><li><a href="/coffee" target="_blank">Coffee</a></li></ul></li></ul></nav>
            <main><a href="/x">Not in nav</a></main>`),
      eventsConfigSchema.parse({ events: [{ region: "nav", event: "menu_click" }] }),
    );
    expect(targets).toEqual([
      {
        path: "nav > ul > li > a",
        rule: 0,
        text: "Shop",
        destination: "https://roast.example/shop",
        newTab: false,
      },
      {
        path: "nav > ul > li > ul > li > a",
        rule: 0,
        text: "Coffee",
        destination: "https://roast.example/coffee",
        parent: "Shop",
        newTab: true,
      },
    ]);
  });

  it("a plan line needs a selector or a region, not both, and an event name", () => {
    expect(eventsConfigSchema.safeParse({ events: [{ event: "x" }] }).success).toBe(false);
    expect(
      eventsConfigSchema.safeParse({ events: [{ selector: "a", region: "nav", event: "x" }] })
        .success,
    ).toBe(false);
    expect(eventsConfigSchema.safeParse({ events: [{ selector: "a", event: "" }] }).success).toBe(
      false,
    );
  });
});

describe("click events: integration (the nav-events fixture, a recorded observation)", () => {
  it("finds the silent link and the pair reporting identical values, each with the event as sent", async () => {
    const site = await startFixture("nav-events");
    try {
      const dir = `${SITES_DIR}nav-events/`;
      const events = eventsConfigSchema.parse(
        JSON.parse(readFileSync(`${dir}gaugeline.events.json`, "utf8")),
      );
      const recording = JSON.parse(
        readFileSync(`${dir}observations.json`, "utf8"),
      ) as ObserveResult;
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: EVENTS,
        events,
        eventObserver: recordedObserver(recording),
      });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        ["events-fire", '"Hours" (/hours) sent no menu_click event'],
        [
          "events-distinct",
          '/coffee under "Shop" and under "Visit" both send {"event":"menu_click","link_text":"Coffee","link_url":"/coffee","menu_parent":"Shop"}',
        ],
      ]);
      expect(result.couldNotCheck).toEqual([]);
      // The fixture server is the site: it received no analytics request, and no POST at all.
      expect([...site.hits.keys()].some((p) => /collect|analytics|gtm/.test(p))).toBe(false);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("without an observer (no rendered read yet) both checks are could not check, never passed", async () => {
    const site = await startFixture("nav-events");
    try {
      const events = eventsConfigSchema.parse(
        JSON.parse(readFileSync(`${SITES_DIR}nav-events/gaugeline.events.json`, "utf8")),
      );
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: EVENTS,
        events,
      });
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
        ["events-distinct", NO_OBSERVER],
        ["events-fire", NO_OBSERVER],
      ]);
    } finally {
      await site.close();
    }
  });
});

describe("click events: edge cases", () => {
  const config = eventsConfigSchema.parse({
    events: [{ selector: "a.track", event: "menu_click", params: ["link_text", "link_url"] }],
  });
  const html = `<a class="track" href="/a">A</a>`;
  const sent = { event: "menu_click", link_text: "A", link_url: "/a" };

  it("an event that fires twice is reported with what was sent", async () => {
    const { p, ctx } = ctxFor(
      html,
      config,
      recordedObserver({ clicks: [click([push(50, sent), push(60, sent)], "a")] }),
    );
    expect((await eventsFire.run(p, ctx)).map((f) => f.evidence)).toEqual([
      '"A" (/a) sent menu_click 2 times: {"event":"menu_click","link_text":"A","link_url":"/a"}',
    ]);
  });

  it("a link that opens a new tab is still clicked and judged like any other", async () => {
    const { p, ctx } = ctxFor(
      `<a class="track" href="/a" target="_blank">A</a>`,
      config,
      recordedObserver({ clicks: [click([push(50, sent)], "a")] }),
    );
    const seen: boolean[] = [];
    const spy: EventObserver = {
      observe: async (input) => {
        seen.push(...input.targets.map((t) => t.newTab));
        return { clicks: [click([push(50, sent)], "a")] };
      },
    };
    expect(await eventsFire.run(p, ctx)).toEqual([]);
    await ctxFor(`<a class="track" href="/a" target="_blank">A</a>`, config, spy).ctx.events?.();
    expect(seen).toEqual([true]);
  });

  it("an event pushed after a delay counts within the wait and is reported as late after it", async () => {
    const within = ctxFor(
      html,
      config,
      recordedObserver({ clicks: [click([push(EVENT_WAIT_MS, sent)], "a")] }),
    );
    expect(await eventsFire.run(within.p, within.ctx)).toEqual([]);
    const late = ctxFor(
      html,
      config,
      recordedObserver({ clicks: [click([push(3000, sent)], "a")] }),
    );
    expect((await eventsFire.run(late.p, late.ctx)).map((f) => f.evidence)).toEqual([
      '"A" (/a) sent menu_click after 3000 ms, later than the 1500 ms the check waits',
    ]);
  });

  it("a consent banner the config can't accept makes both checks could not check, with the reason", async () => {
    const reason =
      "a consent banner blocked analytics, and gaugeline.events.json has no consent.accept";
    const { p, ctx, unchecked } = ctxFor(html, config, recordedObserver({ unchecked: reason }));
    expect(await eventsFire.run(p, ctx)).toEqual([]);
    expect(await eventsDistinct.run(p, ctx)).toEqual([]);
    expect(unchecked).toEqual([reason, reason]);
  });

  it("the consent selector from the config is handed to the observer", async () => {
    let consent: unknown;
    const spy: EventObserver = {
      observe: async (input) => {
        consent = input.consent;
        return { clicks: [] };
      },
    };
    const withConsent = eventsConfigSchema.parse({ ...config, consent: { accept: "#accept-all" } });
    await ctxFor(html, withConsent, spy).ctx.events?.();
    expect(consent).toEqual({ accept: "#accept-all" });
  });

  it("a parameter left empty is named, with the event as sent", async () => {
    const { p, ctx } = ctxFor(
      html,
      config,
      recordedObserver({
        clicks: [click([push(50, { event: "menu_click", link_text: "A", link_url: "" })], "a")],
      }),
    );
    expect((await eventsFire.run(p, ctx)).map((f) => f.evidence)).toEqual([
      '"A" (/a) sent menu_click without link_url: {"event":"menu_click","link_text":"A","link_url":""}',
    ]);
  });

  it("a selector that isn't valid CSS selects nothing, and nothing is clicked", () => {
    expect(
      clickTargets(
        page(html),
        eventsConfigSchema.parse({ events: [{ selector: "a[[", event: "x" }] }),
      ),
    ).toEqual([]);
  });

  it("the observer is asked once per run, however many checks read it", async () => {
    let calls = 0;
    const spy: EventObserver = {
      observe: async () => {
        calls++;
        return { clicks: [] };
      },
    };
    const { p, ctx } = ctxFor(html, config, spy);
    await eventsFire.run(p, ctx);
    await eventsDistinct.run(p, ctx);
    expect(calls).toBe(1);
  });
});
