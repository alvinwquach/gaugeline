import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
  attributeSpeed,
  createNetworkTransport,
  type RenderResult,
  type RenderedPage,
  type Transport,
} from "@gaugeline/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_PATH_VARIABLE, findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * PERF-02 in a real browser, over an invented bakery served from memory (no socket, no network): a page whose
 * hero picture waits for a "fancy intro" unless the visitor asked for less motion, whose chat widget (a script
 * from another site) holds the main thread for 800 ms, and whose paragraph has a plain fallback for a browser with
 * no JavaScript. Runs only where a browser is installed and starts. The numbers come from a loaded machine, so
 * the margins are wide: the page's delays are 800 ms and 1.5 s.
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
const CDN = "https://cdn.widgets-example.test";

const STORY = "An invented bakery, baking its bread at dawn and selling it by noon. ".repeat(10);
const HTML = `<!doctype html><html lang="en"><head><title>Quillfeather Bakery</title>
<script src="/intro.js"></script>
<script src="${CDN}/chat.js"></script></head>
<body><h1>Quillfeather Bakery</h1>
<noscript><p>${STORY}</p></noscript>
<div id="story"></div></body></html>`;
const INTRO = `const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
setTimeout(() => { const p = document.createElement("p"); p.textContent = ${JSON.stringify(STORY)}; document.getElementById("story").append(p); }, calm ? 0 : 1500);`;
const CHAT = `const t = performance.now(); while (performance.now() - t < 800) {}`;

const TABLE: Record<string, [string, string]> = {
  [`${SITE}/`]: ["text/html", HTML],
  [`${SITE}/intro.js`]: ["application/javascript", INTRO],
  [`${CDN}/chat.js`]: ["application/javascript", CHAT],
  // A page that tries to fool the measurement: it replaces the observer and the functions a page can reach, then
  // holds the main thread for 800 ms. Our observer was created before any of this ran.
  [`${SITE}/liar`]: [
    "text/html",
    `<!doctype html><html><head><title>Liar</title><script src="/liar.js"></script></head><body><h1>Quillfeather Bakery</h1></body></html>`,
  ],
  // A page that goes looking for Playwright's own controller and calls the measurement function directly.
  [`${SITE}/liar2`]: [
    "text/html",
    `<!doctype html><html><head><title>Liar</title><script src="/liar2.js"></script></head><body><h1>Quillfeather Bakery</h1></body></html>`,
  ],
  [`${SITE}/liar2.js`]: [
    "application/javascript",
    `const c = window.__playwright__binding__controller__;
if (c && c.callBinding) for (let i = 0; i < 300; i++) c.callBinding("__gaugelineTask", 5000);`,
  ],
  [`${SITE}/liar.js`]: [
    "application/javascript",
    `window.__gaugelineTask = function () {}; window.__gaugelineTasks = [1e9];
window.PerformanceObserver = function () { this.observe = function () {}; };
const t = performance.now(); while (performance.now() - t < 800) {}`,
  ],
};

describe.skipIf(skipReason !== undefined)("variants and measurement in a real browser", () => {
  let asked: { url: string; method: string }[] = [];
  let renderer: ReturnType<typeof createPlaywrightRenderer>;
  let unusable: string | undefined;
  const transport: Transport = (url, req) => {
    asked.push({ url: url.href, method: req.method });
    const hit = TABLE[url.href];
    return Promise.resolve({
      status: hit ? 200 : 404,
      headers: { "content-type": hit?.[0] ?? "text/plain" },
      body: Readable.from([Buffer.from(hit?.[1] ?? "not found")]),
    });
  };
  const test = (name: string, run: () => Promise<void>, timeout = 120_000) =>
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
      settleMs: 2500,
      limits: { pages: 50, ms: 30_000 },
    });
    const probe = await renderer.render({ url: `${SITE}/` });
    if (probe.kind === "could-not-check" && /could not start/.test(probe.reason))
      unusable = probe.reason;
  }, 60_000);
  afterAll(async () => {
    await renderer?.close();
  });

  const page = (r: RenderResult): RenderedPage => {
    expect(r.kind, JSON.stringify(r)).toBe("rendered");
    return r as RenderedPage;
  };
  async function load(variant: Parameters<typeof renderer.render>[0]["variant"] = {}, sample = 0) {
    asked = [];
    const r = page(
      await renderer.render({
        url: `${SITE}/`,
        variant,
        measure: { sample },
        expose: { text: true },
      }),
    );
    return { r, asked: asked.map((a) => a.url), methods: new Set(asked.map((a) => a.method)) };
  }

  test("the plain load: a late story paragraph and 800 ms held by the chat widget", async () => {
    const { r } = await load();
    expect(r.performance?.lcpMs).toBeGreaterThan(1200);
    expect(r.performance?.tbtMs).toBeGreaterThan(600);
    expect(r.performance?.scriptsRefused).toBe(0);
  });

  test("a load that is not measured carries no timings", async () => {
    asked = [];
    const r = page(await renderer.render({ url: `${SITE}/` }));
    expect(r.performance).toBeUndefined();
  });

  test("reduced motion moves the largest contentful paint and leaves the blocking time", async () => {
    const base = (await load()).r.performance;
    const calm = (await load({ reducedMotion: true })).r.performance;
    expect(calm?.lcpMs).toBeLessThan((base?.lcpMs ?? 0) - 300);
    expect(Math.abs((calm?.tbtMs ?? 0) - (base?.tbtMs ?? 0))).toBeLessThan(300);
  });

  test("no JavaScript: nothing blocks, the text comes from the fallback, and the page reads the same", async () => {
    const base = await load();
    const off = await load({ javaScript: false });
    // Nothing runs, so there are no long tasks to observe: blocking time is not measured, which is not 0.
    expect(off.r.performance).toBeDefined();
    expect("tbtMs" in (off.r.performance ?? {})).toBe(false);
    expect(off.r.performance?.lcpMs).toBeLessThan((base.r.performance?.lcpMs ?? 0) - 800);
    expect(off.r.text).toContain("baking its bread at dawn");
    expect(off.asked).not.toContain(`${SITE}/intro.js`);
    expect(off.asked).not.toContain(`${CDN}/chat.js`);
  });

  test("no third-party scripts: the blocking time goes, the widget is never asked for, the rest is", async () => {
    const free = await load({ blockThirdPartyScripts: true });
    expect(free.r.performance?.scriptsRefused).toBe(1);
    expect(free.r.performance?.tbtMs).toBeLessThan(200);
    expect(free.asked).not.toContain(`${CDN}/chat.js`);
    expect(free.asked).toContain(`${SITE}/intro.js`);
  });

  test("every variant asks for fewer addresses than the plain load, never another, and only GETs", async () => {
    const plain = await load();
    for (const variant of [
      { reducedMotion: true },
      { javaScript: false as const },
      { blockThirdPartyScripts: true },
    ]) {
      const v = await load(variant);
      expect(v.asked.every((u) => plain.asked.includes(u))).toBe(true);
      expect([...v.methods]).toEqual(["GET"]);
    }
  });

  test("attribution over real loads names the change behind each number", async () => {
    const base = [await load({}, 0), await load({}, 1)].map((x) => x.r.performance ?? {});
    const out = attributeSpeed(base, {
      "reduced-motion": (await load({ reducedMotion: true })).r.performance,
      "no-javascript": (await load({ javaScript: false })).r.performance,
      "no-third-party": (await load({ blockThirdPartyScripts: true })).r.performance,
    });
    const has = (variant: string, metric: string) =>
      out.moves.some((m) => m.variant === variant && m.metric === metric);
    expect(has("reduced-motion", "lcp")).toBe(true);
    expect(has("reduced-motion", "tbt")).toBe(false);
    // Not measured with JavaScript off, so it cannot be compared.
    expect(has("no-javascript", "tbt")).toBe(false);
    expect(out.unmeasured).toContainEqual({ variant: "no-javascript", metric: "tbt" });
    expect(has("no-third-party", "tbt")).toBe(true);
  });

  test("a page that calls the measurement function itself is caught when its reports cannot be real", async () => {
    const r = page(
      await renderer.render({
        url: `${SITE}/liar2`,
        measure: { sample: 0 },
        expose: { text: true },
      }),
    );
    // Playwright's controller is reachable from the page, so it can call the function: the 300 reports of 5000 ms
    // are more than the load took, so the page's blocking time is dropped and the page is marked.
    expect(r.performance?.tampered).toBe(true);
    expect("tbtMs" in (r.performance ?? {})).toBe(false);
  });

  test("a page that replaces the observer and writes its own list cannot hide or invent blocking time", async () => {
    const r = page(
      await renderer.render({
        url: `${SITE}/liar`,
        measure: { sample: 0 },
        expose: { text: true },
      }),
    );
    // It held the main thread for 800 ms: about 750 ms over the 50 ms floor, and nowhere near its claim of 1e9.
    expect(r.performance?.tbtMs).toBeGreaterThan(500);
    expect(r.performance?.tbtMs).toBeLessThan(5000);
  });
});

/**
 * The refusal in a real browser on this computer: a page and a "third-party" script on two loopback servers
 * ("127.0.0.1" and "localhost" are different sites). If a refused request were ever continued, the browser's own
 * network would reach the script server (loopback bypasses the closed proxy), so its hit counter is the proof.
 */
describe.skipIf(skipReason !== undefined)(
  "the third-party refusal never lets a request through",
  () => {
    let pageServer: Server;
    let scriptServer: Server;
    let pageOrigin = "";
    let scriptOrigin = "";
    const scriptHits: string[] = [];
    let unusable: string | undefined;
    let renderer: ReturnType<typeof createPlaywrightRenderer>;

    const listen = (server: Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, () => resolve((server.address() as AddressInfo).port)),
      );

    beforeAll(async () => {
      scriptServer = createServer((req, res) => {
        scriptHits.push(req.url ?? "");
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("window.__third = 1;");
      });
      const scriptPort = await listen(scriptServer);
      scriptOrigin = `http://localhost:${scriptPort}`;
      pageServer = createServer((req, res) => {
        if (req.url === "/redirect.js") {
          res.writeHead(302, { location: `${scriptOrigin}/redirected.js` });
          res.end();
        } else if (req.url === "/") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            `<!doctype html><html><head><title>Quillfeather</title><script src="${scriptOrigin}/chat.js"></script><script src="/redirect.js"></script></head><body><h1>Quillfeather Bakery</h1><p>An invented bakery.</p></body></html>`,
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      pageOrigin = `http://127.0.0.1:${await listen(pageServer)}`;
      renderer = createPlaywrightRenderer({
        transport: createNetworkTransport({ allowPrivate: true, target: pageOrigin }),
        chromiumSandbox: process.getuid?.() !== 0,
        limits: { pages: 50, ms: 15_000 },
      });
      const probe = await renderer.render({ url: `${pageOrigin}/` });
      if (probe.kind === "could-not-check" && /could not start/.test(probe.reason))
        unusable = probe.reason;
      scriptHits.length = 0;
    }, 60_000);
    afterAll(async () => {
      await renderer?.close();
      pageServer?.close();
      scriptServer?.close();
    });

    it("refuses the script and the redirect to it, and the script server sees nothing", async (ctx) => {
      if (unusable) ctx.skip(`the browser does not start here: ${unusable}`);
      const r = (await renderer.render({
        url: `${pageOrigin}/`,
        variant: { blockThirdPartyScripts: true },
        measure: { sample: 0 },
      })) as RenderedPage;
      expect(r.kind).toBe("rendered");
      // The direct script and the first-party address that redirects to it: two refusals.
      expect(r.performance?.scriptsRefused).toBe(2);
      expect(scriptHits).toEqual([]);
    }, 60_000);
  },
);
