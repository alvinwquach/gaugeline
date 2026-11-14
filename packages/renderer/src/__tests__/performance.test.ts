import { Readable } from "node:stream";
import type { RenderedPage, Transport } from "@gaugeline/core";
import { describe, expect, it, vi } from "vitest";
import { createPlaywrightRenderer } from "../playwright.js";
import {
  LONGTASK_OBSERVER,
  PLAUSIBLE_TASKS,
  TASK_BINDING,
  createTaskCollector,
  summarise,
  type RawTimeline,
} from "../performance.js";

describe("summarise: whole milliseconds out of what the browser reported", () => {
  const raw = (over: Partial<RawTimeline> = {}): RawTimeline => ({
    startedAtMs: 1_000_000,
    readAtMs: 1_100_000,
    lcpSeconds: [],
    tasksMs: [],
    ...over,
  });

  it("takes the last candidate as the Largest Contentful Paint, from the start of the load", () => {
    expect(summarise(raw({ lcpSeconds: [1000.2, 1000.9, 1001.5] }))).toEqual({
      lcpMs: 1500,
      tbtMs: 0,
    });
  });

  it("has no LCP when the browser reported none, and does not guess one", () => {
    expect(summarise(raw())).toEqual({ tbtMs: 0 });
  });

  it("counts the time of each long task over 50 ms as blocking", () => {
    expect(summarise(raw({ tasksMs: [60, 810, 120, 40, 50] })).tbtMs).toBe(10 + 760 + 70);
  });

  it("does not measure blocking time with JavaScript off: it is absent, never 0", () => {
    const out = summarise(raw({ tasksMs: undefined, lcpSeconds: [1000.5] }));
    expect(out).toEqual({ lcpMs: 500 });
    expect("tbtMs" in out).toBe(false);
    expect(summarise(raw({ tasksMs: undefined }))).toEqual({});
  });

  it("is 0 for a page that ran nothing long", () => {
    expect(summarise(raw({ tasksMs: [10, 49] })).tbtMs).toBe(0);
  });

  it("drops anything that is not a plain non-negative number", () => {
    const out = summarise(
      raw({
        readAtMs: 1_000_000 + 10_000_000,
        tasksMs: [100, "9999", -500, NaN, Infinity, null, {}, [200], 1e12],
      }),
    );
    // 100 -> 50, 1e12 is cut to ten minutes (600000 - 50); the rest are dropped.
    expect(out.tbtMs).toBe(50 + 599_950);
  });

  it("never reports more blocking time than the load took, so a page cannot claim hours", () => {
    const out = summarise(raw({ readAtMs: 1_002_000, tasksMs: [600_000, 600_000, 600_000] }));
    expect(out.tbtMs).toBe(2000);
  });

  it("reads at most 2000 tasks", () => {
    const out = summarise(
      raw({ readAtMs: 1_000_000 + 10_000_000, tasksMs: Array.from({ length: 5000 }, () => 100) }),
    );
    expect(out.tbtMs).toBe(2000 * 50);
  });

  it("never reports a negative time for a paint that is dated before the load", () => {
    expect(
      summarise(raw({ startedAtMs: 5_000_000, readAtMs: 5_100_000, lcpSeconds: [1] })).lcpMs,
    ).toBe(0);
  });

  it("the page-side script reaches no network and keeps nothing a page can read", () => {
    expect(LONGTASK_OBSERVER).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|WebSocket|import\(/);
    // It takes the binding out of the window, and puts nothing of its own in it.
    expect(LONGTASK_OBSERVER).toContain(`delete window[${JSON.stringify(TASK_BINDING)}]`);
    expect(LONGTASK_OBSERVER).not.toMatch(/tasks\s*=\s*\[\]/);
  });

  it("observes the top frame only: the guard comes before the observer is created, and the binding goes first", () => {
    const guard = LONGTASK_OBSERVER.indexOf("window !== window.top");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(LONGTASK_OBSERVER.indexOf("new Observer"));
    expect(guard).toBeLessThan(LONGTASK_OBSERVER.indexOf('observe({ type: "longtask"'));
    expect(guard).toBeGreaterThan(LONGTASK_OBSERVER.indexOf("delete window["));
  });
});

describe("createTaskCollector: reports a page can make, and which cannot be real", () => {
  const at = (elapsed: number) => {
    let t = 1_000_000;
    const c = createTaskCollector(() => t);
    t += elapsed;
    return c;
  };

  it("accepts durations of 50 ms or more that fit in the load so far", () => {
    const c = at(2000);
    for (const v of [50, 60.4, 800]) c.add(v);
    expect(c.tasks).toEqual([50, 60, 800]);
    expect(c.tampered).toBe(false);
  });

  it("marks tampering for anything that is not a number, is under 50, or is longer than the load", () => {
    for (const v of ["60", null, {}, NaN, Infinity, -5, 0, 49, 5000]) {
      const c = at(1000);
      c.add(v);
      expect(c.tampered, String(v)).toBe(true);
      expect(c.tasks).toEqual([]);
    }
  });

  it("marks tampering when the tasks together are longer than the load took", () => {
    const c = at(1000);
    c.add(600);
    c.add(600);
    expect(c.tampered).toBe(true);
  });

  it("marks tampering after more than a plausible number of tasks, and keeps no more than that", () => {
    const c = at(1_000_000);
    for (let i = 0; i < PLAUSIBLE_TASKS; i++) c.add(50);
    expect(c.tampered).toBe(false);
    c.add(50);
    expect(c.tampered).toBe(true);
    expect(c.tasks).toHaveLength(PLAUSIBLE_TASKS);
  });

  it("does not take a plausible invented task for tampering: it cannot be told from a real one", () => {
    const c = at(3000);
    c.add(2575);
    expect(c.tampered).toBe(false);
  });
});

/** The glue, against a fake browser: what a variant asks of the driver, and what it refuses. */
function fakeBrowser(requests: { url: string; type: string }[], tasksDuringLoad: number[] = []) {
  const log = {
    contexts: [] as Record<string, unknown>[],
    initScripts: [] as string[],
    aborted: [] as string[],
    fulfilled: [] as string[],
    /** What happened to each request, in order: the key property is that a refused one is aborted and nothing else. */
    actions: [] as { url: string; action: "abort" | "fulfill" | "continue" }[],
    exposed: [] as string[],
    cdp: 0,
  };
  const exposedFns = new Map<string, (...a: unknown[]) => unknown>();
  const driver = {
    chromium: {
      executablePath: () => "/bundled/chrome",
      launch: vi.fn(() =>
        Promise.resolve({
          newContext: (o: Record<string, unknown>) => {
            log.contexts.push(o);
            let handler:
              | ((route: {
                  request(): unknown;
                  fulfill: (a: { status: number }) => Promise<void>;
                  abort: (reason: string) => Promise<void>;
                  continue: () => Promise<void>;
                }) => Promise<void>)
              | undefined;
            let page: unknown;
            const mainFrame = {};
            const fire = async (r: { url: string; type: string }) => {
              await handler?.({
                request: () => ({
                  url: () => r.url,
                  method: () => "GET",
                  resourceType: () => r.type,
                  headers: () => ({}),
                  frame: () => Object.assign(mainFrame, { page: () => page }),
                }),
                fulfill: () => (
                  log.fulfilled.push(r.url),
                  log.actions.push({ url: r.url, action: "fulfill" }),
                  Promise.resolve()
                ),
                abort: () => (
                  log.aborted.push(r.url),
                  log.actions.push({ url: r.url, action: "abort" }),
                  Promise.resolve()
                ),
                // A request that is continued skips the gate and goes to the browser's own network.
                continue: () => (
                  log.actions.push({ url: r.url, action: "continue" }),
                  Promise.resolve()
                ),
              });
            };
            return Promise.resolve({
              route: (_p: unknown, h: typeof handler) => ((handler = h), Promise.resolve()),
              routeWebSocket: () => Promise.resolve(),
              addInitScript: (s: string) => (log.initScripts.push(String(s)), Promise.resolve()),
              exposeFunction: (name: string, fn: (...a: unknown[]) => unknown) => (
                log.exposed.push(name),
                exposedFns.set(name, fn),
                Promise.resolve()
              ),
              newCDPSession: () => {
                log.cdp += 1;
                return Promise.resolve({
                  send: () => Promise.resolve(),
                  on: () => undefined,
                  detach: () => Promise.resolve(),
                });
              },
              newPage: () => {
                page = {
                  on: () => undefined,
                  mainFrame: () => mainFrame,
                  goto: async (url: string) => {
                    await fire({ url, type: "document" });
                    for (const r of requests) await fire(r);
                    for (const t of tasksDuringLoad) await exposedFns.get("__gaugelineTask")?.(t);
                    return null;
                  },
                  url: () => "https://quillfeather.example/",
                  evaluate: () =>
                    Promise.resolve({
                      title: "Quillfeather",
                      text: "Fresh bread",
                      links: [],
                      html: "",
                      url: "https://quillfeather.example/",
                    }),
                };
                return Promise.resolve(page);
              },
              close: () => Promise.resolve(),
            });
          },
          close: () => Promise.resolve(),
        }),
      ),
    },
  };
  return { driver, log };
}

function glue(
  requests: { url: string; type: string }[],
  opts: {
    limits?: Record<string, number>;
    tasks?: number[];
    redirects?: Record<string, string>;
  } = {},
) {
  const { driver, log } = fakeBrowser(requests, opts.tasks);
  const asked: string[] = [];
  const transport: Transport = (url) => {
    asked.push(url.href);
    const to = opts.redirects?.[url.href];
    if (to)
      return Promise.resolve({ status: 302, headers: { location: to }, body: Readable.from([]) });
    return Promise.resolve({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Readable.from([Buffer.from("<h1>Fresh bread</h1>")]),
    });
  };
  const r = createPlaywrightRenderer({
    transport,
    loadDriver: () => Promise.resolve(driver as never),
    env: {},
    exists: (p) => p === "/bundled/chrome",
    platform: "linux",
    settleMs: 0,
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  return { r, log, asked };
}

const PAGE = "https://quillfeather.example/";
const SCRIPTS = [
  { url: "https://quillfeather.example/app.js", type: "script" },
  { url: "https://cdn.widgets-example.test/chat.js", type: "script" },
  { url: "https://cdn.widgets-example.test/logo.png", type: "image" },
];

describe("the Playwright adapter: variants and measurement (fake browser)", () => {
  it("changes nothing without a variant: no context option, no measurement, no performance in the answer", async () => {
    const { r, log } = glue(SCRIPTS);
    const page = (await r.render({ url: PAGE })) as RenderedPage;
    expect(page.kind).toBe("rendered");
    expect(page.performance).toBeUndefined();
    expect(log.contexts[0]).not.toHaveProperty("reducedMotion");
    expect(log.contexts[0]).not.toHaveProperty("javaScriptEnabled");
    // The one session the page guard opens (Page.enable); the measurement opens none.
    expect(log.cdp).toBe(1);
    expect(log.initScripts.some((s) => s === LONGTASK_OBSERVER)).toBe(false);
  });

  it("forces reduced motion with the context option, and nothing else changes", async () => {
    const { r, log } = glue([]);
    await r.render({ url: PAGE, variant: { reducedMotion: true } });
    expect(log.contexts[0]).toMatchObject({ reducedMotion: "reduce", serviceWorkers: "block" });
    expect(log.contexts[0]).not.toHaveProperty("javaScriptEnabled");
  });

  it("turns JavaScript off with the context option and installs no script of ours in the page", async () => {
    const { r, log } = glue([]);
    await r.render({ url: PAGE, variant: { javaScript: false }, measure: { sample: 0 } });
    expect(log.contexts[0]).toMatchObject({ javaScriptEnabled: false });
    expect(log.initScripts.some((s) => s === LONGTASK_OBSERVER)).toBe(false);
  });

  it("refuses a script from another site before the gate, and still answers the rest through the gate", async () => {
    const { r, log, asked } = glue(SCRIPTS);
    const page = (await r.render({
      url: PAGE,
      variant: { blockThirdPartyScripts: true },
      measure: { sample: 0 },
    })) as RenderedPage;
    expect(log.aborted).toEqual(["https://cdn.widgets-example.test/chat.js"]);
    expect(page.blocked.variant).toBe(1);
    // The page, its own script and the third-party picture (not a script) are asked for; the chat script is not.
    expect(asked).toEqual([
      PAGE,
      "https://quillfeather.example/app.js",
      "https://cdn.widgets-example.test/logo.png",
    ]);
    expect(page.performance?.scriptsRefused).toBe(1);
  });

  it("measures only when asked, installs the long-task observer first, and reports whole numbers", async () => {
    const { r, log } = glue([]);
    const page = (await r.render({ url: PAGE, measure: { sample: 0 } })) as RenderedPage;
    // The page guard's session and the measurement's.
    expect(log.cdp).toBe(2);
    expect(log.initScripts).toContain(LONGTASK_OBSERVER);
    expect(page.performance).toEqual({ tbtMs: 0, scriptsRefused: 0 });
  });

  it("a variant can only take away: the requests it makes are a subset of the plain load's", async () => {
    const plain = glue(SCRIPTS);
    await plain.r.render({ url: PAGE });
    for (const variant of [
      { reducedMotion: true },
      { javaScript: false as const },
      { blockThirdPartyScripts: true },
    ]) {
      const v = glue(SCRIPTS);
      await v.r.render({ url: PAGE, variant });
      expect(v.asked.every((u) => plain.asked.includes(u))).toBe(true);
    }
  });

  it("a refused script is only ever aborted: never continued to the browser's own network, never answered", async () => {
    const { r, log } = glue(SCRIPTS);
    await r.render({ url: PAGE, variant: { blockThirdPartyScripts: true } });
    const refused = "https://cdn.widgets-example.test/chat.js";
    expect(log.actions.filter((x) => x.url === refused)).toEqual([
      { url: refused, action: "abort" },
    ]);
    // And nothing in the whole load skips the gate: no request is continued.
    expect(log.actions.some((x) => x.action === "continue")).toBe(false);
  });

  it("refuses a first-party script that redirects to another site, before the other site is asked", async () => {
    const { r, log, asked } = glue(
      [{ url: "https://quillfeather.example/old.js", type: "script" }],
      {
        redirects: {
          "https://quillfeather.example/old.js": "https://cdn.widgets-example.test/final.js",
        },
      },
    );
    const page = (await r.render({
      url: PAGE,
      variant: { blockThirdPartyScripts: true },
      measure: { sample: 0 },
    })) as RenderedPage;
    expect(asked).toEqual([PAGE, "https://quillfeather.example/old.js"]);
    expect(log.actions.filter((x) => x.url.endsWith("old.js"))).toEqual([
      { url: "https://quillfeather.example/old.js", action: "abort" },
    ]);
    expect(page.performance?.scriptsRefused).toBe(1);
    expect(page.blocked.variant).toBe(1);
  });

  it("without the variant the same redirect is followed by the gate, as any redirect is", async () => {
    const { r, asked } = glue([{ url: "https://quillfeather.example/old.js", type: "script" }], {
      redirects: {
        "https://quillfeather.example/old.js": "https://cdn.widgets-example.test/final.js",
      },
    });
    await r.render({ url: PAGE });
    expect(asked).toContain("https://cdn.widgets-example.test/final.js");
  });

  it("does not take a site that merely ends the same way, or the page's own subdomain, for the other", async () => {
    const { r, log } = glue([
      { url: "https://cdn.quillfeather.example/a.js", type: "script" },
      { url: "https://evilquillfeather.example/b.js", type: "script" },
      { url: "https://quillfeather.example.evil.test/c.js", type: "script" },
    ]);
    await r.render({ url: PAGE, variant: { blockThirdPartyScripts: true } });
    expect(log.aborted).toEqual([
      "https://evilquillfeather.example/b.js",
      "https://quillfeather.example.evil.test/c.js",
    ]);
  });

  it("counts refused scripts towards the request cap: a page that asks for too many is could-not-check", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      url: `https://cdn.widgets-example.test/${i}.js`,
      type: "script",
    }));
    const { r } = glue(many, { limits: { requests: 4 } });
    const out = await r.render({ url: PAGE, variant: { blockThirdPartyScripts: true } });
    expect(out.kind).toBe("could-not-check");
    expect((out as { reason: string }).reason).toContain("more requests than the cap allows");
    // The same page without the variant stays within it only if the gate counted them: one document, six scripts.
    const plain = glue(many, { limits: { requests: 4 } });
    expect((await plain.r.render({ url: PAGE })).kind).toBe("could-not-check");
  });

  it("collects long tasks through a function the page-side script reports to, and reports their sum", async () => {
    const { r, log } = glue([], { tasks: [60] });
    const page = (await r.render({ url: PAGE, measure: { sample: 0 } })) as RenderedPage;
    expect(log.exposed).toContain("__gaugelineTask");
    expect(page.performance?.tbtMs).toBe(10);
    expect(page.performance?.tampered).toBeUndefined();
  });

  it("drops the blocking time of a page that reports tasks that cannot be real, and says it tampered", async () => {
    for (const tasks of [
      [600_000, 600_000],
      [10],
      [Number.NaN],
      Array.from({ length: 300 }, () => 60),
    ]) {
      const { r } = glue([], { tasks });
      const page = (await r.render({ url: PAGE, measure: { sample: 0 } })) as RenderedPage;
      expect(page.performance?.tampered, JSON.stringify(tasks).slice(0, 30)).toBe(true);
      expect("tbtMs" in (page.performance ?? {})).toBe(false);
    }
  });

  it("with JavaScript off, blocking time is not measured: absent, not 0, and no function is exposed", async () => {
    const { r, log } = glue([], { tasks: [900] });
    const page = (await r.render({
      url: PAGE,
      variant: { javaScript: false },
      measure: { sample: 0 },
    })) as RenderedPage;
    expect(page.performance).toEqual({ scriptsRefused: 0 });
    expect(log.exposed).not.toContain("__gaugelineTask");
  });
});
