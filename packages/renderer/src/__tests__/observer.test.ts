import { Readable } from "node:stream";
import type { ClickTarget, ObserveResult, Transport } from "@gaugeline/core";
import { describe, expect, it, vi } from "vitest";
import { createClickObserver } from "../observer.js";

/**
 * The click observer against a fake browser: which elements it will click, what it does after a click
 * that navigates, how far the Tab key goes. The real browser is in observer.e2e.test.ts.
 */

type Inspection = { found: boolean; isLink?: boolean; inForm?: boolean; visible?: boolean };
interface Scenario {
  inspect: Record<string, Inspection>;
  /** Paths whose click changes the address. */
  navigates?: string[];
  /** Answers to the focus expression, one a Tab press. */
  focus?: number[];
  consentPath?: string | null;
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
  };
  const transport: Transport = () =>
    Promise.resolve({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Readable.from([Buffer.from("<p>ok</p>")]),
    });
  const browser = {
    newContext: () => {
      log.contexts += 1;
      let handler: ((route: unknown) => Promise<void>) | undefined;
      let url = "https://site.example/";
      let mark = 1;
      let focusAt = 0;
      const main = { page: () => page };
      const page = {
        on: () => undefined,
        mainFrame: () => main,
        url: () => url,
        goto: async (to: string) => {
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
            click: () => {
              log.clicks.push(path);
              if (s.navigates?.includes(path)) {
                url = `https://site.example/after-${path}`;
                mark += 1;
              }
              return Promise.resolve();
            },
          }),
        }),
        keyboard: { press: (k: string) => (log.presses.push(k), Promise.resolve()) },
        evaluate: (expr: string) => {
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
        exposeFunction: () => Promise.resolve(),
        newPage: () => Promise.resolve(page),
        close: () => Promise.resolve(),
      });
    },
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
const OK: Inspection = { found: true, isLink: true, inForm: false, visible: true };

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

describe("the click observer: a click that navigates", () => {
  it("is reverted by loading the original page again, before the next click", async () => {
    const { o, log } = observer({ inspect: { a1: OK, a2: OK }, navigates: ["a1"] });
    await o.observe(INPUT([target("a1"), target("a2")]));
    // For each width: the page, then the page again after a1 changed the address (a2 did not).
    expect(log.gotos.filter((g) => g === "https://site.example/")).toHaveLength(2 * 3 - 1);
    expect(log.clicks).toEqual(expect.arrayContaining(["a1", "a2"]));
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
