import { describe, expect, it } from "vitest";
import { missingAttributes } from "../../events/attributes.js";
import { eventsConfigSchema, type EventsConfig } from "../../events/types.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot } from "../../snapshot.js";
import { createPageRegistry } from "../index.js";
import { trackingAttributesMissing } from "../tracking-attributes-missing.js";

const page = (body: string) =>
  buildSnapshot([
    {
      url: "https://roast.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
const config = (over: Record<string, unknown>): EventsConfig => eventsConfigSchema.parse(over);
const NAV = { attributes: [{ region: "nav", require: ["data-track"] }] };

describe("tracking attributes: the config", () => {
  it("a plan may hold only attribute rules, and one with neither events nor attributes is refused", () => {
    expect(config(NAV).events).toEqual([]);
    expect(config(NAV).attributes).toHaveLength(1);
    expect(() => eventsConfigSchema.parse({})).toThrow(/at least one/);
    expect(() => eventsConfigSchema.parse({ events: [], attributes: [] })).toThrow(/at least one/);
  });

  it("a rule names a region or a selector, never both or neither, and at least one attribute", () => {
    expect(() => config({ attributes: [{ require: ["data-track"] }] })).toThrow(
      /selector or a region/,
    );
    expect(() =>
      config({ attributes: [{ region: "nav", selector: "a", require: ["data-track"] }] }),
    ).toThrow(/selector or a region/);
    expect(() => config({ attributes: [{ region: "nav", require: [] }] })).toThrow();
    expect(() => config({ attributes: [{ region: "nav", require: ["bad name"] }] })).toThrow(
      /attribute name/,
    );
    expect(() => config({ attributes: [{ region: "nav", require: ["x"], extra: 1 }] })).toThrow();
  });

  it("an existing plan with only events still reads, and keeps attributes empty", () => {
    const c = config({ events: [{ region: "nav", event: "menu_click" }] });
    expect(c.attributes).toEqual([]);
    expect(c.events[0]?.params).toEqual([]);
  });
});

describe("tracking attributes: which links lack them", () => {
  it("reports every nav link with no data-track and counts the ones that have it", () => {
    const p = page(
      `<nav><a href="/shop" data-track="menu">Shop</a><a href="/hours">Hours</a><a href="/visit" data-track="">Visit</a></nav>`,
    );
    const gaps = missingAttributes(p, config(NAV));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ label: "nav links", total: 3 });
    expect(gaps[0]?.missing.map((m) => [m.text, m.destination, m.attributes])).toEqual([
      ["Hours", "https://roast.example/hours", ["data-track"]],
      ["Visit", "https://roast.example/visit", ["data-track"]],
    ]);
  });

  it("an attribute with no value at all counts as present only when it has text", () => {
    const p = page(`<nav><a href="/a" data-track>A</a><a href="/b" data-track="x">B</a></nav>`);
    expect(missingAttributes(p, config(NAV))[0]?.missing.map((m) => m.text)).toEqual(["A"]);
  });

  it("names each attribute a link lacks when several are required", () => {
    const p = page(`<nav><a href="/a" data-track="x">A</a><a href="/b">B</a></nav>`);
    const gaps = missingAttributes(
      p,
      config({ attributes: [{ region: "nav", require: ["data-track", "data-parent"] }] }),
    );
    expect(gaps[0]?.missing.map((m) => [m.text, m.attributes])).toEqual([
      ["A", ["data-parent"]],
      ["B", ["data-track", "data-parent"]],
    ]);
  });

  it("reads the region the way the click plan does: a nav inside a header is nav, the body is main", () => {
    const p = page(
      `<header><a href="/logo">Logo</a><nav><a href="/in-nav">In nav</a></nav></header><main><a href="/body">Body</a></main><footer><a href="/f">Foot</a></footer>`,
    );
    const names = (region: string) =>
      missingAttributes(p, config({ attributes: [{ region, require: ["x"] }] }))[0]?.missing.map(
        (m) => m.text,
      );
    expect(names("nav")).toEqual(["In nav"]);
    expect(names("header")).toEqual(["Logo"]);
    expect(names("footer")).toEqual(["Foot"]);
    expect(names("main")).toEqual(["Body"]);
  });

  it("a selector rule reads any element it matches, a button included, and an invalid selector matches nothing", () => {
    const p = page(
      `<button class="book">Book</button><button class="book" data-track="b">Book 2</button>`,
    );
    const gaps = missingAttributes(
      p,
      config({ attributes: [{ selector: "button.book", require: ["data-track"] }] }),
    );
    expect(gaps[0]).toMatchObject({ label: "button.book", total: 2 });
    expect(gaps[0]?.missing.map((m) => m.text)).toEqual(["Book"]);
    expect(
      missingAttributes(p, config({ attributes: [{ selector: "a[[", require: ["x"] }] })),
    ).toEqual([]);
  });

  it("a rule that matches nothing, and links that all have the attribute, give no gap", () => {
    expect(missingAttributes(page("<p>x</p>"), config(NAV))).toEqual([]);
    expect(
      missingAttributes(page(`<nav><a href="/a" data-track="x">A</a></nav>`), config(NAV)),
    ).toEqual([]);
  });

  it("links without an address a person can follow are not links to judge", () => {
    const p = page(
      `<nav><a name="top">Anchor</a><a href="javascript:void(0)">Script</a><a href="/a">A</a></nav>`,
    );
    expect(missingAttributes(p, config(NAV))[0]).toMatchObject({ total: 1 });
  });
});

describe("tracking-attributes-missing: the check", () => {
  const ctx = (c?: EventsConfig): CheckContext => ({
    warn: () => undefined,
    ...(c ? { eventsConfig: c } : {}),
  });
  const html = `<nav><a href="/shop" data-track="menu">Shop</a><a href="/hours">Hours</a><a href="/visit">Visit</a><a href="/gifts">Gifts</a><a href="/about">About</a></nav>`;

  it("is registered, and runs only when a plan is given", async () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("tracking-attributes-missing");
    expect(await trackingAttributesMissing.run(page(html), ctx())).toEqual([]);
    expect(
      await trackingAttributesMissing.run(
        page(html),
        ctx(config({ events: [{ region: "nav", event: "e" }] })),
      ),
    ).toEqual([]);
  });

  it("one finding per rule, with the count, the attribute and the first three links", async () => {
    const found = await trackingAttributesMissing.run(page(html), ctx(config(NAV)));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "tracking-attributes-missing",
      severity: "medium",
      url: "https://roast.example/",
    });
    expect(found[0]?.evidence).toBe(
      'nav links: 4 of 5 have no data-track: "Hours" (/hours), "Visit" (/visit), "Gifts" (/gifts) and 1 more',
    );
  });

  it("two rules that both fail are two findings; a passing rule is silent", async () => {
    const found = await trackingAttributesMissing.run(
      page(`${html}<footer><a href="/privacy" data-track="f">Privacy</a></footer>`),
      ctx(
        config({
          attributes: [
            { region: "nav", require: ["data-track"] },
            { region: "footer", require: ["data-track"] },
            { region: "nav", require: ["data-parent"] },
          ],
        }),
      ),
    );
    expect(found.map((f) => f.evidence.split(":")[0])).toEqual(["nav links", "nav links"]);
    expect(found[1]?.evidence).toContain("have no data-parent");
  });

  it("makes no request: it reads the HTML already fetched", () => {
    expect(trackingAttributesMissing.tech).toMatch(/^no request\./);
  });
});

describe("tracking attributes: a plan with no events", () => {
  it("leaves the click checks silent: there is nothing to click, so nothing could not be checked", async () => {
    const { eventsFire } = await import("../events-fire.js");
    const { eventsDistinct } = await import("../events-distinct.js");
    const { lazyEvents } = await import("../../events/observe.js");
    const c = config(NAV);
    const p = page(`<nav><a href="/a">A</a></nav>`);
    const notes: string[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      eventsConfig: c,
      events: lazyEvents({ page: p, config: c }),
      couldNotCheck: (_u, r) => notes.push(r),
    };
    expect(await eventsFire.run(p, ctx)).toEqual([]);
    expect(await eventsDistinct.run(p, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });
});
