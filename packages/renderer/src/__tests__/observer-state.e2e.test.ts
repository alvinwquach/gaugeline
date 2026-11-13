import { existsSync, readFileSync } from "node:fs";
import {
  CheckRegistry,
  checkSite,
  createFetcher,
  createNetworkTransport,
  defineCheck,
  eventsConfigSchema,
  type EventsRead,
  type PageSnapshot,
  type Transport,
} from "@gaugeline/core";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * What a click may carry into the next, and where it may go, in a real browser: a fresh context for every
 * click, a redirect that leaves the site refused, a link a script made unsafe not clicked, and a plain link
 * the plan lists clicked. Runs only where a browser is installed.
 */
const found = findBrowser({ env: process.env, exists: existsSync, platform: process.platform });
let driver = true;
try {
  await import("playwright-core");
} catch {
  driver = false;
}

describe.skipIf(!driver || !found.ok)("the click observer: state and where a click may go", () => {
  let site: Fixture;
  let renderer: ReturnType<typeof createPlaywrightRenderer>;
  const asked: string[] = [];
  let read: EventsRead | undefined;
  let unusable: string | undefined;

  beforeAll(async () => {
    site = await startFixture("renderer-state");
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
    const config = eventsConfigSchema.parse(
      JSON.parse(readFileSync(`${SITES_DIR}renderer-state/gaugeline.events.json`, "utf8")),
    );
    const probe = defineCheck<PageSnapshot>({
      id: "state-probe",
      area: "Visitors",
      severity: "low",
      title: "Probe",
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
    await checkSite({
      address: site.origin,
      fetcher: createFetcher({ allowPrivate: true, target: site.origin }),
      registry: new CheckRegistry().register(probe),
      events: config,
      ...(renderer.observer ? { eventObserver: renderer.observer } : {}),
    });
    if (read && "unchecked" in read.result && /browser|start/i.test(read.result.unchecked))
      unusable = read.result.unchecked;
  }, 240_000);
  afterAll(async () => {
    await renderer?.close();
    await site?.close();
  });

  const test = (name: string, run: () => void) =>
    it(name, (ctx) => {
      if (unusable) ctx.skip(`the browser does not start here: ${unusable}`);
      run();
    });
  const click = (text: string) => {
    if (!read || "unchecked" in read.result) throw new Error("no observation");
    const path = read.targets.find((t) => t.text === text)?.path;
    return read.result.clicks.find((c) => c.path === path);
  };

  test("a click starts with none of what an earlier click stored: cookie, local and session storage", () => {
    expect(click("Set")?.unobserved).toBeUndefined();
    expect(click("Seen")?.pushes.map((p) => p.data)).toEqual([
      { event: "seen", ls: "", ss: "", ck: "" },
    ]);
  });

  test("a same-site link that redirects to another site is not followed there: the other site is never asked", () => {
    expect(click("Redir")?.refusedNavigation).toEqual(["redirected.example"]);
    expect(asked.filter((a) => a.includes("redirected.example"))).toEqual([]);
  });

  test("a link a script made a javascript: address is not clicked", () => {
    expect(click("Swap")?.unobserved).toMatch(/not a web address/);
  });

  test("a link that swaps itself for a button as the pointer arrives is not clicked as one: no form is submitted", () => {
    expect(click("Hover")?.unobserved).toBeDefined();
    expect(site.hits.get("/submit-hover")).toBeUndefined();
  });

  test("a form submitted in an iframe's own realm gets nothing: not even a GET with a query", () => {
    expect(click("Frame")?.unobserved).toBeUndefined();
    expect(site.hits.get("/xgetform")).toBeUndefined();
    expect(asked.filter((a) => a.includes("xgetform"))).toEqual([]);
  });

  test("a plain link the plan lists is clicked, as a GET: the plan's author chose it", () => {
    expect(click("Logout")?.unobserved).toBeUndefined();
    expect(site.hits.get("/logout.html")).toBeGreaterThanOrEqual(1);
    expect([...site.methods.keys()].sort()).toEqual(
      ["GET", "HEAD"].filter((m) => site.methods.has(m)),
    );
  });
});
