import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import {
  findLowContrast,
  focusJumps,
  landmarkProblems,
  motionProblem,
  unnamedControls,
  type RenderResult,
  type RenderedPage,
  type Transport,
} from "@gaugeline/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_PATH_VARIABLE, findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * The accessibility probe (N16) in a real browser, over two invented pages served from memory (no socket, no
 * network): Quillfeather Bakery as it is built badly, and the same page built well. Runs only where a browser is
 * installed and starts.
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

const BAD = `<!doctype html><html lang="en"><head><title>Quillfeather Bakery</title>
<style>
body { margin: 0; font: 16px sans-serif; color: #000; background: #fff; }
.faint { color: #cccccc; }
.hero { background-image: linear-gradient(#ffffff, #000000); color: #888888; }
.spin { display: inline-block; animation: spin 1s infinite linear; }
@keyframes spin { to { transform: rotate(1turn); } }
a, button, input { display: block; margin: 12px 0; }
</style></head>
<body>
<div class="top"><nav><a href="/menu">Menu</a></nav><nav><a href="/visit">Visit</a></nav></div>
<p class="faint">Fresh bread, baked at dawn.</p>
<p class="hero">Text over a gradient.</p>
<a href="/order" tabindex="3">Order</a>
<a href="/home">Home</a>
<button id="cart"></button>
<input type="text">
<div role="button">Buy now</div>
<span class="spin">*</span>
</body></html>`;

const GOOD = `<!doctype html><html lang="en"><head><title>Quillfeather Bakery</title>
<style>
body { margin: 0; font: 16px sans-serif; color: #000; background: #fff; }
.spin { display: inline-block; animation: spin 1s infinite linear; }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
a, button, input { display: block; margin: 12px 0; }
</style></head>
<body>
<header><nav aria-label="Main menu"><a href="/menu">Menu</a></nav></header>
<main>
<h1>Quillfeather Bakery</h1>
<p>Fresh bread, baked at dawn.</p>
<a href="/order">Order</a>
<button aria-label="Open the basket"></button>
<label for="q">Search</label><input id="q" type="text">
<button>Buy now</button>
<span class="spin">*</span>
</main>
<footer><nav aria-label="Footer menu"><a href="/visit">Visit</a></nav></footer>
</body></html>`;

const TABLE: Record<string, string> = {
  [`${SITE}/bad`]: BAD,
  [`${SITE}/good`]: GOOD,
};

describe.skipIf(skipReason !== undefined)("the accessibility probe in a real browser", () => {
  let renderer: ReturnType<typeof createPlaywrightRenderer>;
  let unusable: string | undefined;
  const asked: { url: string; method: string }[] = [];
  const transport: Transport = (url, req) => {
    asked.push({ url: url.href, method: req.method });
    const body = TABLE[url.href];
    return Promise.resolve({
      status: body ? 200 : 404,
      headers: { "content-type": "text/html" },
      body: Readable.from([Buffer.from(body ?? "not found")]),
    });
  };
  const test = (name: string, run: () => Promise<void>, timeout = 60_000) =>
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
      limits: { pages: 50, ms: 20_000 },
    });
    const probe = await renderer.render({ url: `${SITE}/good` });
    if (probe.kind === "could-not-check" && /could not start/.test(probe.reason))
      unusable = probe.reason;
  }, 60_000);
  afterAll(async () => {
    await renderer?.close();
  });

  const read = async (path: string) => {
    const r: RenderResult = await renderer.render({
      url: `${SITE}${path}`,
      expose: { a11y: true, text: false, links: false },
    });
    expect(r.kind, JSON.stringify(r)).toBe("rendered");
    const a = (r as RenderedPage).a11y;
    expect(a).toBeDefined();
    return a!;
  };

  test("a page that is not asked for the facts carries none", async () => {
    const r = await renderer.render({ url: `${SITE}/good` });
    expect((r as RenderedPage).a11y).toBeUndefined();
  });

  test("contrast: the faint grey fails, black on white passes, text on a gradient is not computed", async () => {
    const a = await read("/bad");
    const out = findLowContrast(a.text);
    expect(out.low.map((l) => [l.examples[0], l.required])).toEqual([
      ["Fresh bread, baked at dawn.", 4.5],
    ]);
    expect(out.low[0]?.ratioHundredths).toBe(160);
    expect(out.unknown).toBe(1);
    const good = findLowContrast((await read("/good")).text);
    expect(good.low).toEqual([]);
    expect(good.unknown).toBe(0);
  });

  test("focus order: the positive tabindex comes first, and the page's own order is read after it", async () => {
    const a = await read("/bad");
    expect(a.focusables.map((f) => f.name || `<${f.tag}>`)).toEqual([
      "Order",
      "Menu",
      "Visit",
      "Home",
      "<button>",
      "<input>",
    ]);
    expect(focusJumps(a.focusables).positive).toEqual([{ name: "Order", tabindex: 3 }]);
    expect(focusJumps((await read("/good")).focusables).positive).toEqual([]);
  });

  test("names and roles: the empty button and the field have no name, the div with a role cannot be reached", async () => {
    const a = await read("/bad");
    expect(unnamedControls(a.focusables).map((f) => f.tag)).toEqual(["button", "input"]);
    expect(a.unreachable).toEqual([{ tag: "div", role: "button", name: "Buy now" }]);
    const good = await read("/good");
    expect(unnamedControls(good.focusables)).toEqual([]);
    expect(good.unreachable).toEqual([]);
    expect(
      good.focusables.find((f) => f.tag === "button" && f.name === "Open the basket"),
    ).toBeDefined();
    expect(good.focusables.find((f) => f.tag === "input")?.name).toBe("Search");
  });

  test("landmarks: no main and two unnamed navs, against a well-formed page", async () => {
    expect(landmarkProblems((await read("/bad")).landmarks)).toEqual([
      { kind: "no-main" },
      { kind: "same-role", role: "navigation", count: 2 },
    ]);
    expect(landmarkProblems((await read("/good")).landmarks)).toEqual([]);
  });

  test("reduced motion: the endless spin has no rule on one page and a rule on the other", async () => {
    const bad = (await read("/bad")).motion;
    expect(bad.animations).toBeGreaterThanOrEqual(1);
    expect(bad.endless).toBeGreaterThanOrEqual(1);
    expect(motionProblem(bad)).toMatchObject({ kind: "no-rule" });
    const good = (await read("/good")).motion;
    expect(good.reducedMotionRule).toBe(true);
    expect(motionProblem(good)).toBeUndefined();
  });

  test("it reads and sends nothing: only the page itself was asked for, by GET", async () => {
    asked.length = 0;
    await read("/bad");
    expect(asked).toEqual([{ url: `${SITE}/bad`, method: "GET" }]);
  });
});
