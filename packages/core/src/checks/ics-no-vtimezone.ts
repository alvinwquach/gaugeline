import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { shortUrl } from "./site-helpers.js";

export const icsNoVtimezone = defineCheck<PageSnapshot>({
  id: "ics-no-vtimezone",
  area: "Visitors",
  severity: "medium",
  title: "Your calendar names a time zone it doesn't describe",
  what: "Events in your .ics calendar use a TZID, but the file has no VTIMEZONE section for it.",
  why: "The iCalendar standard requires the description. Some calendar apps fall back to UTC or the guest's zone without it, and show the wrong hour.",
  fix: "Export the calendar with time zone definitions included, or add a VTIMEZONE for each TZID the events use.",
  tech: "a DTSTART or DTEND TZID has no matching VTIMEZONE component (RFC 5545 §3.6.5)",
  async run(page, ctx) {
    const origin = new URL(page.finalUrl).origin;
    const calendars = (await ctx.calendars?.()) ?? [];
    return calendars.flatMap((c) => {
      if (c.state !== "found") return [];
      const used = new Set<string>();
      for (const e of c.file.events) {
        for (const t of [e.start, e.end]) if (t?.kind === "zoned" && t.tzid) used.add(t.tzid);
      }
      const missing = [...used].filter((tz) => !c.file.timezones.has(tz)).sort();
      if (missing.length === 0) return [];
      return [
        {
          checkId: "ics-no-vtimezone",
          severity: "medium" as const,
          title: this.title,
          evidence: `${shortUrl(c.url, origin)} uses TZID ${missing.join(", ")} with no VTIMEZONE`,
          url: c.url,
        },
      ];
    });
  },
});
