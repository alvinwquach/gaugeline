/**
 * The little of Playwright's context and DevTools session this file uses, written here so that the driver is
 * imported in one file only (playwright.ts), and nowhere else.
 */
interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (message: { event: TimelineEvent }) => void): unknown;
  detach(): Promise<void>;
}
interface TimelineEvent {
  type?: string;
  time?: number;
  lcpDetails?: { renderTime?: number; loadTime?: number };
}
export interface MeasuredContext {
  newCDPSession(page: never): Promise<CdpSession>;
}

/**
 * The timings of one load (PERF-02), measured without sending anything: the browser's own report of what painted
 * (through the DevTools protocol's timeline, which works with JavaScript off) and of the long tasks the page's
 * scripts ran. Local and unthrottled: the numbers are this computer's, good for comparing one load with another
 * here, not for comparing with anyone else's.
 *
 * Long tasks are collected by an observer that our script creates before any script of the page runs, inside a
 * closure the page's code cannot read or replace, and each is reported to a function on the node side. That
 * function is not hidden from a page that goes looking: Playwright's own binding controller is reachable from the
 * page, so a hostile page CAN call it and lie to its own measurement. What the node side does about it: it accepts
 * a report only if it could be a real long task (a number of 50 ms or more, no longer than the load so far), and if
 * the reports are too many, or add up to more than the load took, the page is judged to have tampered and its
 * blocking time is dropped, not reported. A page that invents plausible tasks, or holds the thread without being
 * seen, is not caught. This is advice for the owner of a site who runs it on their own site, not a security
 * boundary: the report says what the browser saw.
 */

/** A page's own long tasks over this many milliseconds count as blocking, above the first 50 ms. */
const BLOCKING_FLOOR_MS = 50;
export const MAX_TASKS = 2000;
const MAX_TASK_MS = 600_000;
/** More long tasks than this in one load is not a page, it is a loop calling the function. */
export const PLAUSIBLE_TASKS = 200;
/** The shortest a long task can be: the browser reports a task from 50 ms. */
const LONG_TASK_MS = 50;
/** Slack for the observer's rounding and the delay between a task ending and being reported. */
const SLACK_MS = 100;

export interface TaskCollector {
  /** The durations accepted, in milliseconds. */
  readonly tasks: readonly number[];
  /** A report that cannot be a real long task was made, so the numbers are not to be trusted. */
  readonly tampered: boolean;
  /** What the page-side script reported: anything, since a page can call the function itself. */
  add(value: unknown): void;
}

/** Receives the reports of the page-side observer. Created just before the load starts; `now` is injectable. */
export function createTaskCollector(now: () => number = Date.now): TaskCollector {
  const startedAt = now();
  const tasks: number[] = [];
  let total = 0;
  let tampered = false;
  return {
    tasks,
    get tampered() {
      return tampered;
    },
    add(value) {
      const elapsed = now() - startedAt;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < LONG_TASK_MS ||
        value > elapsed + SLACK_MS ||
        tasks.length >= PLAUSIBLE_TASKS
      ) {
        tampered = true;
        return;
      }
      total += value;
      // Long tasks run one after another on one thread: together they cannot be longer than the load so far.
      if (total > elapsed + SLACK_MS) tampered = true;
      tasks.push(Math.round(value));
    },
  };
}

/** The name the page-side script is handed. Taken and removed before the page's own scripts run. */
export const TASK_BINDING = "__gaugelineTask";

/**
 * Runs before any script of the page. Takes the binding, removes it from the window (a page that looks for
 * Playwright's own controller can still reach it), and reports each long task through it.
 */
export const LONGTASK_OBSERVER = `(() => {
  const send = window[${JSON.stringify(TASK_BINDING)}];
  try { delete window[${JSON.stringify(TASK_BINDING)}]; } catch (e) { /* kept */ }
  if (window[${JSON.stringify(TASK_BINDING)}] !== undefined) {
    try { window[${JSON.stringify(TASK_BINDING)}] = undefined; } catch (e) { /* kept */ }
  }
  if (typeof send !== "function") return;
  const Observer = PerformanceObserver;
  try {
    new Observer((list) => {
      for (const entry of list.getEntries()) { try { send(Math.round(entry.duration)); } catch (e) { /* gone */ } }
    }).observe({ type: "longtask", buffered: true });
  } catch (e) { /* long tasks are not reported by this browser */ }
})();`;

export interface RawTimeline {
  /** When the load was started, in milliseconds since the epoch (just before the page was asked for). */
  startedAtMs: number;
  /** When the numbers were read, in milliseconds since the epoch. */
  readAtMs: number;
  /** Each Largest Contentful Paint candidate the browser reported, as seconds since the epoch, in order. */
  lcpSeconds: readonly number[];
  /** Durations of long tasks, in milliseconds, or undefined when no script ran (JavaScript off). */
  tasksMs: readonly unknown[] | undefined;
}

const whole = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : undefined;

/**
 * Whole milliseconds out of what the browser reported. The last candidate is the Largest Contentful Paint.
 * Total blocking time is the time every long task spent over 50 ms, never more than the load took; with
 * JavaScript off it is not measured at all (no script runs, so there is nothing to observe), and is left out
 * rather than reported as 0. Anything that is not a plain non-negative number is dropped.
 */
export function summarise(raw: RawTimeline): { lcpMs?: number; tbtMs?: number } {
  const last = raw.lcpSeconds.at(-1);
  const lcp =
    last === undefined || !Number.isFinite(last)
      ? undefined
      : Math.max(0, Math.round(last * 1000 - raw.startedAtMs));
  if (raw.tasksMs === undefined) return lcp === undefined ? {} : { lcpMs: lcp };
  const tasks = raw.tasksMs.slice(0, MAX_TASKS).flatMap((t) => {
    const ms = whole(t, MAX_TASK_MS);
    return ms === undefined ? [] : [ms];
  });
  const total = tasks.reduce((sum, ms) => sum + Math.max(0, ms - BLOCKING_FLOOR_MS), 0);
  const tbt = Math.min(total, Math.max(0, Math.round(raw.readAtMs - raw.startedAtMs)));
  return { ...(lcp === undefined ? {} : { lcpMs: lcp }), tbtMs: tbt };
}

export interface Measurement {
  /**
   * The load's numbers. `collector` is what the node side collected from the observer, undefined with JavaScript
   * off. A page that tampered with it has no blocking time and `tampered` is set.
   */
  read(
    collector: TaskCollector | undefined,
  ): Promise<{ lcpMs?: number; tbtMs?: number; tampered?: true }>;
}

/**
 * Starts listening for paint reports on this page. Call it before the navigation and `read` after the load
 * has settled. Returns undefined when the browser has no such report, which makes the numbers could-not-check.
 */
export async function startMeasurement(
  context: MeasuredContext,
  page: unknown,
): Promise<Measurement | undefined> {
  let session: CdpSession;
  try {
    session = await context.newCDPSession(page as never);
    await session.send("PerformanceTimeline.enable", { eventTypes: ["largest-contentful-paint"] });
  } catch {
    return undefined;
  }
  const lcpSeconds: number[] = [];
  session.on("PerformanceTimeline.timelineEventAdded", (message) => {
    const e = message.event;
    if (e.type !== "largest-contentful-paint") return;
    const d = e.lcpDetails;
    const t = d?.renderTime || d?.loadTime || e.time;
    if (typeof t === "number" && Number.isFinite(t) && t > 0) lcpSeconds.push(t);
  });
  const startedAtMs = Date.now();
  return {
    async read(collector) {
      // A long task is reported a moment after it ends: let the last ones arrive.
      if (collector !== undefined) await new Promise((r) => setTimeout(r, 50));
      await session.detach().catch(() => undefined);
      const tampered = collector?.tampered === true;
      const out = summarise({
        startedAtMs,
        readAtMs: Date.now(),
        lcpSeconds,
        tasksMs: tampered ? undefined : collector?.tasks,
      });
      return tampered ? { ...out, tampered: true } : out;
    },
  };
}
