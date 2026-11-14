import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { RenderResult, Transport } from "@gaugeline/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_PATH_VARIABLE, findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * A page that calls the functions Gaugeline gives its scripts (the form counter) 400,000 times in a loop, by name
 * and through Playwright's own controller, in a real browser, over an invented page served from memory. Before the
 * call budget, the driver queued every call: about 13 KB each, over a gigabyte of heap for 100,000 and minutes of
 * time. Now the page is stopped after a thousand calls, marked, and the load says "could not check".
 */
const found = findBrowser({ env: process.env, exists: existsSync, platform: process.platform });
let driverMissing = false;
try {
  await import("playwright-core");
} catch {
  driverMissing = true;
}
const skipReason = driverMissing
  ? "playwright-core is not installed"
  : found.ok
    ? undefined
    : `no Chromium browser was found (${BROWSER_PATH_VARIABLE} unset, none installed)`;

const SITE = "https://quillfeather.example";
const CALLS = 400_000;

const page = (script: string) =>
  `<!doctype html><html><head><title>Flood</title></head><body><h1>Quillfeather Bakery</h1><script src="${script}"></script></body></html>`;
const TABLE: Record<string, [string, string]> = {
  [`${SITE}/ok`]: ["text/html", page("/none.js")],
  [`${SITE}/none.js`]: ["application/javascript", "window.__ok = 1;"],
  [`${SITE}/by-controller`]: ["text/html", page("/by-controller.js")],
  [`${SITE}/by-controller.js`]: [
    "application/javascript",
    `const c = window.__playwright__binding__controller__;
if (c && c.callBinding) for (let i = 0; i < ${CALLS}; i++) c.callBinding("__gaugelineForm", "");`,
  ],
  [`${SITE}/by-name`]: ["text/html", page("/by-name.js")],
  [`${SITE}/by-name.js`]: [
    "application/javascript",
    `for (let i = 0; i < ${CALLS}; i++) { try { window.__gaugelineForm(); } catch (e) {} }`,
  ],
};

describe.skipIf(skipReason !== undefined)("a flood of calls to the page-callable functions", () => {
  let renderer: ReturnType<typeof createPlaywrightRenderer>;
  let unusable: string | undefined;
  const transport: Transport = (url) => {
    const hit = TABLE[url.href];
    return Promise.resolve({
      status: hit ? 200 : 404,
      headers: { "content-type": hit?.[0] ?? "text/plain" },
      body: Readable.from([Buffer.from(hit?.[1] ?? "not found")]),
    });
  };
  // A load that is not stopped takes minutes, so a short limit makes that a failure, not a wait.
  const test = (name: string, run: () => Promise<void>, timeout = 45_000) =>
    it(
      name,
      async (ctx) => {
        if (unusable) ctx.skip(`the browser does not start here: ${unusable}`);
        await run();
      },
      timeout,
    );
  beforeAll(async () => {
    renderer = createPlaywrightRenderer({
      transport,
      chromiumSandbox: process.getuid?.() !== 0,
      settleMs: 500,
      limits: { pages: 20, ms: 30_000 },
    });
    const probe = await renderer.render({ url: `${SITE}/ok` });
    if (probe.kind === "could-not-check" && /could not start/.test(probe.reason))
      unusable = probe.reason;
  }, 60_000);
  afterAll(async () => {
    await renderer?.close();
  });

  async function flood(url: string): Promise<{ r: RenderResult; ms: number; heapMb: number }> {
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 50);
    const t = Date.now();
    const r = await renderer.render({ url });
    const ms = Date.now() - t;
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    return { r, ms, heapMb: (peak - before) / 1e6 };
  }

  test("a page that is within the budget is read as before", async () => {
    const r = await renderer.render({ url: `${SITE}/ok` });
    expect(r.kind).toBe("rendered");
  });

  test("400,000 calls through Playwright's controller: stopped, marked, bounded in time and memory", async () => {
    const { r, ms, heapMb } = await flood(`${SITE}/by-controller`);
    expect(r.kind).toBe("could-not-check");
    expect(r.kind === "could-not-check" && r.reason).toMatch(/more times than a real page does/);
    // Unbounded, this was minutes and gigabytes: a thousand calls cost the driver a second or so.
    expect(ms).toBeLessThan(30_000);
    expect(heapMb).toBeLessThan(500);
  });

  test("400,000 calls through the name on the window: stopped, marked, bounded", async () => {
    const { r, ms, heapMb } = await flood(`${SITE}/by-name`);
    expect(r.kind).toBe("could-not-check");
    expect(r.kind === "could-not-check" && r.reason).toMatch(/more times than a real page does/);
    expect(ms).toBeLessThan(30_000);
    expect(heapMb).toBeLessThan(500);
  });

  test("the renderer is still usable after a flood", async () => {
    await flood(`${SITE}/by-controller`);
    const r = await renderer.render({ url: `${SITE}/ok` });
    expect(r.kind).toBe("rendered");
  });
});
