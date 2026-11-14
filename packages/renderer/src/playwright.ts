import { existsSync } from "node:fs";
import {
  DEFAULT_RENDER_LIMITS,
  DESKTOP_VIEWPORT,
  createEgressGate,
  emptyBlocked,
  readA11y,
  sanitise,
  type BlockReason,
  type CapName,
  type EgressGate,
  type A11yRead,
  type RenderCouldNotCheck,
  type RenderLimits,
  type RenderRequest,
  type RenderResult,
  type RenderedLink,
  type Renderer,
  type Transport,
} from "@gaugeline/core";
import type * as Playwright from "playwright-core";
import {
  BROWSER_PATH_VARIABLE,
  driverHint,
  findBrowser,
  installHint,
  type FindBrowserOptions,
} from "./browser.js";
import { a11yExpression } from "./a11y-script.js";
import { readDomExpression, type DomRead } from "./page-script.js";
import { createClickObserver } from "./observer.js";
import { openPage } from "./session.js";

/**
 * The local Playwright adapter (ADR-0009, accepted in part on 13 Nov 2026): the person's own installed
 * Chromium, started only when a run says `--renderer playwright`, behind the Renderer interface in core.
 *
 * What the browser is allowed to do is decided in core's egress gate, not here. This file hands every
 * request the browser makes to that gate and answers with what the gate says; the browser's own network is
 * pointed at nothing, so a request that somehow skipped the gate would fail rather than leave. It also
 * keeps the browser from state (a fresh context for every page, no cookies, storage, service workers,
 * downloads or permissions), from the engine's secrets (a launch environment with none), and from a page
 * that never ends (caps on time and pages).
 *
 * It clicks nothing, types nothing and submits nothing. Playwright is imported here, lazily, and nowhere
 * else: a run without `--renderer playwright` never loads it.
 */

type Driver = Pick<typeof Playwright, "chromium">;

export interface PlaywrightRendererOptions {
  /** How bytes leave: the fetcher's transport, which refuses private addresses unless the run allows them. */
  transport: Transport;
  limits?: Partial<RenderLimits>;
  /** Where the driver comes from. Default: `import("playwright-core")`, when availability is first looked up or the first page is asked for. */
  loadDriver?: () => Promise<Driver>;
  env?: NodeJS.ProcessEnv;
  exists?: FindBrowserOptions["exists"];
  platform?: NodeJS.Platform;
  /** Chromium's own sandbox. On unless a test that runs as root turns it off. */
  chromiumSandbox?: boolean;
  /** How long the network must be quiet after load before the page is read. */
  settleMs?: number;
  /** The click observation's time limit, in milliseconds. Default 3 minutes. */
  observerLimitMs?: number;
  /** How long a page is given to close at that limit before the browser is closed. Default 2 seconds. */
  observerCloseMs?: number;
  now?: () => number;
}

/** The variables a browser may be started with. Not one of them is a secret. */
const LAUNCH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "windir",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

/**
 * Chromium's switches. The memory cap is the ADR's (1 GiB). WebRTC sends UDP outside the HTTP stack, so it may
 * use UDP only through a proxy, and the proxy goes nowhere (a test launches a browser with exactly these and
 * listens on a UDP port).
 */
export const BROWSER_ARGS: readonly string[] = Object.freeze([
  "--js-flags=--max-old-space-size=1024",
  // Measured on Chromium 1243: the forced policy alone stops it in the headless shell and not in the full
  // browser, the plain policy alone the other way round, so both, with the permission check.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--enforce-webrtc-ip-permission-check",
]);

/** Where the browser's own network points: nowhere. Port 9 is "discard", and nothing listens on a closed port. */
export const NO_NETWORK = { server: "http://127.0.0.1:9", bypass: "<-loopback>" } as const;

/** Extra time after the page's own limit before the hang guard gives up on the browser. */
const HANG_GUARD_MS = 5000;

const firstLine = (err: unknown): string =>
  sanitise(String((err as Error)?.message ?? err).split("\n")[0] ?? "", 200).text;

const couldNot = (
  reason: string,
  hint?: string,
  blocked?: Record<BlockReason, number>,
): RenderCouldNotCheck => ({
  kind: "could-not-check",
  reason,
  ...(hint === undefined ? {} : { hint }),
  ...(blocked === undefined ? {} : { blocked }),
});

const CAP_REASON: Record<CapName, string> = {
  requests: "the page made more requests than the cap allows",
  bytes: "the page is larger, in bytes, than the cap allows",
  redirects: "the page redirects more times than the cap allows",
  time: "the page took longer than the time cap allows",
};

const BLOCK_REASON: Partial<Record<BlockReason, [string, string?]>> = {
  address: [
    "the page is on a private, loopback, link-local or metadata address, which Gaugeline does not request",
    "To render a site on your own computer or network, add --allow-private.",
  ],
  scheme: ["the page's address is not http or https"],
  analytics: ["the page is an analytics address, which a rendered run never reaches"],
  failed: ["the page did not answer"],
};

function launchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LAUNCH_ENV) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function createPlaywrightRenderer(options: PlaywrightRendererOptions): Renderer {
  const limits: RenderLimits = { ...DEFAULT_RENDER_LIMITS, ...options.limits };
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? 300;
  const loadDriver =
    options.loadDriver ?? (async () => (await import("playwright-core")) as Driver);

  let started: Promise<Playwright.Browser | RenderCouldNotCheck> | undefined;
  let browser: Playwright.Browser | undefined;
  let closed = false;
  let pages = 0;
  let runStart: number | undefined;

  /** The driver and the browser file, or why there is not one. Starts nothing. */
  async function locate(): Promise<
    { driver: Driver; path: string; source: string } | RenderCouldNotCheck
  > {
    let driver: Driver;
    try {
      driver = await loadDriver();
    } catch {
      return couldNot("the playwright-core package is not installed", driverHint());
    }
    const located = findBrowser({
      env,
      bundled: (() => {
        try {
          return driver.chromium.executablePath();
        } catch {
          return undefined;
        }
      })(),
      exists: options.exists ?? existsSync,
      platform: options.platform ?? process.platform,
    });
    if (!located.ok) return couldNot(located.reason, installHint());
    return { driver, path: located.path, source: located.source };
  }

  async function start(): Promise<Playwright.Browser | RenderCouldNotCheck> {
    const found = await locate();
    if ("kind" in found) return found;
    const { driver } = found;
    const located = found;
    try {
      browser = await driver.chromium.launch({
        executablePath: located.path,
        headless: true,
        chromiumSandbox: options.chromiumSandbox ?? true,
        env: launchEnv(env),
        proxy: { ...NO_NETWORK },
        args: [...BROWSER_ARGS],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      return browser;
    } catch (err) {
      const line = firstLine(err);
      return couldNot(
        `the browser at ${located.path} could not start: ${line}`,
        /sandbox|root/i.test(line)
          ? `Run Gaugeline as an ordinary user, not as root: the browser's own sandbox stays on. If ${BROWSER_PATH_VARIABLE} is not what you meant, unset it.`
          : `Check that the browser runs on its own (for example \`chromium --version\`), or point ${BROWSER_PATH_VARIABLE} at another one.`,
      );
    }
  }

  async function load(
    b: Playwright.Browser,
    request: RenderRequest,
    gate: EgressGate,
  ): Promise<RenderResult> {
    const { context, page, lastActivity } = await openPage(b, {
      viewport: request.viewport ?? DESKTOP_VIEWPORT,
      gate,
      now,
    });
    try {
      /** Why what the browser ended on is not a page to read, or undefined when it is. */
      const problem = (failure: string | undefined): RenderCouldNotCheck | undefined => {
        const state = gate.state;
        const blocked = { ...state.blocked };
        if (state.capped) return couldNot(CAP_REASON[state.capped], undefined, blocked);
        const known = state.mainBlock ? BLOCK_REASON[state.mainBlock] : undefined;
        if (known) return couldNot(known[0], known[1], blocked);
        if (state.redirectPending)
          return couldNot("the page redirected and never arrived", undefined, blocked);
        if (failure !== undefined)
          return couldNot(`the page did not load: ${failure}`, undefined, blocked);
        if (state.status === undefined)
          return couldNot("the page's document was not answered", undefined, blocked);
        return undefined;
      };

      const work = (async (): Promise<RenderResult> => {
        let failure: string | undefined;
        try {
          await page.goto(request.url, { timeout: limits.ms, waitUntil: "load" });
        } catch (err) {
          failure = firstLine(err);
        }
        // Let what the page starts on load finish, and a redirect finish arriving: the network is quiet
        // for settleMs and nothing is pending, or the time is up.
        const deadline = now() + limits.ms;
        while (
          failure === undefined &&
          (now() - lastActivity() < settleMs || gate.state.redirectPending) &&
          now() < deadline
        )
          await new Promise((r) => setTimeout(r, Math.max(1, Math.min(25, settleMs))));
        const stopped = problem(failure);
        if (stopped) return stopped;
        const ask = {
          text: request.expose?.text ?? true,
          links: request.expose?.links ?? true,
          html: request.expose?.html ?? false,
          maxText: limits.textChars * 2,
          maxLinks: limits.links + 1,
          maxHtml: limits.htmlChars + 1,
        };
        let dom: DomRead;
        try {
          dom = (await page.evaluate(readDomExpression(ask))) as DomRead;
        } catch (err) {
          return couldNot(`the page could not be read after it loaded: ${firstLine(err)}`);
        }
        // Reading the page can run its scripts a little longer: look again at what it did meanwhile.
        const after = problem(undefined);
        if (after) return after;
        const state = gate.state;
        // What the browser computed for accessibility, only when a check asked. A probe that cannot run leaves
        // the field out, and the check says could not check.
        let a11y: A11yRead | undefined;
        if (request.expose?.a11y) {
          try {
            a11y = readA11y(await page.evaluate(a11yExpression()));
          } catch {
            a11y = undefined;
          }
        }

        const truncated: string[] = [];
        const text = ask.text ? sanitise(String(dom.text ?? ""), limits.textChars) : undefined;
        if (text?.cut) truncated.push("text");
        const rawLinks = ask.links && Array.isArray(dom.links) ? dom.links : [];
        const links: RenderedLink[] = rawLinks.slice(0, limits.links).map((l) => ({
          href: sanitise(String(l.href), 2000).text,
          text: sanitise(String(l.text), 120).text,
        }));
        if (rawLinks.length > limits.links) truncated.push("links");
        const html = ask.html ? sanitise(String(dom.html ?? ""), limits.htmlChars) : undefined;
        if (html?.cut) truncated.push("html");
        return {
          kind: "rendered",
          finalUrl: sanitise(String(dom.url ?? page.url()), 2000).text,
          status: state.status ?? 0,
          title: sanitise(String(dom.title ?? ""), 120).text,
          ...(text ? { text: text.text } : {}),
          ...(ask.links ? { links } : {}),
          ...(html ? { html: html.text } : {}),
          requests: [...state.requests],
          blocked: { ...state.blocked },
          totals: { requests: state.totalRequests, bytes: state.bytes },
          truncated,
          ...(a11y ? { a11y } : {}),
        };
      })();

      return await withDeadline(work, limits.ms + HANG_GUARD_MS, () => {
        gate.close("time");
        return couldNot(CAP_REASON.time, undefined, { ...gate.state.blocked });
      });
    } finally {
      gate.close();
      await context.close().catch(() => undefined);
    }
  }

  /** One more use of the run's page and time caps, or the reason there are none left. */
  function reserve(count: number): string | undefined {
    if (closed) return "the renderer was closed";
    runStart ??= now();
    if (now() - runStart > limits.runMs)
      return `the run's time cap of ${Math.round(limits.runMs / 1000)} seconds is used up`;
    if (pages + count > limits.pages)
      return `the run's page cap of ${limits.pages} rendered pages is reached`;
    pages += count;
    return undefined;
  }

  return {
    name: "playwright",
    observer: createClickObserver({
      getBrowser: () => (started ??= start()),
      transport: options.transport,
      ...(options.limits ? { limits: options.limits } : {}),
      now,
      reserve,
      abandonBrowser: async () => {
        const b = browser;
        browser = undefined;
        started = undefined;
        await b?.close().catch(() => undefined);
      },
      ...(options.observerLimitMs === undefined ? {} : { limitMs: options.observerLimitMs }),
      ...(options.observerCloseMs === undefined ? {} : { closeMs: options.observerCloseMs }),
      ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    }),
    async availability() {
      const found = await locate();
      return "kind" in found
        ? found
        : { kind: "available", detail: `Chromium at ${found.path} (${found.source})` };
    },
    async render(request) {
      if (closed) return couldNot("the renderer was closed");
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return couldNot("the page's address is not a web address");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return couldNot("only http and https pages can be rendered");
      runStart ??= now();
      if (now() - runStart > limits.runMs)
        return couldNot(
          `the run's time cap of ${Math.round(limits.runMs / 1000)} seconds is used up`,
        );
      if (pages >= limits.pages)
        return couldNot(`the run's page cap of ${limits.pages} rendered pages is reached`);
      pages += 1;
      started ??= start();
      const b = await started;
      if ("kind" in b) return b;
      const gate = createEgressGate({ transport: options.transport, limits });
      try {
        return await load(b, request, gate);
      } catch (err) {
        return couldNot(`the page could not be rendered: ${firstLine(err)}`, undefined, {
          ...(gate.state.blocked ?? emptyBlocked()),
        });
      }
    },
    async close() {
      closed = true;
      const b = browser;
      browser = undefined;
      await b?.close().catch(() => undefined);
    },
  };
}
