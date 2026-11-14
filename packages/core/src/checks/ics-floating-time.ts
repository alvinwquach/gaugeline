import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const icsFloatingTime = defineCheck<PageSnapshot>({
  id: "ics-floating-time",
  size: "S",
  done: "Every DTSTART in the calendar names a time zone.",
  estimateChanges:
    "A calendar made by software with no time zone setting needs its export changed.",
  area: "Visitors",
  severity: "high",
  title: "Your calendar shows the wrong hour on some phones",
  what: "Events in your .ics calendar have a start time with no time zone (no TZID and no Z).",
  why: "Phones read such a time in the guest's own zone, so anyone in another zone, or travelling, sees the event at the wrong hour.",
  fix: "Give each DTSTART a time zone, for example DTSTART;TZID=America/Los_Angeles:20261112T190000. Most calendar exports have a time zone setting.",
  tech: "a VEVENT's DTSTART has neither TZID nor a trailing Z (a floating time, RFC 5545 §3.3.5); all-day VALUE=DATE events are not reported",
  async run(page, ctx) {
    const origin = new URL(page.finalUrl).origin;
    const calendars = (await ctx.calendars?.()) ?? [];
    return calendars.flatMap((c) => {
      if (c.state !== "found") return [];
      const floating = c.file.events.filter((e) => e.start?.kind === "floating");
      if (floating.length === 0) return [];
      return [
        {
          checkId: "ics-floating-time",
          severity: "high" as const,
          title: this.title,
          evidence: `${floating.length} of ${c.file.events.length} events in ${shortUrl(c.url, origin)} have no time zone: ${firstFew(floating.map((e) => `"${e.summary}" DTSTART:${e.start?.raw ?? ""}`))}`,
          url: c.url,
        },
      ];
    });
  },
});
