import {
  DEFAULT_RENDER_LIMITS,
  DESKTOP_VIEWPORT,
  MAX_EVENT_TARGETS,
  MAX_TAB_STOPS,
  PHONE_VIEWPORT,
  createEgressGate,
  parseAnalyticsRequest,
  sanitise,
  type ClickTarget,
  type EventObserver,
  type EventsConfig,
  type ObserveResult,
  type ObservedClick,
  type RenderCouldNotCheck,
  type RenderLimits,
  type SentEvent,
  type Transport,
} from "@gaugeline/core";
import type * as Playwright from "playwright-core";
import {
  OBSERVER_SCRIPT,
  READ_MARK,
  READ_NOW,
  PUSH_BINDING,
  findLinkByText,
  focusExpression,
  inspectExpression,
  type TargetInspection,
} from "./page-script.js";
import { openPage, type AnalyticsAttempt } from "./session.js";

/**
 * The click observer (ADR-0009, accepted in part): for each link the tracking plan lists, a real click, with
 * analytics requests intercepted, recorded and never delivered, and what the page reported read back, once
 * at a phone width and once at a desktop width, and the order the Tab key reaches the listed links in.
 *
 * What it does and does not do:
 *   - Links only. Before every click the element is looked at again in the rendered page: an `a` with an
 *     address, not in a form, visible. Anything else is left unclicked and reported as not observed. Never a
 *     button, an input or a form; the Tab key moves focus and types nothing.
 *   - One click for each listed link, at most MAX_EVENT_TARGETS. Core has already left out links to another
 *     site the plan did not name by selector; a click on one that it did name has its navigation cancelled.
 *   - A click that navigates away (or changes the address) is reverted by loading the original page again,
 *     through the same gate, so every later click starts from the page the plan describes.
 *   - Every request goes through the egress gate like a render's: GET and HEAD only, no private address,
 *     no analytics host. The analytics request a page tries to make is read for its event name and
 *     parameters and then dropped.
 *   - A click that cannot be watched (not visible, covered, gone, the page did not reload) is not observed,
 *     and says why. It is never a pass.
 */

export interface ObserverDeps {
  getBrowser: () => Promise<Playwright.Browser | RenderCouldNotCheck>;
  transport: Transport;
  limits?: Partial<RenderLimits>;
  now: () => number;
  /** Count pages against the run's cap: the reason it is used up, or undefined. */
  reserve: (pages: number) => string | undefined;
  /** How long the network is quiet before a page counts as loaded. */
  settleMs?: number;
}

/** A click observation's own limits: it reloads the page after each one that navigates. */
const OBSERVER_LIMITS: Partial<RenderLimits> = { requests: 1500, redirects: 10 };
/** The whole observation, both widths, at the longest. */
const OBSERVE_MS = 3 * 60_000;
const CLICK_TIMEOUT_MS = 3000;

const firstLine = (err: unknown): string =>
  sanitise(String((err as Error)?.message ?? err).split("\n")[0] ?? "", 160).text;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ViewportRead {
  clicks: ObservedClick[];
  focusOrder?: string[];
}

type ViewportResult = ViewportRead | { unchecked: string };

export function createClickObserver(deps: ObserverDeps): EventObserver {
  const limits: RenderLimits = { ...DEFAULT_RENDER_LIMITS, ...OBSERVER_LIMITS, ...deps.limits };
  const settleMs = deps.settleMs ?? 300;

  async function observeViewport(
    b: Playwright.Browser,
    viewport: { width: number; height: number },
    input: {
      page: string;
      targets: readonly ClickTarget[];
      consent?: EventsConfig["consent"];
      waitMs: number;
    },
    focus: boolean,
  ): Promise<ViewportResult> {
    const gate = createEgressGate({ transport: deps.transport, limits });
    const attempts: (AnalyticsAttempt & { t: number })[] = [];
    /** Pushes to dataLayer, handed over by the page as they happen (so a click that leaves the page still counts). */
    let taken: { t: number; x: Record<string, unknown> }[] = [];
    const opened = await openPage(b, {
      viewport,
      gate,
      now: deps.now,
      scripts: [OBSERVER_SCRIPT],
      bindings: {
        [PUSH_BINDING]: (entry: unknown) => {
          const e = entry as { t?: unknown; x?: unknown };
          if (
            taken.length < 200 &&
            typeof e?.t === "number" &&
            typeof e.x === "object" &&
            e.x !== null
          )
            taken.push({ t: e.t, x: e.x as Record<string, unknown> });
        },
      },
      onAnalytics: (a) => attempts.push({ ...a, t: Date.now() }),
    });
    const { page, context } = opened;
    try {
      /** Load the original page and wait for it to settle: a reason it could not be, or undefined. */
      const load = async (): Promise<string | undefined> => {
        try {
          await page.goto(input.page, { timeout: limits.ms, waitUntil: "load" });
        } catch (err) {
          const why = gate.state.mainBlock ?? gate.state.capped;
          return why
            ? `the page was stopped (${why}) when it was loaded at ${viewport.width} px`
            : `the page did not load at ${viewport.width} px: ${firstLine(err)}`;
        }
        const deadline = Date.now() + limits.ms;
        while (
          (deps.now() - opened.lastActivity() < settleMs || gate.state.redirectPending) &&
          Date.now() < deadline
        )
          await sleep(25);
        if (gate.state.capped) return `the page went past a cap (${gate.state.capped})`;
        if (gate.state.mainBlock || gate.state.status === undefined)
          return `the page was not answered at ${viewport.width} px`;
        return undefined;
      };

      const failed = await load();
      if (failed) return { unchecked: failed };

      if (input.consent) {
        const path = (await page.evaluate(findLinkByText(input.consent.accept))) as string | null;
        if (path === null)
          return {
            unchecked: `the plan accepts the consent banner by "${sanitise(input.consent.accept, 60).text}", which is not a link on the page, and only links are clicked`,
          };
        try {
          await page.locator(path).first().click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true });
        } catch (err) {
          return { unchecked: `the consent link could not be clicked: ${firstLine(err)}` };
        }
        await sleep(500);
      }

      const clicks: ObservedClick[] = [];
      let reloadFailed: string | undefined;
      for (const target of input.targets.slice(0, MAX_EVENT_TARGETS)) {
        const none = (reason: string): ObservedClick => ({
          path: target.path,
          pushes: [],
          blocked: [],
          unobserved: reason,
        });
        if (reloadFailed) {
          clicks.push(none(reloadFailed));
          continue;
        }
        let inspected: TargetInspection;
        try {
          inspected = (await page.evaluate(inspectExpression(target.path))) as TargetInspection;
        } catch (err) {
          clicks.push(none(`the page could not be read: ${firstLine(err)}`));
          continue;
        }
        if (!inspected.found) {
          clicks.push(none("it is not in the rendered page"));
          continue;
        }
        if (!inspected.isLink) {
          clicks.push(none("it is not a link in the rendered page, and only links are clicked"));
          continue;
        }
        if (inspected.inForm) {
          clicks.push(
            none("it is inside a form in the rendered page, and nothing in a form is clicked"),
          );
          continue;
        }
        if (!inspected.visible) {
          clicks.push(none(`it is not visible at ${viewport.width} px`));
          continue;
        }

        taken = [];
        attempts.length = 0;
        const mark = (await page.evaluate(READ_MARK)) as number | null;
        const before = page.url();
        const t0 = (await page.evaluate(READ_NOW)) as number;
        try {
          await page
            .locator(target.path)
            .first()
            .click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true });
        } catch (err) {
          clicks.push(
            none(`it could not be clicked (covered, moving or not reachable): ${firstLine(err)}`),
          );
          continue;
        }
        await sleep(input.waitMs);

        let navigated = false;
        try {
          navigated =
            page.url() !== before || ((await page.evaluate(READ_MARK)) as number | null) !== mark;
        } catch {
          // The page went away under the click: it navigated, and what it pushed before leaving is lost.
          navigated = true;
        }
        const sent: SentEvent[] = attempts.flatMap((a) =>
          parseAnalyticsRequest(a.url, a.postData).map((e) => ({
            atMs: Math.max(0, a.t - t0),
            ...e,
          })),
        );
        const hosts = [
          ...new Set(
            attempts.flatMap((a) => {
              try {
                return [new URL(a.url).hostname.toLowerCase()];
              } catch {
                return [];
              }
            }),
          ),
        ];
        clicks.push({
          path: target.path,
          pushes: taken.filter((p) => p.t >= t0).map((p) => ({ atMs: p.t - t0, data: p.x })),
          blocked: hosts,
          ...(sent.length > 0 ? { sent } : {}),
        });
        if (navigated) reloadFailed = await load();
      }

      if (!focus) return { clicks };
      // The Tab key, from the top of the page: which listed links take focus, in what order.
      const reload = reloadFailed ?? (clicks.length > 0 ? await load() : undefined);
      if (reload) return { clicks };
      const paths = input.targets.map((t) => t.path);
      const order: string[] = [];
      try {
        for (let stop = 0; stop < MAX_TAB_STOPS; stop++) {
          await page.keyboard.press("Tab");
          const at = (await page.evaluate(focusExpression(paths))) as number;
          if (at === -2) break;
          const path = paths[at];
          if (at >= 0 && path !== undefined && !order.includes(path)) order.push(path);
        }
      } catch {
        return { clicks };
      }
      return { clicks, focusOrder: order };
    } finally {
      gate.close();
      await context.close().catch(() => undefined);
    }
  }

  return {
    async observe(input): Promise<ObserveResult> {
      const capped = deps.reserve(2);
      if (capped) return { unchecked: capped };
      const b = await deps.getBrowser();
      if ("kind" in b)
        return { unchecked: `${b.reason}${b.hint ? `. ${b.hint.split("\n")[0]}` : ""}` };
      const run = Promise.all([
        observeViewport(b, DESKTOP_VIEWPORT, input, true),
        observeViewport(b, PHONE_VIEWPORT, input, false),
      ]).then(([desktop, phone]): ObserveResult => {
        if ("unchecked" in desktop) return { unchecked: desktop.unchecked };
        return {
          clicks: desktop.clicks,
          ...("clicks" in phone ? { phone: phone.clicks } : {}),
          ...(desktop.focusOrder ? { focusOrder: desktop.focusOrder } : {}),
        };
      });
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<ObserveResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              unchecked: `the click observation took longer than ${OBSERVE_MS / 1000} seconds`,
            }),
          OBSERVE_MS,
        );
      });
      try {
        return await Promise.race([
          run.catch((err): ObserveResult => ({
            unchecked: `the click observation failed: ${firstLine(err)}`,
          })),
          late,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
