import { existsSync, readFileSync } from "node:fs";
import { eventsDistinct } from "../../../core/src/checks/events-distinct.js";
import { eventsFire } from "../../../core/src/checks/events-fire.js";
import { eventsParity } from "../../../core/src/checks/events-parity.js";
import { eventsTabOrder } from "../../../core/src/checks/events-tab-order.js";
import { eventsUnlisted } from "../../../core/src/checks/events-unlisted.js";
import {
  CheckRegistry,
  createFetcher,
  createNetworkTransport,
  checkSite,
  defineCheck,
  eventsConfigSchema,
  judgeFocusOrder,
  judgeParity,
  type EventsRead,
  type PageSnapshot,
  type Transport,
} from "@gaugeline/core";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * The click observer in a real browser against the invented bakery and its tracking plan. Runs only where a
 * browser is installed; where it will not start the tests are skipped, saying why.
 */
const found = findBrowser({ env: process.env, exists: existsSync, platform: process.platform });
let driver = true;
try {
  await import("playwright-core");
} catch {
  driver = false;
}
const skipReason = !driver
  ? "playwright-core is not installed"
  : found.ok
    ? undefined
    : "no browser";

describe.skipIf(skipReason !== undefined)("the click observer in a real browser", () => {
  let site: Fixture;
  let renderer: ReturnType<typeof createPlaywrightRenderer>;
  let asked: string[];
  let read: EventsRead | undefined;
  let findings: { checkId: string; evidence: string; severity: string }[] = [];
  let couldNotCheck: { id: string; reason: string }[] = [];
  let unusable: string | undefined;

  const config = eventsConfigSchema.parse(
    JSON.parse(readFileSync(`${SITES_DIR}renderer-clicks/gaugeline.events.json`, "utf8")),
  );

  beforeAll(async () => {
    site = await startFixture("renderer-clicks");
    asked = [];
    const real = createNetworkTransport({ allowPrivate: true, target: site.origin });
    const transport: Transport = (url, req) => {
      asked.push(`${req.method} ${url.href}`);
      return real(url, req);
    };
    renderer = createPlaywrightRenderer({
      transport,
      chromiumSandbox: process.getuid?.() !== 0,
      limits: { pages: 20 },
    });
    const probe = defineCheck<PageSnapshot>({
      id: "observer-probe",
      area: "Visitors",
      severity: "low",
      title: "Observer probe",
      what: "w",
      why: "y",
      fix: "f",
      tech: "t",
      size: "S",
      done: "d",
      estimateChanges: "e",
      run: async (_p, ctx) => {
        read = await ctx.events?.();
        return [];
      },
    });
    const { result } = await checkSite({
      address: site.origin,
      fetcher: createFetcher({ allowPrivate: true, target: site.origin }),
      registry: new CheckRegistry()
        .register(probe)
        .register(eventsFire)
        .register(eventsParity)
        .register(eventsTabOrder)
        .register(eventsUnlisted)
        .register(eventsDistinct),
      events: config,
      ...(renderer.observer ? { eventObserver: renderer.observer } : {}),
    });
    findings = result.findings;
    couldNotCheck = result.couldNotCheck.map((c) => ({ id: c.id, reason: c.reason }));
    if (
      read &&
      "unchecked" in read.result &&
      /could not start|browser/i.test(read.result.unchecked)
    )
      unusable = read.result.unchecked;
  }, 240_000);
  afterAll(async () => {
    await renderer?.close();
    await site?.close();
  });

  const test = (name: string, run: () => void | Promise<void>) =>
    it(name, async (ctx) => {
      if (unusable) ctx.skip(`the browser does not start here: ${unusable}`);
      await run();
    });

  const clicksOf = (which: "clicks" | "phone") => {
    if (!read || "unchecked" in read.result) throw new Error("no observation");
    return read.result[which] ?? [];
  };
  const byText = () => {
    if (!read) throw new Error("no read");
    return new Map(read.targets.map((t) => [t.text, t.path]));
  };
  const clickFor = (which: "clicks" | "phone", text: string) =>
    clicksOf(which).find((c) => c.path === byText().get(text));

  test("reads what each link reported at the desktop width: dataLayer, gtag and a blocked beacon", () => {
    expect(clickFor("clicks", "Shop")?.pushes.map((p) => p.data)).toEqual([
      { event: "menu_click", link_text: "Shop", link_url: "/shop.html" },
    ]);
    expect(clickFor("clicks", "Menu")?.pushes).toEqual([]);
    expect(clickFor("clicks", "Visit")?.pushes.map((p) => p.data)).toEqual([
      { event: "menu_click", link_text: "Visit", link_url: "/visit.html" },
    ]);
    const book = clickFor("clicks", "Book");
    expect(book?.sent?.map((s) => [s.name, s.params])).toEqual([
      ["book_click", { link_text: "Book" }],
    ]);
    expect(book?.blocked).toEqual(["www.google-analytics.com"]);
    expect(clickFor("clicks", "Deal")?.pushes.map((p) => p.data.event)).toEqual(["partner_click"]);
  });

  test("clicks links only: a button, a link in a form and a link to an unlisted site are not observed", () => {
    for (const text of ["Order", "In a form", "Partner"]) {
      const c = clickFor("clicks", text);
      expect(c?.unobserved, text).toBeDefined();
      expect(c?.pushes).toEqual([]);
    }
    expect(clickFor("clicks", "Order")?.unobserved).toMatch(/not a link/);
    expect(clickFor("clicks", "In a form")?.unobserved).toMatch(/form/);
    expect(clickFor("clicks", "Partner")?.unobserved).toMatch(/another site/);
  });

  test("never asks another site, never sends a POST, and the site sees only GETs", () => {
    expect(
      asked.filter((a) => /partner\.example|google-analytics|googletagmanager/.test(a)),
    ).toEqual([]);
    expect(asked.every((a) => a.startsWith("GET ") || a.startsWith("HEAD "))).toBe(true);
    expect([...site.methods.keys()].sort()).toEqual(["GET"]);
    // The links that navigate were reverted by loading the first page again, not left open.
    expect(site.hits.get("/shop.html")).toBeGreaterThanOrEqual(1);
    expect(site.hits.get("/")).toBeGreaterThan(2);
  });

  test("clicks once per listed link: no link's page is asked for twice by two clicks", () => {
    expect(site.hits.get("/shop.html")).toBe(2);
  });

  test("reads the phone: a link hidden at that width is not observed, one that reports only wide is silent", () => {
    expect(clickFor("phone", "Hours")?.unobserved).toMatch(/not visible at 375/);
    expect(clickFor("phone", "Jobs")?.pushes).toEqual([]);
    expect(clickFor("clicks", "Jobs")?.pushes.length).toBe(1);
    if (!read) throw new Error("no read");
    expect(judgeParity(read).rows.map((r) => r.target.text)).toEqual(["Jobs"]);
  });

  test("reads the order the keyboard reaches the listed links in", () => {
    if (!read) throw new Error("no read");
    const order = judgeFocusOrder(read);
    // Menu has tabindex 1: it takes focus before Shop, which is first in the page.
    expect(order.outOfOrder.map((o) => o.target.text)).toEqual(["Menu"]);
    expect(order.unreachable.map((t) => t.text)).toEqual([]);
  });

  test("feeds the checks: the silent link is a finding, the links left unclicked are could not check", () => {
    expect(
      findings.filter((f) => f.checkId === "events-fire").map((f) => [f.checkId, f.evidence]),
    ).toEqual([["events-fire", `"Menu" (/menu.html) sent no menu_click event`]]);
    const fire = couldNotCheck.filter((c) => c.id === "events-fire");
    expect(fire).toHaveLength(1);
    expect(fire[0]?.reason).toMatch(
      /^3 of the plan's links could not be observed \("Partner" .*"Order".*"In a form"/,
    );
  });

  test("the phone against the desktop: the link that reports only on a wide screen is a finding", () => {
    expect(findings.filter((f) => f.checkId === "events-parity").map((f) => f.evidence)).toEqual([
      '"Jobs" (/jobs.html) reports differently at 375 px than at 1280 px: sent menu_click at 1280 px and nothing at 375 px',
    ]);
    // The link hidden at 375 px, the link to another site, the button and the link in a form were not compared.
    const parity = couldNotCheck.filter((c) => c.id === "events-parity");
    expect(parity).toHaveLength(1);
    expect(parity[0]?.reason).toMatch(
      /^4 of the plan's links could not be compared at both widths \("Hours"/,
    );
  });

  test("the keyboard: the link with a positive tabindex jumps the queue, and is named for both", () => {
    expect(
      findings.filter((f) => f.checkId === "events-tab-order").map((f) => [f.severity, f.evidence]),
    ).toEqual([
      [
        "low",
        `1 of the plan's links takes focus in a different place than it comes in the page: "Menu" (/menu.html) is reached 1st but comes 2nd`,
      ],
      [
        "low",
        `1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "Menu" (/menu.html) has tabindex="1"`,
      ],
    ]);
    // The links that were not clicked could not be followed with the keyboard either: not a pass.
    const tab = couldNotCheck.filter((c) => c.id === "events-tab-order");
    expect(tab).toHaveLength(1);
    expect(tab[0]?.reason).toMatch(/could not be looked at with the keyboard/);
  });
});

describe.skipIf(skipReason === undefined)("the click observer without a browser", () => {
  it(`is skipped here: ${skipReason ?? ""}`, () => {
    expect(skipReason).toBeDefined();
  });
});
