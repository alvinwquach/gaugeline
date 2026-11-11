import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { DEFAULT_GRACE_DAYS } from "../stale-dates/config.js";
import { pageCopy } from "../stale-dates/page.js";
import { dayNumber, isoOfDay, todayIn } from "../stale-dates/parse.js";
import { venueZone } from "./events/events.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

/** "(c)", "\u00A9" or "copyright", up to 40 characters of name, then a year or a range of years. */
const NOTICE =
  /(?:\u00A9|\(c\)|copyright)[^\d\n]{0,40}?((?:19|20)\d{2})(?:\s*[-\u2013\u2014,]\s*((?:19|20)\d{2}|\d{2})(?!\d))?/giu;

export const copyrightStale = defineCheck<PageSnapshot>({
  id: "copyright-stale",
  size: "S",
  done: "The footer shows the current year, or builds it from the date so it never goes out of date.",
  estimateChanges:
    "One footer in a theme or layout is a one-line change; a footer repeated by hand on many pages is slower.",
  area: "Visitors",
  severity: "low",
  title: "The footer copyright year is out of date",
  what: "The copyright notice in the page's footer names a year before the current one.",
  why: "A year that never changes tells visitors, and anyone judging the site, that nobody has touched it in a while.",
  fix: "Set the footer to the current year, or print it from the date in the template so it updates itself.",
  tech: "the footer element or role=contentinfo (the whole page when it has none) is searched for a (c), \u00A9 or \"copyright\" notice with a year or range of years; the latest year in the page's notices is used, and it is stale when it is before the current year in the venue's time zone, with graceDays (1) after 1 January before last year's counts; one finding for the page checked, not one per page",
  run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const copy = pageCopy(page);
    const scope = copy.footer !== "" ? copy.footer : copy.text;
    const today = todayIn(ctx.now?.() ?? new Date(), venueZone(ctx) ?? "UTC");
    const year = Number(isoOfDay(today).slice(0, 4));
    let latest = 0;
    let shown = "";
    for (const m of scope.matchAll(NOTICE)) {
      const first = Number(m[1]);
      const second =
        m[2] === undefined
          ? 0
          : m[2].length === 2
            ? Number(`${m[1]?.slice(0, 2)}${m[2]}`)
            : Number(m[2]);
      const last = Math.max(first, second);
      if (last > latest) {
        latest = last;
        shown = m[0];
      }
    }
    if (latest === 0 || latest >= year) return [];
    const jan1 = dayNumber(year, 1, 1) ?? today;
    if (latest === year - 1 && today - jan1 <= (ctx.staleDates?.graceDays ?? DEFAULT_GRACE_DAYS))
      return [];
    return [
      {
        checkId: "copyright-stale",
        severity: "low" as const,
        title: this.title,
        evidence: `the footer says "${escapeInvisible(shown.trim(), 60)}" and it is ${year}`,
        url: page.finalUrl,
      },
    ];
  },
});
