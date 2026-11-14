import { Readable } from "node:stream";
import type { ClickTarget, ObserveResult, Transport } from "@gaugeline/core";
import { describe, expect, it, vi } from "vitest";
import { acceptPush, createClickObserver } from "../observer.js";
import { OBSERVER_SCRIPT, findLinkByText, inspectExpression } from "../page-script.js";

/**
 * The click observer against a fake browser: which elements it will click, what it does after a click
 * that navigates, how far the Tab key goes. The real browser is in observer.e2e.test.ts.
 */

type Inspection = {
  found: boolean;
  isLink?: boolean;
  inForm?: boolean;
  visible?: boolean;
  webAddress?: boolean;
  crossSite?: boolean;
};
interface Scenario {
  inspect: Record<string, Inspection>;
  /** Paths whose click changes the address. */
  navigates?: string[];
  /** Answers to the focus expression, one a Tab press. */
  focus?: number[];
  consentPath?: string | null;
  /** Run during a click, with the functions the page was given (the page handing over a push, say). */
  during?: (
    bindings: Record<string, (...a: unknown[]) => void>,
    request: (r: { url: string; from?: "main" | "sub" }) => Promise<{ aborted: boolean }>,
  ) => void | Promise<void>;
  /** Every call into the page, and closing a context, never returns. */
  hang?: boolean;
  /** The width at which the page cannot be loaded. */
  failWidth?: number;
}

const target = (path: string, text = path): ClickTarget => ({
  path,
  rule: 0,
  text,
  destination: `https://site.example/${text}`,
  newTab: false,
});
const INPUT = (targets: ClickTarget[], extra = {}) => ({
  page: "https://site.example/",
  targets,
  waitMs: 0,
  ...extra,
});

function fakeBrowser(s: Scenario) {
  const log = {
    clicks: [] as string[],
    gotos: [] as string[],
    presses: [] as string[],
    contexts: 0,
    browserClosed: 0,
  };
  const transport: Transport = () =>
    Promise.resolve({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Readable.from([Buffer.from("<p>ok</p>")]),
    });
  const browser = {
    newContext: (opts?: { viewport?: { width: number } }) => {
      log.contexts += 1;
      const width = opts?.viewport?.width;
      let handler: ((route: unknown) => Promise<void>) | undefined;
      let url = "https://site.example/";
      let mark = 1;
      let focusAt = 0;
      const main = { page: () => page };
      const sub = { page: () => page };
      /** The page asking for a document, as the browser would, answered by whatever guards the context has. */
      const request = async (r: { url: string; from?: "main" | "sub" }) => {
        let aborted = false;
        const route = {
          request: () => ({
            url: () => r.url,
            method: () => "GET",
            resourceType: () => "document",
            headers: () => ({}),
            postData: () => null,
            frame: () => (r.from === "sub" ? sub : main),
          }),
          fulfill: () => Promise.resolve(),
          abort: () => ((aborted = true), Promise.resolve()),
        };
        await handler?.(route);
        return { aborted };
      };
      const bindings: Record<string, (...a: unknown[]) => void> = {};
      const page = {
        on: () => undefined,
        mainFrame: () => main,
        url: () => url,
        goto: async (to: string) => {
          if (width !== undefined && width === s.failWidth) throw new Error("net::ERR_TIMED_OUT");
          log.gotos.push(to);
          url = to;
          mark += 1;
          // The document is served through the gate, as the browser would ask for it.
          const route = {
            request: () => ({
              url: () => to,
              method: () => "GET",
              resourceType: () => "document",
              headers: () => ({}),
              postData: () => null,
              frame: () => main,
            }),
            fulfill: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          };
          await handler?.(route);
          return null;
        },
        locator: (path: string) => ({
          first: () => ({
            click: async () => {
              log.clicks.push(path);
              await s.during?.(bindings, request);
              if (s.navigates?.includes(path)) {
                url = `https://site.example/after-${path}`;
                mark += 1;
              }
            },
          }),
        }),
        keyboard: { press: (k: string) => (log.presses.push(k), Promise.resolve()) },
        evaluate: (expr: string) => {
          if (s.hang) return new Promise(() => undefined);
          if (expr.includes("getBoundingClientRect")) {
            const path = JSON.parse(/\}\)\((".*")\)$/s.exec(expr)?.[1] ?? '""') as string;
            return Promise.resolve(s.inspect[path] ?? { found: false });
          }
          if (expr.includes("__glMark")) return Promise.resolve(mark);
          if (expr.includes("Date.now()")) return Promise.resolve(Date.now());
          if (expr.includes("activeElement")) return Promise.resolve(s.focus?.[focusAt++] ?? -2);
          if (expr.includes("querySelectorAll")) return Promise.resolve(s.consentPath ?? null);
          return Promise.resolve(null);
        },
      };
      return Promise.resolve({
        route: (_p: unknown, h: typeof handler) => ((handler = h), Promise.resolve()),
        routeWebSocket: () => Promise.resolve(),
        addInitScript: () => Promise.resolve(),
        exposeFunction: (name: string, fn: (...a: unknown[]) => void) => (
          (bindings[name] = fn),
          Promise.resolve()
        ),
        newPage: () => Promise.resolve(page),
        close: () => (s.hang ? new Promise<void>(() => undefined) : Promise.resolve()),
      });
    },
    close: () => ((log.browserClosed += 1), Promise.resolve()),
  };
  return { browser, transport, log };
}

function observer(
  s: Scenario,
  extra: { reserve?: () => string | undefined; browser?: unknown } = {},
) {
  const fake = fakeBrowser(s);
  const o = createClickObserver({
    getBrowser: () => Promise.resolve((extra.browser ?? fake.browser) as never),
    transport: fake.transport,
    now: Date.now,
    reserve: extra.reserve ?? (() => undefined),
    settleMs: 0,
  });
  return { o, ...fake };
}
const clicksOf = (r: ObserveResult) => {
  if ("unchecked" in r) throw new Error(`unchecked: ${r.unchecked}`);
  return r;
};
const OK: Inspection = {
  found: true,
  isLink: true,
  inForm: false,
  visible: true,
  webAddress: true,
  crossSite: false,
};

describe("the click observer: links only", () => {
  it("clicks a visible link outside a form, and nothing else, saying why for each it leaves", async () => {
    const { o, log } = observer({
      inspect: {
        a1: OK,
        button: { ...OK, isLink: false },
        inform: { ...OK, inForm: true },
        hidden: { ...OK, visible: false },
        gone: { found: false },
      },
    });
    const r = clicksOf(
      await o.observe(INPUT(["a1", "button", "inform", "hidden", "gone"].map((p) => target(p)))),
    );
    // One click for each width, on the one link that passed.
    expect(log.clicks).toEqual(["a1", "a1"]);
    expect(r.clicks.map((c) => [c.path, c.unobserved])).toEqual([
      ["a1", undefined],
      ["button", expect.stringMatching(/not a link/)],
      ["inform", expect.stringMatching(/form/)],
      ["hidden", expect.stringMatching(/not visible at 1280/)],
      ["gone", expect.stringMatching(/not in the rendered page/)],
    ]);
    expect(r.phone?.[3]?.unobserved).toMatch(/not visible at 375/);
  });

  it("never clicks more than the plan's twenty", async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `a${i}`);
    const { o, log } = observer({ inspect: Object.fromEntries(paths.map((p) => [p, OK])) });
    const r = clicksOf(await o.observe(INPUT(paths.map((p) => target(p)))));
    expect(r.clicks).toHaveLength(20);
    expect(log.clicks).toHaveLength(40);
  });
});

describe("the click observer: every click starts from a fresh page", () => {
  it("opens a fresh browser context and loads the page again for each click, and one for the keyboard", async () => {
    const { o, log } = observer({ inspect: { a1: OK, a2: OK }, navigates: ["a1"] });
    await o.observe(INPUT([target("a1"), target("a2")]));
    // Desktop: two clicks and the Tab read; phone: two clicks. A context is never reused, so no cookie or
    // storage a click set is there for the next.
    expect(log.contexts).toBe(5);
    expect(log.gotos).toHaveLength(5);
    expect(new Set(log.gotos)).toEqual(new Set(["https://site.example/"]));
  });
});

describe("the click observer: guards that need no browser to test", () => {
  it("does not click a link whose address a script changed to something that is not a web address", async () => {
    const { o, log } = observer({ inspect: { a1: { ...OK, webAddress: false } } });
    const r = clicksOf(await o.observe(INPUT([target("a1")])));
    expect(log.clicks).toEqual([]);
    expect(r.clicks[0]?.unobserved).toMatch(/not a web address/);
  });

  it("clicks a link that goes to another site only when the plan named it", async () => {
    const away: Inspection = { ...OK, crossSite: true };
    const unnamed = observer({ inspect: { a1: away } });
    expect(clicksOf(await unnamed.o.observe(INPUT([target("a1")]))).clicks[0]?.unobserved).toMatch(
      /another site/,
    );
    expect(unnamed.log.clicks).toEqual([]);
    const named = observer({ inspect: { a1: away } });
    await named.o.observe(INPUT([{ ...target("a1"), allowCrossSite: true }]));
    expect(named.log.clicks).toEqual(["a1", "a1"]);
  });

  it("is not told a click happened when the page stopped it: it was not on a link", async () => {
    const { o } = observer({
      inspect: { a1: OK },
      during: (b) => b.__glRefused?.("what was clicked was not a link to a web address"),
    });
    const r = clicksOf(await o.observe(INPUT([target("a1")])));
    expect(r.clicks[0]?.unobserved).toMatch(/the click was stopped/);
    expect(r.clicks[0]?.pushes).toEqual([]);
  });

  it("keeps what a page hands over within bounds, whatever the page's own script did", async () => {
    const huge = { event: "e", big: "A".repeat(3_000_000), nested: { a: 1 }, list: [1, 2], ok: 3 };
    const many = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, "v"]));
    const { o } = observer({
      inspect: { a1: OK },
      during: (b) => {
        const t = Date.now() + 1;
        b.__glPush?.({ t, x: huge });
        b.__glPush?.({ t, x: many });
        for (let i = 0; i < 500; i++) b.__glPush?.({ t, x: { event: `e${i}` } });
        b.__glPush?.("not an object");
        b.__glPush?.({ t: "late", x: {} });
      },
    });
    const r = clicksOf(await o.observe(INPUT([target("a1")])));
    const pushes = r.clicks[0]?.pushes ?? [];
    expect(pushes.length).toBeLessThanOrEqual(200);
    const first = pushes[0]?.data as Record<string, unknown>;
    expect(String(first.big).length).toBeLessThanOrEqual(300);
    expect(first).not.toHaveProperty("nested");
    expect(first).not.toHaveProperty("list");
    expect(first.ok).toBe(3);
    expect(Object.keys(pushes[1]?.data ?? {}).length).toBeLessThanOrEqual(30);
  });

  it("acceptPush stops at the total number of characters", () => {
    const kept: { t: number; x: Record<string, unknown> }[] = [];
    const used = { chars: 0 };
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, "x".repeat(300)]),
    );
    for (let i = 0; i < 200; i++) acceptPush({ t: 1, x: wide }, kept, used);
    // About 9,000 characters a push: the 100,000 bound is reached long before 200 pushes.
    expect(used.chars).toBeLessThan(100_000 + 9_500);
    expect(kept.length).toBeLessThan(15);
  });

  it("stops clicking when its time limit passes, not only waiting", async () => {
    const targets = Array.from({ length: 10 }, (_, i) => target(`a${i}`));
    const inspect = Object.fromEntries(targets.map((t) => [t.path, OK]));
    const fake = fakeBrowser({ inspect });
    const o = createClickObserver({
      getBrowser: () => Promise.resolve(fake.browser as never),
      transport: fake.transport,
      now: Date.now,
      reserve: () => undefined,
      settleMs: 0,
      limitMs: 60,
    });
    const r = await o.observe(INPUT(targets, { waitMs: 100 }));
    expect(r).toMatchObject({ unchecked: expect.stringContaining("longer than") });
    const clicksAtReturn = fake.log.clicks.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    // The work stopped: only the clicks already under way finished, not the other 18.
    expect(fake.log.clicks.length).toBeLessThanOrEqual(clicksAtReturn + 2);
    expect(fake.log.clicks.length).toBeLessThan(10);
  });

  it("the page-side guards say what they check (they run in the browser, so these are read, not run)", () => {
    // Every click as it lands: a link, a web address, not in a form, not on or in anything that acts.
    for (const clause of [
      'closest("a[href]")',
      'a.closest("form")',
      "button, input, select, textarea, summary",
      "^https?:$",
      "stopImmediatePropagation",
      "preventDefault",
      "a.origin !== location.origin",
    ])
      expect(OBSERVER_SCRIPT, clause).toContain(clause);
    const inspect = inspectExpression("a");
    for (const clause of [
      'el.tagName === "A"',
      'hasAttribute("href")',
      'closest("form")',
      "^https?:$",
      "el.origin",
    ])
      expect(inspect, clause).toContain(clause);
  });

  it("refuses a frame's document during a click and a document on another site, and answers the page's own", async () => {
    const seen: { sub?: boolean; away?: boolean; own?: boolean } = {};
    const { o } = observer({
      inspect: { a1: OK },
      during: async (_b, request) => {
        seen.sub = (
          await request({ url: "https://site.example/xgetform?q=secret", from: "sub" })
        ).aborted;
        seen.away = (await request({ url: "https://redirected.example/landing" })).aborted;
        seen.own = (await request({ url: "https://site.example/next" })).aborted;
      },
    });
    const r = clicksOf(await o.observe(INPUT([target("a1")])));
    expect(seen).toEqual({ sub: true, away: true, own: false });
    expect(r.clicks[0]?.refusedNavigation).toEqual(["site.example", "redirected.example"]);
  });

  it("finds the consent link outside forms only", () => {
    expect(findLinkByText("Accept")).toContain('!a.closest("form")');
  });
});

describe("the click observer: a page that never returns", () => {
  function hung(extra: { abandonBrowser?: () => Promise<void> } = {}) {
    const fake = fakeBrowser({ inspect: { a1: OK }, hang: true });
    const o = createClickObserver({
      getBrowser: () => Promise.resolve(fake.browser as never),
      transport: fake.transport,
      now: Date.now,
      reserve: () => undefined,
      settleMs: 0,
      limitMs: 40,
      closeMs: 30,
      ...extra,
    });
    return { o, ...fake };
  }

  it("closes the browser itself when a page in use will not close at the limit", async () => {
    const abandon = vi.fn(() => Promise.resolve());
    const { o } = hung({ abandonBrowser: abandon });
    expect(await o.observe(INPUT([target("a1")]))).toMatchObject({
      unchecked: expect.stringContaining("longer than"),
    });
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("leaves the browser alone when the pages close", async () => {
    const abandon = vi.fn(() => Promise.resolve());
    const fake = fakeBrowser({ inspect: { a1: OK } });
    const o = createClickObserver({
      getBrowser: () => Promise.resolve(fake.browser as never),
      transport: fake.transport,
      now: Date.now,
      reserve: () => undefined,
      settleMs: 0,
      abandonBrowser: abandon,
    });
    clicksOf(await o.observe(INPUT([target("a1")])));
    expect(abandon).not.toHaveBeenCalled();
  });
});

describe("the click observer: the keyboard", () => {
  it("presses only Tab, reads the listed links in the order they took focus, and stops at the end", async () => {
    const { o, log } = observer({ inspect: { a1: OK, a2: OK }, focus: [1, -1, 0, -2] });
    const r = clicksOf(await o.observe(INPUT([target("a1"), target("a2")])));
    expect(r.focusOrder).toEqual(["a2", "a1"]);
    expect([...new Set(log.presses)]).toEqual(["Tab"]);
    expect(log.presses).toHaveLength(4);
  });

  it("stops after 200 presses when focus never leaves the page", async () => {
    const { o, log } = observer({
      inspect: { a1: OK },
      focus: Array.from({ length: 1000 }, () => -1),
    });
    clicksOf(await o.observe(INPUT([target("a1")])));
    expect(log.presses).toHaveLength(200);
  });
});

describe("the click observer: a read it could not make says why", () => {
  it("names the width a page would not load at, and still returns the desktop read", async () => {
    const { o } = observer({ inspect: { a1: OK }, focus: [0, -2], failWidth: 375 });
    const r = clicksOf(await o.observe(INPUT([target("a1")])));
    expect(r.phone).toBeUndefined();
    expect(r.phoneUnchecked).toMatch(/did not load at 375 px/);
    expect(r.clicks).toHaveLength(1);
    expect(r.focusOrder).toEqual(["a1"]);
  });

  it("a keyboard that never leaves the page is not read as links it never reached", async () => {
    const { o, log } = observer({
      inspect: { a1: OK, a2: OK },
      focus: [0, ...Array.from({ length: 1000 }, () => -1)],
    });
    const r = clicksOf(await o.observe(INPUT([target("a1"), target("a2")])));
    expect(log.presses).toHaveLength(200);
    expect(r.focusOrder).toBeUndefined();
    expect(r.focusUnchecked).toBe(
      "the Tab key was pressed 200 times and had not reached 1 of the plan's links or the end of the page",
    );
  });

  it("after 200 presses with every listed link reached, the order is read as it is", async () => {
    const { o } = observer({
      inspect: { a1: OK, a2: OK },
      focus: [1, 0, ...Array.from({ length: 1000 }, () => -1)],
    });
    const r = clicksOf(await o.observe(INPUT([target("a1"), target("a2")])));
    expect(r.focusOrder).toEqual(["a2", "a1"]);
    expect(r.focusUnchecked).toBeUndefined();
  });
});

describe("the click observer: what it cannot do is not observed, never passed", () => {
  it("says so when there is no browser", async () => {
    const { o } = observer(
      { inspect: {} },
      { browser: { kind: "could-not-check", reason: "no browser", hint: "install one\nmore" } },
    );
    expect(await o.observe(INPUT([target("a1")]))).toEqual({
      unchecked: "no browser. install one",
    });
  });

  it("says so when the run's caps are used up, and starts nothing", async () => {
    const { o, log } = observer(
      { inspect: {} },
      { reserve: () => "the run's page cap is reached" },
    );
    expect(await o.observe(INPUT([target("a1")]))).toEqual({
      unchecked: "the run's page cap is reached",
    });
    expect(log.contexts).toBe(0);
  });

  it("does not click a consent banner that is not a link", async () => {
    const { o, log } = observer({ inspect: { a1: OK }, consentPath: null });
    const r = await o.observe(INPUT([target("a1")], { consent: { accept: "Accept all" } }));
    expect(r).toMatchObject({ unchecked: expect.stringContaining("only links are clicked") });
    expect(log.clicks).toEqual([]);
  });

  it("clicks a consent banner that is a link, once for each width, before the plan's links", async () => {
    const { o, log } = observer({
      inspect: { a1: OK },
      consentPath: "body:nth-of-type(1) > a:nth-of-type(1)",
    });
    clicksOf(await o.observe(INPUT([target("a1")], { consent: { accept: "Accept all" } })));
    expect(log.clicks.slice(0, 2).every((c) => c.startsWith("body:"))).toBe(true);
    expect(log.clicks.filter((c) => c === "a1")).toHaveLength(2);
  });
});

vi.setConfig({ testTimeout: 20000 });
