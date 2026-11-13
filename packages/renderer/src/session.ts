import { isAnalyticsRequest, type EgressGate, type GateRequest } from "@gaugeline/core";
import type * as Playwright from "playwright-core";
import { FORM_COUNTER, FORM_GUARD, NETWORK_GUARD } from "./page-script.js";

/**
 * One browser context and one page, wired to an egress gate: the part both the renderer and the click
 * observer need, so the rules the browser is held to are written once. Every request the page makes is
 * answered by the gate (never by the browser's own network); a WebSocket is closed unconnected; windows are
 * closed and dialogs dismissed; a form guard and a network guard run before the page's own scripts. The
 * context has no state: no cookie, storage, login, permission, service worker or download.
 */

export interface AnalyticsAttempt {
  url: string;
  method: string;
  postData: string | undefined;
}

export interface OpenOptions {
  viewport: { width: number; height: number };
  gate: EgressGate;
  now: () => number;
  /** Told of each request to an analytics host the page makes, before the gate aborts it. */
  onAnalytics?: (attempt: AnalyticsAttempt) => void;
  /** Functions the page may call by name (the observer's capture of a push). They only receive what the page sends: data. */
  bindings?: Readonly<Record<string, (...args: never[]) => void>>;
  /**
   * Asked for each document the main frame is about to load. False: it is aborted and `onNavigationRefused` is
   * told, and nothing is asked of that address: how a click is kept from leaving the page's site, whether the
   * link says so or a redirect on the same site does.
   */
  allowNavigation?: (url: URL) => boolean;
  onNavigationRefused?: (url: URL) => void;
  /**
   * Asked for each document a frame INSIDE the page is about to load. True: it is aborted and
   * `onNavigationRefused` is told. The observer says true while a click is under way: the plan's link
   * navigates the page itself, so a frame that loads a document then is something the click made (an iframe a
   * handler built to submit a form in, say), and nothing is asked for it.
   */
  blockSubframes?: () => boolean;
  /** More scripts to run before the page's own, in every frame. */
  scripts?: readonly string[];
}

export interface OpenedPage {
  context: Playwright.BrowserContext;
  page: Playwright.Page;
  /** When the gate last started or finished a request, by the run's clock. */
  lastActivity(): number;
}

export async function openPage(b: Playwright.Browser, options: OpenOptions): Promise<OpenedPage> {
  const { gate, now } = options;
  const context = await b.newContext({
    viewport: options.viewport,
    serviceWorkers: "block",
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    locale: "en-US",
    timezoneId: "UTC",
  });
  try {
    const ref: { page?: Playwright.Page } = {};
    /** Addresses the browser reported as the target of a form submission, in any frame or realm. */
    const formNavigations = new Set<string>();
    let lastActivity = now();
    await context.exposeFunction(FORM_COUNTER, () => gate.note("form"));
    for (const [name, fn] of Object.entries(options.bindings ?? {}))
      await context.exposeFunction(name, fn as (...args: unknown[]) => void);
    await context.addInitScript(FORM_GUARD);
    await context.addInitScript(NETWORK_GUARD);
    for (const script of options.scripts ?? []) await context.addInitScript(script);
    await context.route(/.*/, async (route) => {
      lastActivity = now();
      const req = route.request();
      let frame: GateRequest["frame"] = "popup";
      try {
        const f = req.frame();
        // A request that belongs to no frame of this page is treated like a window's: refused.
        if (f.page() === ref.page) frame = f === ref.page?.mainFrame() ? "main" : "sub";
      } catch {
        frame = "popup";
      }
      if (req.resourceType() === "document" && formNavigations.has(req.url())) {
        // The browser said this document is the answer to a form being submitted (whatever realm the form
        // is in): a form is never submitted, so nothing is asked for it.
        gate.note("form");
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      if (
        req.resourceType() === "document" &&
        frame === "sub" &&
        options.blockSubframes?.() === true
      ) {
        try {
          options.onNavigationRefused?.(new URL(req.url()));
        } catch {
          // an address that will not parse is refused all the same
        }
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      if (options.allowNavigation && req.resourceType() === "document" && frame === "main") {
        let target: URL | undefined;
        try {
          target = new URL(req.url());
        } catch {
          target = undefined;
        }
        if (target && !options.allowNavigation(target)) {
          options.onNavigationRefused?.(target);
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
      }
      if (options.onAnalytics) {
        let analytics = false;
        try {
          analytics = isAnalyticsRequest(new URL(req.url()));
        } catch {
          analytics = false;
        }
        if (analytics)
          options.onAnalytics({
            url: req.url(),
            method: req.method(),
            postData: req.postData() ?? undefined,
          });
      }
      const answer = await gate.handle({
        url: req.url(),
        method: req.method(),
        kind: req.resourceType(),
        frame,
        headers: req.headers(),
      });
      lastActivity = now();
      if (answer.action === "fulfill")
        await route
          .fulfill({ status: answer.status, headers: answer.headers, body: answer.body })
          .catch(() => undefined);
      else await route.abort("blockedbyclient").catch(() => undefined);
    });
    // A WebSocket is opened on the page's side and never connected to a server.
    await context.routeWebSocket(/.*/, (ws) => {
      gate.note("websocket");
      void ws.close({ code: 1008, reason: "blocked" });
    });
    const page = await context.newPage();
    ref.page = page;
    page.on("popup", (popup) => {
      gate.note("popup");
      void popup.close().catch(() => undefined);
    });
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    // The init scripts guard the form methods of the page's own realm. A page can reach another realm's
    // (an iframe it builds), where a script may not have run, so the browser is also asked to say when a
    // navigation is a form's: that event comes before the request, and the request is then refused above.
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Page.enable");
      cdp.on(
        "Page.frameRequestedNavigation" as never,
        ((event: { reason?: string; url?: string }) => {
          if (
            typeof event?.reason === "string" &&
            event.reason.startsWith("formSubmission") &&
            event.url
          )
            formNavigations.add(event.url);
        }) as never,
      );
    } catch {
      // Not a browser that speaks this: the other guards stand.
    }
    return { context, page, lastActivity: () => lastActivity };
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err;
  }
}
