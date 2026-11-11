import { defineCheck } from "../model.js";
import type { Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { DEFAULT_GRACE_DAYS } from "../stale-dates/config.js";
import { staleCopy } from "../stale-dates/judge.js";
import { historicReason, languagesOf, pageCopy } from "../stale-dates/page.js";
import { todayIn } from "../stale-dates/parse.js";
import { venueZone } from "./events/events.js";
import { capFindings } from "./hidden-text/cap.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

export const copyDatePassed = defineCheck<PageSnapshot>({
  id: "copy-date-passed",
  size: "S",
  done: "Every promotion, season and notice on the page is current, or has been taken down, and Gaugeline finds no date that has passed beside one.",
  estimateChanges:
    "Text typed into a page is edited in minutes. Text spread over many pages, or in a theme or a template, takes longer, and a banner with an end date built in fixes itself.",
  area: "Visitors",
  severity: "medium",
  title: "A promotion or notice on the page has a date that has already passed",
  what: 'Visible text such as "Happy hour through Oct 31", "Summer 2025 menu" or "Closed until Jan 3" names a date that is already in the past.',
  why: "Guests plan around what the page says. A special that ended months ago, or a closure notice left up in spring, makes the business look unattended and sends people to something that is no longer there.",
  fix: "Update or remove the text. For something that repeats each year, change the date; for a banner that should end on its own, give it an end date in the CMS.",
  tech: "Visible text only (no script, style, noscript, template, hidden element, comment or attribute such as alt). A date is flagged when it is more than graceDays (1) before today in the venue's time zone and sits after an end word (through, until, ends, last day, hasta, jusqu'au and similar) or ends a range, or has a year and a promotional word within 40 characters (offer, special, menu, season, closed, holiday, hiring, sale, tickets...). A month and day with no year is read as the nearest occurrence, a season as the end of its last month. Never flagged: since, established or founded dates, pages whose structured data or og:type says article or news (or whose path is under historic in gaugeline.stale-dates.json), and a published or modified <time>. Words in packages/core/src/data/stale-dates.json; a page cut at the size limit is could not check",
  run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const config = ctx.staleDates;
    if (historicReason(page, config?.historic)) return [];
    if (page.hops.at(-1)?.truncated) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "the page is longer than the size limit, so its end was not read",
      );
      return [];
    }
    const today = todayIn(ctx.now?.() ?? new Date(), venueZone(ctx) ?? "UTC");
    const hits = staleCopy(pageCopy(page).text, {
      langs: languagesOf(page, ctx.languageRules),
      today,
      graceDays: config?.graceDays ?? DEFAULT_GRACE_DAYS,
      ignore: config?.ignore ?? [],
    });
    const findings: Finding[] = hits.map((h) => ({
      checkId: "copy-date-passed",
      severity: "medium" as const,
      title: this.title,
      evidence: `"${escapeInvisible(h.sentence, 160)}" ended ${h.date}`,
      url: page.finalUrl,
    }));
    return capFindings(findings);
  },
});
