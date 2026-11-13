import { describe, expect, it } from "vitest";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  eventsOf,
  judgeFocusOrder,
  judgeParity,
  MAX_EVENTS_PER_REQUEST,
  parseAnalyticsRequest,
  selectClickable,
} from "../observation.js";
import {
  clickTargets,
  judgeClick,
  type ClickTarget,
  type EventsRead,
  type ObservedClick,
} from "../observe.js";
import { eventsConfigSchema } from "../types.js";
import { buildSnapshot } from "../../snapshot.js";

const html = (body: string) =>
  buildSnapshot([
    {
      url: "https://roast.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);
const RULE = { event: "menu_click", params: ["link_text"] };
const push = (atMs: number, data: Record<string, unknown>) => ({ atMs, data });

describe("the two viewports", () => {
  it("are a phone and a desktop, in CSS pixels", () => {
    expect(PHONE_VIEWPORT).toEqual({ width: 375, height: 667 });
    expect(DESKTOP_VIEWPORT).toEqual({ width: 1280, height: 800 });
  });
});

describe("which listed elements may be clicked: links only", () => {
  const page = html(`
    <nav><a href="/shop">Shop</a> <a href="https://other.example/x">Partner</a>
    <a href="#top">Top</a></nav>
    <main><button class="go">Go</button> <input class="go" type="submit" aria-label="Send">
    <form><a class="in-form" href="/f">In a form</a></form>
    <a class="go" href="https://other.example/y">Listed partner</a></main>`);

  it("takes links on the same site, and a link elsewhere only when the plan names it by selector", () => {
    const config = eventsConfigSchema.parse({
      events: [
        { region: "nav", event: "menu_click" },
        { selector: "main .go", event: "cta_click" },
        { selector: "a.in-form", event: "cta_click" },
      ],
    });
    const { click, skipped } = selectClickable(clickTargets(page, config), config, page);
    expect(click.map((t) => t.text)).toEqual(["Shop", "Top", "Listed partner"]);
    // A button and an input have no address: never clicked. A link in a form is a form's: never clicked.
    expect(skipped.map((s) => [s.text, s.reason])).toEqual([
      ["Partner", expect.stringContaining("another site")],
      ["Go", expect.stringContaining("not a link")],
      ["Send", expect.stringContaining("not a link")],
      ["In a form", expect.stringContaining("form")],
    ]);
  });

  it("never clicks a javascript:, mailto:, tel: or data: link", () => {
    const p = html(
      `<nav><a href="javascript:void(0)">A</a><a href="${["mailto", ["a", "b.example"].join("@")].join(":")}">B</a><a href="tel:+10000000000">C</a><a href="/ok">D</a></nav>`,
    );
    const config = eventsConfigSchema.parse({ events: [{ region: "nav", event: "e" }] });
    const { click, skipped } = selectClickable(clickTargets(p, config), config, p);
    expect(click.map((t) => t.text)).toEqual(["D"]);
    expect(skipped).toHaveLength(3);
  });
});

describe("what an observed click sent", () => {
  it("counts a request the page tried to make as the event it would have sent", () => {
    const click: ObservedClick = {
      path: "a",
      pushes: [],
      blocked: ["www.google-analytics.com"],
      sent: [
        {
          atMs: 120,
          host: "www.google-analytics.com",
          name: "menu_click",
          params: { link_text: "Coffee" },
        },
      ],
    };
    expect(eventsOf(click)).toEqual([push(120, { event: "menu_click", link_text: "Coffee" })]);
    expect(judgeClick(RULE, click)).toEqual({
      state: "ok",
      sent: { event: "menu_click", link_text: "Coffee" },
    });
  });

  it("does not count the same event twice when a push and a request carry it", () => {
    const click: ObservedClick = {
      path: "a",
      pushes: [push(50, { event: "menu_click", link_text: "Coffee" })],
      blocked: [],
      sent: [{ atMs: 90, host: "x.example", name: "menu_click", params: { link_text: "Coffee" } }],
    };
    expect(eventsOf(click)).toHaveLength(1);
    expect(judgeClick(RULE, click)).toMatchObject({ state: "ok" });
  });

  it("a click that could not be observed is unobserved, with the reason, never silent", () => {
    expect(
      judgeClick(RULE, { path: "a", pushes: [], blocked: [], unobserved: "it is covered" }),
    ).toEqual({ state: "unobserved", reason: "it is covered" });
  });
});

describe("reading an analytics request the page tried to make", () => {
  it("reads a GA4 collect request: the event name and its parameters, nothing else", () => {
    expect(
      parseAnalyticsRequest(
        "https://www.google-analytics.com/g/collect?v=2&tid=G-ABCDEF1234&cid=111.222&en=menu_click&ep.link_text=Coffee&epn.position=2&dl=https%3A%2F%2Froast.example%2F",
        undefined,
      ),
    ).toEqual([
      {
        host: "www.google-analytics.com",
        name: "menu_click",
        params: { link_text: "Coffee", position: "2" },
      },
    ]);
  });

  it("reads a batched GA4 body, one event a line", () => {
    expect(
      parseAnalyticsRequest(
        "https://region1.google-analytics.com/g/collect?v=2&tid=G-X",
        "en=a&ep.k=1\nen=b&ep.k=2",
      ).map((e) => [e.name, e.params]),
    ).toEqual([
      ["a", { k: "1" }],
      ["b", { k: "2" }],
    ]);
  });

  it("reads a Meta pixel event and a JSON event body", () => {
    expect(
      parseAnalyticsRequest(
        "https://www.facebook.com/tr/?id=123456789012&ev=Lead&cd[content_name]=Menu",
        undefined,
      ),
    ).toEqual([{ host: "www.facebook.com", name: "Lead", params: { content_name: "Menu" } }]);
    expect(
      parseAnalyticsRequest(
        "https://api.segment.io/v1/track",
        JSON.stringify({
          event: "menu_click",
          properties: { link_text: "Coffee", n: 2, deep: { a: 1 } },
        }),
      ),
    ).toEqual([
      { host: "api.segment.io", name: "menu_click", params: { link_text: "Coffee", n: "2" } },
    ]);
  });

  it("cleans and bounds what the page wrote, and ignores what it cannot read", () => {
    const [e] = parseAnalyticsRequest(
      `https://www.google-analytics.com/g/collect?en=${"x".repeat(500)}&ep.t=${"y".repeat(500)}&ep.bad%20key=1&ep.z=a%E2%80%8Bb`,
      undefined,
    );
    expect(e?.name.length).toBeLessThanOrEqual(120);
    expect(e?.params.t?.length).toBeLessThanOrEqual(120);
    expect(e?.params).not.toHaveProperty("bad key");
    expect(e?.params.z).toBe("a\\u{200B}b");
    expect(
      parseAnalyticsRequest("https://www.google-analytics.com/g/collect?v=2", undefined),
    ).toEqual([]);
    expect(parseAnalyticsRequest("not a url", undefined)).toEqual([]);
    expect(parseAnalyticsRequest("https://api.segment.io/v1/track", "{not json")).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => `ep.k${i}=v`).join("&");
    expect(
      Object.keys(
        parseAnalyticsRequest(
          `https://www.google-analytics.com/g/collect?en=a&${many}`,
          undefined,
        )[0]?.params ?? {},
      ).length,
    ).toBeLessThanOrEqual(20);
  });
});

function read(
  desktop: ObservedClick[],
  phone?: ObservedClick[],
  focusOrder?: string[],
): EventsRead {
  const config = eventsConfigSchema.parse({
    events: [{ region: "nav", event: "menu_click", params: ["link_text"] }],
  });
  const targets: ClickTarget[] = ["a:nth-of-type(1)", "a:nth-of-type(2)", "a:nth-of-type(3)"].map(
    (path, i) => ({
      path,
      rule: 0,
      text: `L${i + 1}`,
      destination: `https://roast.example/${i + 1}`,
      newTab: false,
    }),
  );
  return {
    config,
    targets,
    result: { clicks: desktop, ...(phone ? { phone } : {}), ...(focusOrder ? { focusOrder } : {}) },
  };
}
const ok = (path: string, text = "Coffee"): ObservedClick => ({
  path,
  pushes: [push(10, { event: "menu_click", link_text: text })],
  blocked: [],
});
const silent = (path: string): ObservedClick => ({ path, pushes: [], blocked: [] });

describe("an analytics request is the page's, so reading it is bounded", () => {
  const GA = "https://www.google-analytics.com/g/collect?v=2";
  const fast = <T>(run: () => T): T => {
    const started = performance.now();
    const out = run();
    // A guard against reading without a bound (it took seconds before): generous, so a loaded machine passes.
    expect(performance.now() - started).toBeLessThan(1000);
    return out;
  };

  it("reads at most ten events from a body of a hundred thousand lines", () => {
    const body = Array.from({ length: 100_000 }, (_, i) => `en=e${i}&ep.k=v`).join("\n");
    const events = fast(() => parseAnalyticsRequest(GA, body));
    expect(events).toHaveLength(MAX_EVENTS_PER_REQUEST);
    expect(events[0]?.name).toBe("e0");
  });

  it("stops reading parameters at twenty, however many the line has", () => {
    const line = `en=a&${Array.from({ length: 1_000_000 }, (_, i) => `ep.k${i}=v`).join("&")}`;
    const [e] = fast(() => parseAnalyticsRequest(`${GA}&${line}`, undefined));
    expect(Object.keys(e?.params ?? {})).toHaveLength(20);
    const [b] = fast(() => parseAnalyticsRequest(GA, line));
    expect(Object.keys(b?.params ?? {})).toHaveLength(20);
  });

  it("reads no more than the first 64 KB of a body, and cuts a value before cleaning it", () => {
    const events = fast(() => parseAnalyticsRequest(GA, `en=a&ep.big=${"x".repeat(3_000_000)}`));
    expect(events[0]?.params.big?.length).toBeLessThanOrEqual(120);
    const json = JSON.stringify({
      event: "a",
      properties: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, "v"])),
    });
    const [j] = fast(() => parseAnalyticsRequest("https://api.segment.io/v1/track", json));
    expect(Object.keys(j?.params ?? {}).length).toBeLessThanOrEqual(20);
  });
});

describe("the plan's elements are capped before anything is clicked", () => {
  it("lists at most twenty, however many a selector matches", () => {
    const p = html(
      `<body>${Array.from({ length: 50 }, (_, i) => `<a href="/${i}">L${i}</a>`).join("")}</body>`,
    );
    for (const selector of ["a", "*", "body *", "body > a"]) {
      const config = eventsConfigSchema.parse({ events: [{ selector, event: "e" }] });
      expect(clickTargets(p, config).length).toBeLessThanOrEqual(20);
    }
  });

  it("marks the link to another site that the plan names by selector, and no other", () => {
    const p = html(
      `<nav><a href="/a">A</a></nav><main><a class="x" href="https://other.example/">X</a></main>`,
    );
    const config = eventsConfigSchema.parse({
      events: [
        { region: "nav", event: "e" },
        { selector: "a.x", event: "e" },
      ],
    });
    const { click } = selectClickable(clickTargets(p, config), config, p);
    expect(click.map((t) => [t.text, t.allowCrossSite])).toEqual([
      ["A", undefined],
      ["X", true],
    ]);
  });
});

describe("the phone against the desktop", () => {
  it("lists a link that reports on one and not the other, with both answers", () => {
    const rows = judgeParity(
      read(
        [ok("a:nth-of-type(1)"), ok("a:nth-of-type(2)"), silent("a:nth-of-type(3)")],
        [ok("a:nth-of-type(1)"), silent("a:nth-of-type(2)"), silent("a:nth-of-type(3)")],
      ),
    );
    expect(rows.map((r) => [r.target.text, r.desktop.state, r.phone.state])).toEqual([
      ["L2", "ok", "silent"],
    ]);
  });

  it("lists a link whose parameters differ between the two", () => {
    const rows = judgeParity(
      read([ok("a:nth-of-type(1)", "Coffee")], [ok("a:nth-of-type(1)", "Tea")]),
    );
    expect(rows.map((r) => r.target.text)).toEqual(["L1"]);
  });

  it("leaves out a link that could not be observed on either: that is not a difference", () => {
    const hidden: ObservedClick = {
      path: "a:nth-of-type(2)",
      pushes: [],
      blocked: [],
      unobserved: "not visible at this width",
    };
    expect(
      judgeParity(
        read([ok("a:nth-of-type(1)"), ok("a:nth-of-type(2)")], [ok("a:nth-of-type(1)"), hidden]),
      ),
    ).toEqual([]);
  });

  it("is empty when there was no phone read", () => {
    expect(judgeParity(read([ok("a:nth-of-type(1)")]))).toEqual([]);
  });
});

describe("keyboard focus order of the listed links", () => {
  const [a, b, c] = ["a:nth-of-type(1)", "a:nth-of-type(2)", "a:nth-of-type(3)"] as const;

  it("is fine when the links take focus in the order they are written", () => {
    expect(judgeFocusOrder(read([], undefined, [a, b, c]))).toEqual({
      unreachable: [],
      outOfOrder: [],
    });
  });

  it("lists a link the keyboard never reached", () => {
    const r = judgeFocusOrder(read([], undefined, [a, c]));
    expect(r.unreachable.map((t) => t.text)).toEqual(["L2"]);
    expect(r.outOfOrder).toEqual([]);
  });

  it("lists links that take focus in another order than the page reads", () => {
    const r = judgeFocusOrder(read([], undefined, [b, a, c]));
    expect(r.outOfOrder.map((o) => [o.target.text, o.documentIndex, o.focusIndex])).toEqual([
      ["L1", 0, 1],
      ["L2", 1, 0],
    ]);
  });

  it("is empty when focus was not read", () => {
    expect(judgeFocusOrder(read([]))).toEqual({ unreachable: [], outOfOrder: [] });
  });
});
