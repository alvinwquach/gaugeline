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
  PUSH_BINDING,
  REFUSED_BINDING,
  findLinkByText,
  focusExpression,
  inspectExpression,
  type TargetInspection,
} from "./page-script.js";
import { FLOOD_REASON } from "./binding-guard.js";
import { openPage, type AnalyticsAttempt, type OpenedPage } from "./session.js";

/**
 * The click observer (ADR-0009, accepted in part): for each link the tracking plan lists, a real click, with
 * analytics requests intercepted, recorded and never delivered, and what the page reported read back, once
 * at a phone width and once at a desktop width, and the order the Tab key reaches the listed links in.
 *
 * What it does and does not do:
 *   - Links only. Before every click the element is looked at again in the rendered page: an `a` with a web
 *     address, not in a form, visible, and on the page's site (or named by the plan). Anything else is left
 *     unclicked and reported as not observed. In the page, every click is also checked as it lands: if it is
 *     not on a link, or the link now has another kind of address, it is stopped. Never a button, an input
 *     or a form; the Tab key moves focus and types nothing.
 *   - One click for each listed link, at most MAX_EVENT_TARGETS, each in a FRESH browser context that has loaded
 *     the page again: no cookie, storage or cache from an earlier click is there, so every click starts from
 *     the page the plan describes, and a click that navigates needs no undoing.
 *   - It stays on the page's site: a link to another site is not followed (its default action is cancelled
 *     in the page), and a navigation after a click that would leave the site, a redirect included, is refused
 *     and never asked for. A link the plan lists goes to wherever its address says, on this site: a
 *     `/logout` the plan lists is clicked (GET, no credentials, a fresh context): the plan's author chose it.
 *   - Every request goes through the egress gate like a render's: GET and HEAD only, no private address,
 *     no analytics host. The analytics request a page tries to make is read for its event name and
 *     parameters and then dropped. What the page hands over (a push) is page text: it is cleaned and
 *     bounded here, never trusted as the page bounded it.
 *   - A click that cannot be watched (not visible, covered, gone, not a link now) is not observed, and says why.
 *     It is never a pass.
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
  /** The whole observation, both widths, at the longest. Default 3 minutes. */
  limitMs?: number;
  /**
   * Last resort when the limit passes and a page will not close (a script that never returns): close the whole
   * browser, which ends every process it started. A later render starts a new one.
   */
  abandonBrowser?: () => Promise<void>;
  /** How long a context is given to close at the limit before the browser goes. Default 2 s. */
  closeMs?: number;
}

/** A page's own limits for one click: it is loaded again for each. */
const OBSERVER_LIMITS: Partial<RenderLimits> = { requests: 600, redirects: 10 };
const CLICK_TIMEOUT_MS = 3000;

/** What a page may hand over, bounded here whatever the page's own code did. */
export const PUSH_LIMITS = Object.freeze({
  pushes: 200,
  keys: 30,
  keyChars: 60,
  valueChars: 300,
  totalChars: 100_000,
});

const firstLine = (err: unknown): string =>
  sanitise(String((err as Error)?.message ?? err).split("\n")[0] ?? "", 160).text;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A call into a page that may be busy for ever (Playwright's evaluate has no timeout of its own). */
const PAGE_CALL_MS = 4000;
class PageStopped extends Error {}
async function bounded<T>(call: Promise<T>, ms = PAGE_CALL_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PageStopped("the page stopped responding")), ms);
  });
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
    // The call may still settle later: it must not be an unhandled rejection.
    call.catch(() => undefined);
  }
}

/** Close a context, and say whether it closed within the time: a busy page can hold it up. */
async function closeWithin(opened: OpenedPage, ms: number): Promise<boolean> {
  let closed = false;
  await Promise.race([
    opened.context.close().then(
      () => (closed = true),
      () => (closed = true),
    ),
    sleep(ms),
  ]);
  return closed;
}

interface Push {
  t: number;
  x: Record<string, unknown>;
}

/**
 * A push the page handed over, as data we keep: a flat object of at most 30 keys, text cut (a value is cut
 * before it is cleaned), numbers and booleans, and never more than 200 pushes or 100,000 characters in all.
 * The page may call the binding with anything, so nothing about the entry is assumed.
 */
export function acceptPush(entry: unknown, kept: Push[], used: { chars: number }): void {
  if (kept.length >= PUSH_LIMITS.pushes || used.chars >= PUSH_LIMITS.totalChars) return;
  if (typeof entry !== "object" || entry === null) return;
  const { t, x } = entry as { t?: unknown; x?: unknown };
  if (typeof t !== "number" || !Number.isFinite(t) || typeof x !== "object" || x === null) return;
  const out: Record<string, unknown> = {};
  let keys = 0;
  // for...in with a break: the page's object may have a million keys.
  for (const k in x) {
    if (!Object.hasOwn(x, k)) continue;
    if (++keys > PUSH_LIMITS.keys) break;
    if (k.length > PUSH_LIMITS.keyChars) continue;
    const v = (x as Record<string, unknown>)[k];
    if (typeof v === "string") {
      const clean = sanitise(v.slice(0, PUSH_LIMITS.valueChars * 2), PUSH_LIMITS.valueChars).text;
      used.chars += k.length + clean.length;
      out[k] = clean;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      used.chars += k.length + 8;
      out[k] = v;
    } else if (typeof v === "boolean") {
      used.chars += k.length + 1;
      out[k] = v;
    }
  }
  kept.push({ t, x: out });
}

interface ViewportRead {
  clicks: ObservedClick[];
  focusOrder?: string[];
  /** Why the Tab order was not read, when it was asked for and could not be. */
  focusUnchecked?: string;
}

type ViewportResult = ViewportRead | { unchecked: string };
interface Input {
  page: string;
  targets: readonly ClickTarget[];
  consent?: EventsConfig["consent"];
  waitMs: number;
}

export function createClickObserver(deps: ObserverDeps): EventObserver {
  const limits: RenderLimits = { ...DEFAULT_RENDER_LIMITS, ...OBSERVER_LIMITS, ...deps.limits };
  const settleMs = deps.settleMs ?? 300;
  const limitMs = deps.limitMs ?? 3 * 60_000;

  async function observeViewport(
    b: Playwright.Browser,
    viewport: { width: number; height: number },
    input: Input,
    focus: boolean,
    stop: { stopped: boolean },
    open: Set<OpenedPage>,
  ): Promise<ViewportResult> {
    const pageOrigin = new URL(input.page).origin;

    /** Close a context for good: a busy page can hold it up, so it is waited for only so long. */
    async function release(opened: OpenedPage): Promise<void> {
      open.delete(opened);
      await closeWithin(opened, 3000);
    }

    /**
     * A fresh browser context with the original page loaded (and the consent link accepted, if the plan says
     * so): a reason it could not be, or the page and what it has collected so far.
     */
    async function fresh(allow: ClickTarget | undefined): Promise<
      | { unchecked: string }
      | {
          opened: OpenedPage;
          gate: ReturnType<typeof createEgressGate>;
          attempts: (AnalyticsAttempt & { t: number })[];
          pushes: Push[];
          used: { chars: number };
          refused: string[];
          clickRefused: { why?: string };
          state: { clicking: boolean };
        }
    > {
      const gate = createEgressGate({ transport: deps.transport, limits });
      const attempts: (AnalyticsAttempt & { t: number })[] = [];
      const pushes: Push[] = [];
      const used = { chars: 0 };
      const refused: string[] = [];
      const clickRefused: { why?: string } = {};
      /** True from the moment the click is made: a frame that loads a document then is the click's. */
      const state = { clicking: false };
      const allowed = new Set([pageOrigin]);
      if (allow?.allowCrossSite && allow.destination)
        allowed.add(new URL(allow.destination).origin);
      const opened = await openPage(b, {
        viewport,
        gate,
        now: deps.now,
        scripts: [OBSERVER_SCRIPT],
        bindings: {
          [PUSH_BINDING]: (entry: unknown) => acceptPush(entry, pushes, used),
          [REFUSED_BINDING]: (why: unknown) => {
            clickRefused.why ??= sanitise(String(why).slice(0, 200), 120).text;
          },
        },
        onAnalytics: (a) => attempts.push({ ...a, t: Date.now() }),
        allowNavigation: (u) => allowed.has(u.origin),
        onNavigationRefused: (u) => {
          if (refused.length < 10) refused.push(u.hostname.toLowerCase());
        },
        blockSubframes: () => state.clicking,
      });
      open.add(opened);
      const { page } = opened;
      try {
        await page.goto(input.page, { timeout: limits.ms, waitUntil: "load" });
      } catch (err) {
        await release(opened);
        const why = gate.state.mainBlock ?? gate.state.capped;
        if (opened.flooded()) return { unchecked: FLOOD_REASON };
        return {
          unchecked: why
            ? `the page was stopped (${why}) when it was loaded at ${viewport.width} px`
            : `the page did not load at ${viewport.width} px: ${firstLine(err)}`,
        };
      }
      const deadline = Date.now() + limits.ms;
      while (
        (deps.now() - opened.lastActivity() < settleMs || gate.state.redirectPending) &&
        Date.now() < deadline
      )
        await sleep(25);
      if (opened.flooded()) {
        await release(opened);
        return { unchecked: FLOOD_REASON };
      }
      if (gate.state.capped || gate.state.mainBlock || gate.state.status === undefined) {
        await release(opened);
        return { unchecked: `the page was not answered as a page at ${viewport.width} px` };
      }
      if (input.consent) {
        let path: string | null;
        try {
          path = (await bounded(page.evaluate(findLinkByText(input.consent.accept)))) as
            string | null;
        } catch (err) {
          await release(opened);
          return {
            unchecked: `the page could not be read at ${viewport.width} px: ${firstLine(err)}`,
          };
        }
        if (path === null) {
          await release(opened);
          return {
            unchecked: `the plan accepts the consent banner by "${sanitise(input.consent.accept, 60).text}", which is not a link on the page, and only links are clicked`,
          };
        }
        try {
          await bounded(
            page.locator(path).first().click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true }),
            CLICK_TIMEOUT_MS + 1000,
          );
        } catch (err) {
          await release(opened);
          return { unchecked: `the consent link could not be clicked: ${firstLine(err)}` };
        }
        await sleep(500);
      }
      // What the page pushed and asked for while loading, and what the consent click did, is not the target's.
      pushes.length = 0;
      attempts.length = 0;
      refused.length = 0;
      clickRefused.why = undefined;
      return { opened, gate, attempts, pushes, used, refused, clickRefused, state };
    }

    const clicks: ObservedClick[] = [];
    let hung = false;
    for (const [index, target] of input.targets.slice(0, MAX_EVENT_TARGETS).entries()) {
      const none = (reason: string): ObservedClick => ({
        path: target.path,
        pushes: [],
        blocked: [],
        unobserved: reason,
      });
      if (stop.stopped) {
        clicks.push(none("the observation reached its time limit"));
        continue;
      }
      if (hung) {
        clicks.push(none(`the page stopped responding at ${viewport.width} px`));
        continue;
      }
      const s = await fresh(target);
      if ("unchecked" in s) {
        // The first page that will not load ends the observation at this width; a later one is that click's.
        if (index === 0) return { unchecked: s.unchecked };
        clicks.push(none(s.unchecked));
        continue;
      }
      const { opened, attempts, pushes, refused, clickRefused, state } = s;
      const { page } = opened;
      try {
        let inspected: TargetInspection;
        try {
          inspected = (await bounded(
            page.evaluate(inspectExpression(target.path)),
          )) as TargetInspection;
        } catch (err) {
          hung ||= err instanceof PageStopped;
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
        if (!inspected.webAddress) {
          clicks.push(
            none("its address is not a web address in the rendered page (a script changed it)"),
          );
          continue;
        }
        if (inspected.crossSite && !target.allowCrossSite) {
          clicks.push(
            none(
              "its address goes to another site in the rendered page, and the plan does not name it",
            ),
          );
          continue;
        }
        if (!inspected.visible) {
          clicks.push(none(`it is not visible at ${viewport.width} px`));
          continue;
        }

        let t0: number;
        try {
          t0 = (await bounded(page.evaluate("Date.now()"))) as number;
        } catch (err) {
          hung ||= err instanceof PageStopped;
          clicks.push(none(`the page could not be read: ${firstLine(err)}`));
          continue;
        }
        state.clicking = true;
        try {
          await bounded(
            page
              .locator(target.path)
              .first()
              .click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true }),
            CLICK_TIMEOUT_MS + 1000,
          );
        } catch (err) {
          hung ||= err instanceof PageStopped;
          clicks.push(
            none(`it could not be clicked (covered, moving or not reachable): ${firstLine(err)}`),
          );
          continue;
        }
        await sleep(input.waitMs);
        if (opened.flooded()) {
          clicks.push(none(FLOOD_REASON));
          continue;
        }
        if (clickRefused.why) {
          clicks.push(none(`the click was stopped: ${clickRefused.why}`));
          continue;
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
          pushes: pushes.filter((p) => p.t >= t0).map((p) => ({ atMs: p.t - t0, data: p.x })),
          blocked: hosts,
          ...(sent.length > 0 ? { sent: sent.slice(0, 20) } : {}),
          ...(refused.length > 0 ? { refusedNavigation: [...new Set(refused)] } : {}),
        });
      } finally {
        await release(opened);
      }
    }

    if (!focus) return { clicks };
    // The Tab key, from the top of a fresh page: which listed links take focus, in what order.
    if (hung || stop.stopped) return { clicks };
    const f = await fresh(undefined);
    if ("unchecked" in f)
      return { clicks, focusUnchecked: `the Tab order was not read: ${f.unchecked}` };
    try {
      const paths = input.targets.map((t) => t.path);
      const order: string[] = [];
      let ended = false;
      for (let stopAt = 0; stopAt < MAX_TAB_STOPS && !stop.stopped; stopAt++) {
        await bounded(f.opened.page.keyboard.press("Tab"));
        const at = (await bounded(f.opened.page.evaluate(focusExpression(paths)))) as number;
        if (at === -2) {
          ended = true;
          break;
        }
        const path = paths[at];
        if (at >= 0 && path !== undefined && !order.includes(path)) order.push(path);
      }
      // Never reached the end of the page and never reached some links: they may be further on, not unreachable.
      const missing = paths.filter((p) => !order.includes(p)).length;
      if (!ended && missing > 0)
        return {
          clicks,
          focusUnchecked: stop.stopped
            ? "the observation reached its time limit before the Tab key was done"
            : `the Tab key was pressed ${MAX_TAB_STOPS} times and had not reached ${missing} of the plan's links or the end of the page`,
        };
      return { clicks, focusOrder: order };
    } catch (err) {
      return { clicks, focusUnchecked: `the Tab key could not be pressed: ${firstLine(err)}` };
    } finally {
      await release(f.opened);
    }
  }

  return {
    async observe(input): Promise<ObserveResult> {
      const capped = deps.reserve(2);
      if (capped) return { unchecked: capped };
      const b = await deps.getBrowser();
      if ("kind" in b)
        return { unchecked: `${b.reason}${b.hint ? `. ${b.hint.split("\n")[0]}` : ""}` };
      const stop = { stopped: false };
      const open = new Set<OpenedPage>();
      const run = Promise.all([
        observeViewport(b, DESKTOP_VIEWPORT, input, true, stop, open),
        observeViewport(b, PHONE_VIEWPORT, input, false, stop, open),
      ]).then(([desktop, phone]): ObserveResult => {
        if ("unchecked" in desktop) return { unchecked: desktop.unchecked };
        return {
          clicks: desktop.clicks,
          ...("clicks" in phone ? { phone: phone.clicks } : { phoneUnchecked: phone.unchecked }),
          ...(desktop.focusOrder ? { focusOrder: desktop.focusOrder } : {}),
          ...(desktop.focusUnchecked ? { focusUnchecked: desktop.focusUnchecked } : {}),
        };
      });
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<ObserveResult>((resolve) => {
        timer = setTimeout(() => {
          // Stop the work, not just the wait: no click starts after this, the contexts in use are closed
          // (a page that never returns cannot hold the run up: if one will not close, the browser goes).
          stop.stopped = true;
          void (async () => {
            const closed = await Promise.all(
              [...open].map((o) => closeWithin(o, deps.closeMs ?? 2000)),
            );
            if (closed.includes(false))
              await Promise.race([deps.abandonBrowser?.().catch(() => undefined), sleep(5000)]);
            resolve({
              unchecked: `the click observation took longer than ${Math.round(limitMs / 1000)} seconds`,
            });
          })();
        }, limitMs);
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
