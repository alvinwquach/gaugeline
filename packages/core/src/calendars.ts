import type { Fetcher } from "./fetcher.js";
import { parseIcs, type IcsFile } from "./ics/parse.js";
import type { Budget } from "./limits.js";
import { getOrNull } from "./probe.js";
import { dedupeUrls } from "./sample.js";
import type { PageSnapshot } from "./snapshot.js";

/** One calendar feed the page links to, as read. */
export type CalendarRead =
  | { url: string; state: "found"; file: IcsFile }
  | { url: string; state: "unchecked"; reason: string };

/** webcal:// is http(s) for calendar apps; Gaugeline requests it over https. */
export function calendarUrl(href: string): string {
  return href.replace(/^webcal:\/\//i, "https://");
}

/** True when a body is an iCalendar file: it begins with BEGIN:VCALENDAR. */
export function isIcs(body: string): boolean {
  return /^\s*BEGIN:VCALENDAR\b/i.test(body.replace(/^\uFEFF/, ""));
}

async function readOne(fetcher: Fetcher, url: string): Promise<CalendarRead> {
  const last = (await getOrNull(fetcher, url)).at(-1);
  if (!last) return { url, state: "unchecked", reason: "it did not answer" };
  if (last.status >= 400) return { url, state: "unchecked", reason: `it answered ${last.status}` };
  const body = last.body ?? "";
  if (!isIcs(body)) {
    const type = (last.headers["content-type"] ?? "").split(";")[0] || "no type";
    return {
      url,
      state: "unchecked",
      reason: `it is served as ${type}, not a calendar (a login or error page?)`,
    };
  }
  return { url, state: "found", file: parseIcs(body) };
}

export interface CalendarOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/** The first calendars the page links to, within the run's allowance, read once each. */
export async function readCalendars({
  page,
  fetcher,
  budget,
}: CalendarOptions): Promise<CalendarRead[]> {
  const urls = budget.take("calendars", dedupeUrls((page.calendars ?? []).map(calendarUrl)));
  return Promise.all(urls.map((u) => readOne(fetcher, u)));
}

export function lazyCalendars(opts: CalendarOptions): () => Promise<CalendarRead[]> {
  let pending: Promise<CalendarRead[]> | undefined;
  return () => (pending ??= readCalendars(opts));
}
