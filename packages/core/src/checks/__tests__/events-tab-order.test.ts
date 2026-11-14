import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import {
  NO_OBSERVER,
  clickTargets,
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
import { eventsTabOrder } from "../events-tab-order.js";

const config = eventsConfigSchema.parse({ events: [{ region: "nav", event: "menu_click" }] });
const pageOf = (nav: string) =>
  buildSnapshot([
    {
      url: "https://florist.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<body><nav>${nav}</nav></body>`,
      ms: 1,
    },
  ]);
const plain = `<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>`;
const path = (n: number) => `body > nav > a:nth-of-type(${n})`;
const quiet = (n: number, unobserved?: string): ObservedClick => ({
  path: path(n),
  pushes: [],
  blocked: [],
  ...(unobserved ? { unobserved } : {}),
});

function ctxFor(nav: string, observer?: EventObserver, plan: EventsConfig = config) {
  const p = pageOf(nav);
  const unchecked: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    eventsConfig: plan,
    events: lazyEvents({ page: p, config: plan, ...(observer ? { observer } : {}) }),
    couldNotCheck: (_url, reason) => unchecked.push(reason),
  };
  return { p, ctx, unchecked };
}
const run = async (nav: string, result: ObserveResult) => {
  const { p, ctx, unchecked } = ctxFor(nav, recordedObserver(result));
  return { findings: await eventsTabOrder.run(p, ctx), unchecked };
};
const all = [quiet(1), quiet(2), quiet(3)];

describe("events-tab-order: unit", () => {
  it("is a pass when the keyboard reaches every listed link in the order they are written", async () => {
    const { findings, unchecked } = await run(plain, {
      clicks: all,
      focusOrder: [path(1), path(2), path(3)],
    });
    expect(findings).toEqual([]);
    expect(unchecked).toEqual([]);
  });

  it("names a link the Tab key never reached", async () => {
    const { findings } = await run(plain, { clicks: all, focusOrder: [path(1), path(3)] });
    expect(findings).toEqual([
      {
        checkId: "events-tab-order",
        severity: "medium",
        title: eventsTabOrder.title,
        evidence: `1 of the plan's links is never reached by the Tab key: "B" (/b)`,
        url: "https://florist.example/",
      },
    ]);
  });

  it("says when a link is out of the keyboard's way on purpose-looking: tabindex -1", async () => {
    const { findings } = await run(
      `<a href="/a">A</a><a href="/b" tabindex="-1">B</a><a href="/c">C</a>`,
      { clicks: all, focusOrder: [path(1), path(3)] },
    );
    expect(findings[0]?.evidence).toBe(
      `1 of the plan's links is never reached by the Tab key: "B" (/b, tabindex="-1")`,
    );
  });

  it("names the link that took focus in another place than it comes in the page, with both places", async () => {
    const { findings } = await run(plain, {
      clicks: all,
      focusOrder: [path(2), path(1), path(3)],
    });
    expect(findings.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        `1 of the plan's links takes focus in a different place than it comes in the page: "B" (/b) is reached 1st but comes 2nd`,
      ],
    ]);
  });

  it("names a positive tabindex from the page as sent, and needs no browser to do it", async () => {
    const { p, ctx, unchecked } = ctxFor(
      `<a href="/a">A</a><a href="/b" tabindex="2">B</a><a href="/c">C</a>`,
    );
    const findings = await eventsTabOrder.run(p, ctx);
    expect(findings.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        `1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "B" (/b) has tabindex="2"`,
      ],
    ]);
    // The keyboard itself was not read: that part is could not check, not a pass.
    expect(unchecked).toEqual([NO_OBSERVER]);
  });

  it("lists the first three links of a kind and counts the rest", async () => {
    const nav = Array.from({ length: 6 }, (_, i) => `<a href="/p${i}">P${i}</a>`).join("");
    const clicks = Array.from({ length: 6 }, (_, i) => quiet(i + 1));
    const { findings } = await run(nav, { clicks, focusOrder: [] });
    expect(findings[0]?.evidence).toBe(
      `6 of the plan's links are never reached by the Tab key: "P0" (/p0), "P1" (/p1), "P2" (/p2) and 3 more`,
    );
  });

  it("a keyboard read that was not made is could not check with the observer's reason, never a pass", async () => {
    const { findings, unchecked } = await run(plain, {
      clicks: all,
      focusUnchecked: "the Tab key was pressed 200 times and the page had not ended",
    });
    expect(findings).toEqual([]);
    expect(unchecked).toEqual(["the Tab key was pressed 200 times and the page had not ended"]);
  });

  it("a read with no focus order and no reason still says so", async () => {
    const { unchecked } = await run(plain, { clicks: all });
    expect(unchecked).toEqual(["the keyboard was not read"]);
  });

  it("a link that could not be watched is could not check, not missed and not passed", async () => {
    const { findings, unchecked } = await run(plain, {
      clicks: [quiet(1), quiet(2, "it is not visible at 1280 px"), quiet(3)],
      focusOrder: [path(1), path(3)],
    });
    expect(findings).toEqual([]);
    expect(unchecked).toEqual([
      `1 of the plan's links could not be looked at with the keyboard ("B" (/b): it is not visible at 1280 px)`,
    ]);
  });

  it("only links are judged: a listed button is never expected to take focus here", async () => {
    const plan = eventsConfigSchema.parse({ events: [{ selector: "button.go", event: "go" }] });
    const { p, ctx, unchecked } = ctxFor(
      `<button class="go">Go</button>`,
      recordedObserver({
        clicks: [{ path: "button", pushes: [], blocked: [], unobserved: "x" }],
        focusOrder: [],
      }),
      plan,
    );
    expect(await eventsTabOrder.run(p, ctx)).toEqual([]);
    expect(unchecked).toEqual([]);
  });

  it("an observer that could not read the page is could not check, but the positive tabindex is still found", async () => {
    const { findings, unchecked } = await run(`<a href="/a" tabindex="1">A</a>`, {
      unchecked: "no browser",
    });
    expect(findings).toHaveLength(1);
    expect(unchecked).toEqual(["no browser"]);
  });

  it("a plan with only attribute rules has nothing to tab through", async () => {
    const attrs = eventsConfigSchema.parse({
      attributes: [{ region: "nav", require: ["data-t"] }],
    });
    const { p, ctx, unchecked } = ctxFor(`<a href="/a" tabindex="3">A</a>`, undefined, attrs);
    expect(await eventsTabOrder.run(p, ctx)).toEqual([]);
    expect(unchecked).toEqual([]);
  });

  it("an element the plan does not list is not judged, whatever its tabindex", async () => {
    const p = buildSnapshot([
      {
        url: "https://florist.example/",
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<body><nav><a href="/a">A</a></nav><div tabindex="9">x</div></body>`,
        ms: 1,
      },
    ]);
    const ctx: CheckContext = {
      warn: () => undefined,
      eventsConfig: config,
      events: lazyEvents({
        page: p,
        config,
        observer: recordedObserver({
          clicks: [{ ...quiet(1), path: "body > nav > a" }],
          focusOrder: ["body > nav > a"],
        }),
      }),
    };
    expect(await eventsTabOrder.run(p, ctx)).toEqual([]);
    expect(clickTargets(p, config)).toHaveLength(1);
  });

  it("cleans and cuts a link's words in the evidence", async () => {
    const nav = `<a href="/a">${"w".repeat(200)}‮</a>`;
    const { findings } = await run(nav, { clicks: [quiet(1)], focusOrder: [] });
    const text = findings[0]?.evidence ?? "";
    expect(text).not.toContain("‮");
    expect(text.length).toBeLessThan(300);
  });
});

describe("events-tab-order: integration (the nav-tab-order fixture)", () => {
  const dir = `${SITES_DIR}nav-tab-order/`;
  const plan = () =>
    eventsConfigSchema.parse(JSON.parse(readFileSync(`${dir}gaugeline.events.json`, "utf8")));
  const recording = () =>
    JSON.parse(readFileSync(`${dir}observations.json`, "utf8")) as ObserveResult;

  it("finds the link that is never reached, the link that jumps the queue, and the tabindex that caused it", async () => {
    const site = await startFixture("nav-tab-order");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["events-tab-order"],
        events: plan(),
        eventObserver: recordedObserver(recording()),
      });
      expect(result.findings.map((f) => [f.severity, f.evidence])).toEqual([
        [
          "medium",
          `1 of the plan's links is never reached by the Tab key: "Contact" (/contact, tabindex="-1")`,
        ],
        [
          "low",
          `1 of the plan's links takes focus in a different place than it comes in the page: "Weddings" (/weddings) is reached 1st but comes 2nd`,
        ],
        [
          "low",
          `1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "Weddings" (/weddings) has tabindex="2"`,
        ],
      ]);
      expect(result.couldNotCheck).toEqual([]);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("without an observer the positive tabindex is still found, and the keyboard read is could not check", async () => {
    const site = await startFixture("nav-tab-order");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["events-tab-order"],
        events: plan(),
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        `1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "Weddings" (/weddings) has tabindex="2"`,
      ]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
        ["events-tab-order", NO_OBSERVER],
      ]);
    } finally {
      await site.close();
    }
  });
});
