import { describe, expect, it } from "vitest";
import { NO_OBSERVER, lazyEvents, recordedObserver } from "../../events/observe.js";
import type { ObserveResult } from "../../events/observe.js";
import { eventsConfigSchema, type EventsConfig } from "../../events/types.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot } from "../../snapshot.js";
import { eventsUnlisted } from "../events-unlisted.js";
import { createPageRegistry } from "../index.js";

const HTML = `<nav><ul><li><a href="/shop">Shop</a></li><li><a href="/hours">Hours</a></li></ul></nav>`;
const page = buildSnapshot([
  {
    url: "https://roast.example/",
    status: 200,
    headers: { "content-type": "text/html" },
    body: `<html><body>${HTML}</body></html>`,
    ms: 1,
  },
]);
const config: EventsConfig = eventsConfigSchema.parse({
  events: [{ region: "nav", event: "menu_click", params: ["link_text"] }],
});
const PATHS = [
  "body > nav > ul > li:nth-of-type(1) > a",
  "body > nav > ul > li:nth-of-type(2) > a",
];
const push = (atMs: number, data: Record<string, unknown>) => ({ atMs, data });

function ctxFor(recording?: ObserveResult, c: EventsConfig = config) {
  const unchecked: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    eventsConfig: c,
    events: lazyEvents({
      page,
      config: c,
      ...(recording ? { observer: recordedObserver(recording) } : {}),
    }),
    couldNotCheck: (_u, r) => unchecked.push(r),
  };
  return { ctx, unchecked };
}

describe("events-unlisted", () => {
  it("is a registered page check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("events-unlisted");
  });

  it("without an observer it is could-not-check with the same reason as the click checks", async () => {
    const { ctx, unchecked } = ctxFor();
    expect(await eventsUnlisted.run(page, ctx)).toEqual([]);
    expect(unchecked).toEqual([NO_OBSERVER]);
  });

  it("does nothing for a plan with no events, or no plan", async () => {
    const attrs = eventsConfigSchema.parse({ attributes: [{ region: "nav", require: ["x"] }] });
    const { ctx, unchecked } = ctxFor(undefined, attrs);
    expect(await eventsUnlisted.run(page, ctx)).toEqual([]);
    expect(unchecked).toEqual([]);
    expect(await eventsUnlisted.run(page, { warn: () => undefined })).toEqual([]);
  });

  it("an event the click sent that the plan does not name is a finding that names the element and the event", async () => {
    const { ctx } = ctxFor({
      clicks: [
        {
          path: PATHS[0]!,
          pushes: [
            push(80, { event: "menu_click", link_text: "Shop" }),
            push(90, { event: "select_content", item: "shop" }),
          ],
          blocked: [],
        },
        {
          path: PATHS[1]!,
          pushes: [push(80, { event: "menu_click", link_text: "Hours" })],
          blocked: [],
        },
      ],
    });
    const found = await eventsUnlisted.run(page, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "events-unlisted", severity: "low" });
    expect(found[0]?.evidence).toBe(
      '"Shop" (/shop) sent select_content, which is not in the plan: {"event":"select_content","item":"shop"}',
    );
  });

  it("the tag manager's own events (gtm.*) are not the plan's business, and the same unlisted event on several links is one finding", async () => {
    const { ctx } = ctxFor({
      clicks: PATHS.map((path) => ({
        path,
        pushes: [
          push(10, { event: "gtm.linkClick" }),
          push(20, { event: "gtm.click" }),
          push(30, { event: "scroll_depth", percent: 50 }),
        ],
        blocked: [],
      })),
    });
    const found = await eventsUnlisted.run(page, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      '2 links sent scroll_depth, which is not in the plan: "Shop" (/shop), "Hours" (/hours)',
    );
  });

  it("a push with no event name, or a late one, is left to the plan checks", async () => {
    const { ctx } = ctxFor({
      clicks: [
        {
          path: PATHS[0]!,
          pushes: [push(10, { foo: 1 }), push(9000, { event: "late_one" })],
          blocked: [],
        },
      ],
    });
    expect(await eventsUnlisted.run(page, ctx)).toEqual([]);
  });

  it("an event named by any line of the plan is listed, whichever element sent it", async () => {
    const two = eventsConfigSchema.parse({
      events: [
        { region: "nav", event: "menu_click" },
        { selector: "button.book", event: "book_click" },
      ],
    });
    const { ctx } = ctxFor(
      { clicks: [{ path: PATHS[0]!, pushes: [push(10, { event: "book_click" })], blocked: [] }] },
      two,
    );
    expect(await eventsUnlisted.run(page, ctx)).toEqual([]);
  });
});
