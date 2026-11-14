import { describe, expect, it } from "vitest";
import {
  DESKTOP_VIEWPORT,
  PHONE_VIEWPORT,
  eventsOf,
  judgeFocusOrder,
  judgeParity,
  MAX_EVENTS_PER_REQUEST,
  parseAnalyticsRequest,
  positiveTabindex,
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
const L1 = "a:nth-of-type(1)";
const L2 = "a:nth-of-type(2)";
const L3 = "a:nth-of-type(3)";
const sentAs = (path: string, data: Record<string, unknown>, atMs = 10): ObservedClick => ({
  path,
  pushes: [push(atMs, data)],
  blocked: [],
});
const diffs = (desktop: ObservedClick[], phone: ObservedClick[]) =>
  judgeParity(read(desktop, phone)).rows.map((r) => [r.target.text, r.differences]);

describe("the phone against the desktop", () => {
  it("lists a link that reports on one width and not the other, naming both widths", () => {
    expect(diffs([ok(L1), ok(L2), silent(L3)], [ok(L1), silent(L2), silent(L3)])).toEqual([
      ["L2", ["sent menu_click at 1280 px and nothing at 375 px"]],
    ]);
    expect(diffs([silent(L1)], [ok(L1)])).toEqual([
      ["L1", ["sent menu_click at 375 px and nothing at 1280 px"]],
    ]);
  });

  it("a link that is silent on both is events-fire's, not a difference", () => {
    expect(diffs([silent(L1)], [silent(L1)])).toEqual([]);
  });

  it("names a different event name at one width", () => {
    expect(diffs([ok(L1)], [sentAs(L1, { event: "menu_tap", link_text: "Coffee" })])).toEqual([
      ["L1", ["sent menu_click at 1280 px but menu_tap at 375 px"]],
    ]);
    // The tag manager's own events are not the site's name for the click.
    expect(diffs([ok(L1)], [sentAs(L1, { event: "gtm.linkClick" })])).toEqual([
      ["L1", ["sent menu_click at 1280 px and nothing at 375 px"]],
    ]);
  });

  it("names an event that arrives in time on one width and late on the other", () => {
    expect(
      diffs([ok(L1)], [sentAs(L1, { event: "menu_click", link_text: "Coffee" }, 4000)]),
    ).toEqual([["L1", ["sent menu_click within 1500 ms at 1280 px but after 4000 ms at 375 px"]]]);
  });

  it("names an event sent twice at one width and once at the other", () => {
    const twice: ObservedClick = {
      path: L1,
      pushes: [
        push(10, { event: "menu_click", link_text: "Coffee" }),
        push(20, { event: "menu_click", link_text: "Coffee" }),
      ],
      blocked: [],
    };
    expect(diffs([ok(L1)], [twice])).toEqual([
      ["L1", ["sent menu_click 2 times at 375 px and 1 time at 1280 px"]],
    ]);
  });

  it("names a parameter filled on one width and empty on the other", () => {
    expect(diffs([ok(L1)], [sentAs(L1, { event: "menu_click", link_text: "" })])).toEqual([
      ["L1", ["link_text is filled at 1280 px and empty at 375 px"]],
    ]);
  });

  it("compares values by kind, not by exact text: a different word is not a difference, text against a number is", () => {
    expect(diffs([ok(L1, "Coffee")], [ok(L1, "Tea")])).toEqual([]);
    expect(diffs([ok(L1)], [sentAs(L1, { event: "menu_click", link_text: 7 })])).toEqual([
      ["L1", ["link_text is text at 1280 px and a number at 375 px"]],
    ]);
    expect(diffs([sentAs(L1, { event: "menu_click", link_text: true })], [ok(L1)])).toEqual([
      ["L1", ["link_text is true or false at 1280 px and text at 375 px"]],
    ]);
  });

  it("names a parameter the plan does not list that only one width sends, cleaned and cut", () => {
    const long = `${"x".repeat(80)}\u202e`;
    const desktop = sentAs(L1, {
      event: "menu_click",
      link_text: "A",
      [long]: "v",
      menu_parent: "Shop",
    });
    const phone = sentAs(L1, { event: "menu_click", link_text: "A" });
    const rows = diffs([desktop], [phone]);
    expect(rows).toHaveLength(1);
    const text = (rows[0]?.[1] as string[]).join("|");
    expect(text).toContain("menu_parent is sent at 1280 px and not at 375 px");
    // The page chose that name: it is cut to a bounded snippet and never carries a control character.
    expect(text).not.toContain("\u202e");
    expect(text.length).toBeLessThan(250);
  });

  it("is the same whatever order the parameters were written in", () => {
    const a = sentAs(L1, { event: "menu_click", link_text: "A", b: "1", c: "2" });
    const b = sentAs(L1, { c: "2", b: "1", link_text: "A", event: "menu_click" });
    expect(diffs([a], [b])).toEqual([]);
  });

  it("leaves a link that could not be observed on a width out, and says so (never a pass)", () => {
    const hidden: ObservedClick = {
      path: L2,
      pushes: [],
      blocked: [],
      unobserved: "it is not visible at 375 px",
    };
    const report = judgeParity(read([ok(L1), ok(L2), silent(L3)], [ok(L1), hidden, silent(L3)]));
    expect(report.rows).toEqual([]);
    expect(report.notCompared.map((n) => [n.target.text, n.reason])).toEqual([
      ["L2", "at 375 px: it is not visible at 375 px"],
    ]);
  });

  it("a link missing from one width's read is not compared", () => {
    const report = judgeParity(read([ok(L1), ok(L2), silent(L3)], [ok(L1), silent(L3)]));
    expect(report.notCompared.map((n) => [n.target.text, n.reason])).toEqual([
      ["L2", "at 375 px: it was not read"],
    ]);
  });

  it("is empty when there was no phone read, or the whole read was not made", () => {
    expect(judgeParity(read([ok(L1)]))).toEqual({ rows: [], notCompared: [] });
    expect(judgeParity({ ...read([]), result: { unchecked: "no browser" } })).toEqual({
      rows: [],
      notCompared: [],
    });
  });

  it("gives the same answer for the same input", () => {
    const input = read(
      [ok(L1), ok(L2)],
      [silent(L1), sentAs(L2, { event: "menu_click", link_text: "" })],
    );
    expect(JSON.stringify(judgeParity(input))).toBe(JSON.stringify(judgeParity(input)));
  });
});

describe("keyboard focus order of the listed links", () => {
  const empty = { unreachable: [], outOfOrder: [], notRead: [] };

  it("is fine when the links take focus in the order they are written", () => {
    expect(judgeFocusOrder(read([], undefined, [L1, L2, L3]))).toEqual(empty);
  });

  it("lists a link the keyboard never reached", () => {
    const r = judgeFocusOrder(read([], undefined, [L1, L3]));
    expect(r.unreachable.map((t) => t.text)).toEqual(["L2"]);
    expect(r.outOfOrder).toEqual([]);
  });

  it("lists the link that moved, not every link it moved past (one jumps to the front)", () => {
    const r = judgeFocusOrder(read([], undefined, [L2, L1, L3]));
    expect(r.outOfOrder.map((o) => [o.target.text, o.documentIndex, o.focusIndex])).toEqual([
      ["L2", 1, 0],
    ]);
  });

  it("lists the link that moved to the end", () => {
    const r = judgeFocusOrder(read([], undefined, [L2, L3, L1]));
    expect(r.outOfOrder.map((o) => [o.target.text, o.documentIndex, o.focusIndex])).toEqual([
      ["L1", 0, 2],
    ]);
  });

  it("an unreached link does not make the others look out of order", () => {
    const r = judgeFocusOrder(read([], undefined, [L1, L3]));
    expect(r.outOfOrder).toEqual([]);
  });

  it("the order of the page is the order in the HTML, not the order the plan lists its lines", () => {
    // The plan's first line selects the link that is last in the page.
    const config = eventsConfigSchema.parse({
      events: [
        { selector: "a.last", event: "x" },
        { region: "nav", event: "y" },
      ],
    });
    const p = html(
      `<body><nav><a href="/a">A</a><a href="/b">B</a></nav><a class="last" href="/z">Z</a></body>`,
    );
    const targets = clickTargets(p, config);
    expect(targets.map((t) => t.text)).toEqual(["Z", "A", "B"]);
    const focus = targets.map((t) => t.text).sort();
    const byText = (text: string) => targets.find((t) => t.text === text)?.path ?? "";
    const order = focus.map(byText);
    const rd: EventsRead = { config, targets, result: { clicks: [], focusOrder: order } };
    // Written order is A, B, Z; the keyboard went A, B, Z: nothing is out of order.
    expect(judgeFocusOrder(rd, p).outOfOrder).toEqual([]);
    // Without the page the plan's order is all there is, and A, B, Z then looks moved.
    expect(judgeFocusOrder(rd).outOfOrder.length).toBeGreaterThan(0);
  });

  it("leaves out links that could not be observed, and says so (never a pass)", () => {
    const hidden: ObservedClick = {
      path: L2,
      pushes: [],
      blocked: [],
      unobserved: "it is not visible at 1280 px",
    };
    const r = judgeFocusOrder(read([hidden], undefined, [L1, L3]));
    expect(r.unreachable).toEqual([]);
    expect(r.notRead.map((n) => [n.target.text, n.reason])).toEqual([
      ["L2", "it is not visible at 1280 px"],
    ]);
  });

  it("only links are judged: a listed button is not expected to take focus", () => {
    const rd = read([], undefined, [L1]);
    const [t1, t2, t3] = rd.targets;
    const { destination: _d, ...button } = t2 as ClickTarget;
    const r = judgeFocusOrder({ ...rd, targets: [t1 as ClickTarget, button, t3 as ClickTarget] });
    expect(r.unreachable.map((t) => t.text)).toEqual(["L3"]);
  });

  it("is empty when focus was not read", () => {
    expect(judgeFocusOrder(read([]))).toEqual(empty);
  });
});

describe("a positive tabindex on a listed element", () => {
  const config = eventsConfigSchema.parse({ events: [{ region: "nav", event: "menu_click" }] });
  const tabbed = (nav: string) => {
    const p = html(`<nav>${nav}</nav>`);
    return positiveTabindex({ targets: clickTargets(p, config) }, p).map((x) => [
      x.target.text,
      x.value,
    ]);
  };

  it("lists a link with tabindex 1 or more, read from the page as sent", () => {
    expect(
      tabbed(
        `<a href="/a" tabindex="1">A</a><a href="/b" tabindex="0">B</a><a href="/c" tabindex="-1">C</a><a href="/d" tabindex=" 3 ">D</a><a href="/e">E</a>`,
      ),
    ).toEqual([
      ["A", 1],
      ["D", 3],
    ]);
  });

  it("does not list a value that is not a positive whole number", () => {
    expect(
      tabbed(
        `<a href="/a" tabindex="">A</a><a href="/b" tabindex="first">B</a><a href="/c" tabindex="0.5x">C</a>`,
      ),
    ).toEqual([]);
  });

  it("does not list an element the plan does not select", () => {
    const p = html(`<nav><a href="/a">A</a></nav><div tabindex="5">Other</div>`);
    expect(positiveTabindex({ targets: clickTargets(p, config) }, p)).toEqual([]);
  });
});
