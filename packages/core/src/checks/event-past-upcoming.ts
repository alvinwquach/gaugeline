import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { eventTime, pageEvents, venueZone } from "./events/events.js";

export const eventPastUpcoming = defineCheck<PageSnapshot>({
  id: "event-past-upcoming",
  area: "Visitors",
  severity: "high",
  title: "The page still promotes an event that already happened",
  what: "An event in the page's structured data, or a card marked as the next or upcoming event, is dated before now.",
  why: "Guests plan around the date on the page. A night that already happened, still shown as next, sends people to a closed room or to a different night.",
  fix: "Update the card and the structured data when an event ends. Generating both from the calendar keeps them current.",
  tech: "an Event's endDate (or startDate when there is none) is before the run time, or a next/upcoming element's time[datetime] is; dates are read in the venue's time zone",
  async run(page, ctx) {
    const now = (ctx.now?.() ?? new Date()).getTime();
    const zone = venueZone(ctx, (await ctx.calendars?.()) ?? []) ?? "UTC";
    const out = [];
    for (const e of pageEvents(page)) {
      const raw = e.endRaw ?? e.startRaw;
      const t = raw ? eventTime(raw, zone) : undefined;
      if (!t) continue;
      // A date-only end lasts the whole local day.
      const over = t.allDay ? t.ms + 24 * 60 * 60 * 1000 : t.ms;
      if (over > now) continue;
      out.push({
        checkId: "event-past-upcoming",
        severity: "high" as const,
        title: this.title,
        evidence: `structured data event "${e.name}" ${e.endRaw ? "ended" : "started"} ${raw}`,
        url: page.finalUrl,
      });
    }
    for (const card of page.nextCards ?? []) {
      const t = eventTime(card.datetime, zone);
      if (!t || (t.allDay ? t.ms + 24 * 60 * 60 * 1000 : t.ms) > now) continue;
      out.push({
        checkId: "event-past-upcoming",
        severity: "high" as const,
        title: this.title,
        evidence: `the "next" card "${card.label}" is dated ${card.datetime}`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
