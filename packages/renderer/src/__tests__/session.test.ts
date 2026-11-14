import { Readable } from "node:stream";
import { createEgressGate, type Transport } from "@gaugeline/core";
import { describe, expect, it, vi } from "vitest";
import { openPage, withoutFragment } from "../session.js";

/**
 * What the browser is held to, with no browser: the layer that answers each request the page makes (navigations
 * that would leave the site, frames a click made, the target of a form), against a fake context. The real browser
 * is in observer.e2e.test.ts and observer-state.e2e.test.ts.
 */

interface Req {
  url: string;
  type?: string;
  from?: "main" | "sub";
}

function setup(options: Partial<Parameters<typeof openPage>[1]> = {}) {
  const asked: string[] = [];
  const transport: Transport = (url) => {
    asked.push(url.href);
    return Promise.resolve({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Readable.from([Buffer.from("<p>ok</p>")]),
    });
  };
  const gate = createEgressGate({ transport });
  let handler: ((route: unknown) => Promise<void>) | undefined;
  let cdpEvent: ((event: unknown) => void) | undefined;
  const main = { parentFrame: () => null, page: () => page };
  const sub = { parentFrame: () => main, page: () => page };
  const page = {
    on: () => undefined,
    mainFrame: () => main,
  };
  const exposed = new Map<string, (...a: unknown[]) => unknown>();
  let closed = 0;
  const context = {
    exposeFunction: (name: string, fn: (...a: unknown[]) => unknown) => (
      exposed.set(name, fn),
      Promise.resolve()
    ),
    addInitScript: () => Promise.resolve(),
    route: (_p: unknown, h: typeof handler) => ((handler = h), Promise.resolve()),
    routeWebSocket: () => Promise.resolve(),
    newPage: () => Promise.resolve(page),
    newCDPSession: () =>
      Promise.resolve({
        send: () => Promise.resolve(),
        on: (_e: string, fn: (event: unknown) => void) => (cdpEvent = fn),
      }),
    close: () => ((closed += 1), Promise.resolve()),
  };
  const browser = { newContext: () => Promise.resolve(context) };
  const request = async (r: Req) => {
    const route = {
      request: () => ({
        url: () => r.url,
        method: () => "GET",
        resourceType: () => r.type ?? "document",
        headers: () => ({}),
        postData: () => null,
        frame: () => (r.from === "sub" ? sub : main),
      }),
      fulfill: vi.fn(() => Promise.resolve()),
      abort: vi.fn(() => Promise.resolve()),
    };
    await handler?.(route);
    return route;
  };
  return {
    asked,
    gate,
    request,
    fireCdp: (event: unknown) => cdpEvent?.(event),
    exposed,
    closedCount: () => closed,
    open: () =>
      openPage(browser as never, {
        viewport: { width: 1280, height: 800 },
        gate,
        now: Date.now,
        ...options,
      }),
  };
}

describe("a navigation that would leave the page's site is refused, whatever asked for it", () => {
  const allow = (u: URL) => u.origin === "https://site.example";

  it("aborts a main-frame document on another origin, tells the caller, and asks nothing of it", async () => {
    const refused: string[] = [];
    const s = setup({
      allowNavigation: allow,
      onNavigationRefused: (u) => refused.push(u.hostname),
    });
    await s.open();
    const route = await s.request({ url: "https://redirected.example/landing" });
    expect(route.abort).toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(refused).toEqual(["redirected.example"]);
    expect(s.asked).toEqual([]);
  });

  it("answers a document on the page's site, and a subresource on any site is the gate's to judge", async () => {
    const s = setup({ allowNavigation: allow });
    await s.open();
    expect((await s.request({ url: "https://site.example/a" })).fulfill).toHaveBeenCalled();
    expect(
      (await s.request({ url: "https://cdn.example/x.js", type: "script" })).fulfill,
    ).toHaveBeenCalled();
  });
});

describe("an address without its fragment", () => {
  it("drops a fragment and keeps the rest, an encoded one included", () => {
    expect(withoutFragment("https://a.example/p?q=1#frag")).toBe("https://a.example/p?q=1");
    expect(withoutFragment("https://a.example/p?q=1%23frag")).toBe(
      "https://a.example/p?q=1%23frag",
    );
    expect(withoutFragment("https://a.example/p#")).toBe("https://a.example/p");
    expect(withoutFragment("not an address#x")).toBe("not an address#x");
  });
});

describe("a frame a click made is not asked for", () => {
  it("aborts a frame's document while a click is under way, and answers it before", async () => {
    let clicking = false;
    const refused: string[] = [];
    const s = setup({
      blockSubframes: () => clicking,
      onNavigationRefused: (u) => refused.push(u.pathname),
    });
    await s.open();
    expect(
      (await s.request({ url: "https://site.example/ad", from: "sub" })).fulfill,
    ).toHaveBeenCalled();
    clicking = true;
    const route = await s.request({ url: "https://site.example/xgetform?q=secret", from: "sub" });
    expect(route.abort).toHaveBeenCalled();
    expect(refused).toEqual(["/xgetform"]);
    expect(s.asked.filter((a) => a.includes("xgetform"))).toEqual([]);
    // The page's own document is the click's to load: only frames inside it are refused.
    expect((await s.request({ url: "https://site.example/next" })).fulfill).toHaveBeenCalled();
  });
});

describe("a form's target is not asked for: the browser says which navigation is a form's", () => {
  it("aborts the document the browser reported as a form submission, in any frame, and counts it", async () => {
    const s = setup();
    await s.open();
    s.fireCdp({ reason: "formSubmissionGet", url: "https://site.example/xgetform?q=secret" });
    for (const from of ["main", "sub"] as const) {
      const route = await s.request({ url: "https://site.example/xgetform?q=secret", from });
      expect(route.abort).toHaveBeenCalled();
    }
    expect(s.asked).toEqual([]);
    expect(s.gate.state.blocked.form).toBe(2);
  });

  it("matches a form whose action has a fragment: the browser's report keeps it, the request does not", async () => {
    const s = setup();
    await s.open();
    s.fireCdp({ reason: "formSubmissionGet", url: "https://site.example/xfrag?q=secret#frag" });
    const route = await s.request({ url: "https://site.example/xfrag?q=secret" });
    expect(route.abort).toHaveBeenCalled();
    expect(s.asked).toEqual([]);
  });

  it("matches a form whose action has a fragment on both sides, and an encoded one that is not a fragment", async () => {
    const s = setup();
    await s.open();
    s.fireCdp({ reason: "formSubmissionGet", url: "https://site.example/a?q=1#x" });
    s.fireCdp({ reason: "formSubmissionGet", url: "https://site.example/b?q=1%23x#y" });
    expect((await s.request({ url: "https://site.example/a?q=1#x" })).abort).toHaveBeenCalled();
    expect((await s.request({ url: "https://site.example/b?q=1%23x" })).abort).toHaveBeenCalled();
    // `%23` is part of the query: a different address than the one without it.
    expect((await s.request({ url: "https://site.example/b?q=1" })).fulfill).toHaveBeenCalled();
  });

  it("does not take a link for a form, or another address for the same", async () => {
    const s = setup();
    await s.open();
    s.fireCdp({ reason: "anchorClick", url: "https://site.example/page" });
    s.fireCdp({ reason: "formSubmissionPost", url: "https://site.example/post" });
    expect((await s.request({ url: "https://site.example/page" })).fulfill).toHaveBeenCalled();
    expect((await s.request({ url: "https://site.example/other" })).fulfill).toHaveBeenCalled();
    expect((await s.request({ url: "https://site.example/post" })).abort).toHaveBeenCalled();
  });
});

describe("a page that floods the functions it can call by name", () => {
  it("is stopped after a thousand calls to the form counter: the count stops, the page is closed and marked", async () => {
    const s = setup();
    const opened = await s.open();
    const counter = s.exposed.get("__gaugelineForm");
    expect(counter).toBeDefined();
    expect(opened.flooded()).toBe(false);
    for (let i = 0; i < 400_000; i += 1) counter?.();
    expect(s.gate.state.blocked.form).toBe(1000);
    expect(opened.flooded()).toBe(true);
    expect(s.closedCount()).toBe(1);
  });

  it("gives each function its own budget, and ignores calls past it without calling the handler", async () => {
    const seen: unknown[] = [];
    const s = setup({ bindings: { __push: (x: unknown) => seen.push(x) } as never });
    const opened = await s.open();
    const push = s.exposed.get("__push");
    for (let i = 0; i < 1500; i += 1) push?.(i);
    expect(seen).toHaveLength(1000);
    expect(opened.flooded()).toBe(true);
    // The form counter has not been used, so it still counts.
    s.exposed.get("__gaugelineForm")?.();
    expect(s.gate.state.blocked.form).toBe(1);
  });

  it("a page that stays within the budget is not marked and not closed", async () => {
    const s = setup();
    const opened = await s.open();
    for (let i = 0; i < 1000; i += 1) s.exposed.get("__gaugelineForm")?.();
    expect(opened.flooded()).toBe(false);
    expect(s.closedCount()).toBe(0);
  });
});
