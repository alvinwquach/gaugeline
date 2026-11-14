import { expandCalendar, onDate, type Occurrence } from "../ics/expand.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { eventName, eventTime, localTime, pageEvents, venueZone } from "./events/events.js";

function sameLocation(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  const n = (s: string) => eventName(s);
  return n(a).includes(n(b)) || n(b).includes(n(a));
}

export const eventJsonldMismatch = defineCheck<PageSnapshot>({
  id: "event-jsonld-mismatch",
  size: "S",
  done: "The page and the calendar show the same date, time and place for every event.",
  estimateChanges:
    "Events kept by hand in two places are one edit each. One source for both removes the drift but needs a template change.",
  area: "Visitors",
  severity: "high",
  title: "The page and the calendar disagree about an event",
  what: "An event in the page's structured data has a different start time, name or place than the .ics calendar entry on the same day.",
  why: "Search results, the page and guests' phone calendars each show one of the two versions, so some guests turn up at the wrong time.",
  fix: "Correct whichever is wrong, then generate both from one source so they cannot drift.",
  tech: "Event JSON-LD and an .ics occurrence on the same local date: matched by normalised name, then start time and location compared; a lone occurrence that day with another name is reported as renamed",
  async run(page, ctx) {
    const calendars = (await ctx.calendars?.()) ?? [];
    const found = calendars.filter((c) => c.state === "found");
    const events = pageEvents(page);
    if (found.length === 0 || events.length === 0) return [];
    const zone = venueZone(ctx, calendars) ?? "UTC";
    const now = (ctx.now?.() ?? new Date()).getTime();
    const occurrences: Occurrence[] = [];
    for (const c of found) {
      const x = expandCalendar(c.file, now, zone);
      occurrences.push(...x.occurrences);
      if (x.outsideWindow > 0)
        ctx.warn(
          `${c.url}: ${x.events} events; only the next 90 days were expanded (${x.occurrences.length} occurrences).`,
        );
      for (const u of x.unsupported)
        ctx.warn(`Could not check "${u.summary}" in ${c.url}: ${u.reason}.`);
    }
    occurrences.sort((a, b) => a.start - b.start);
    const out = [];
    for (const e of events) {
      const t = e.startRaw ? eventTime(e.startRaw, zone) : undefined;
      if (!t) continue;
      const day = onDate(occurrences, t.date);
      if (day.length === 0) continue;
      const match = day.find((o) => eventName(o.name) === eventName(e.name));
      const diffs: string[] = [];
      if (!match) {
        if (day.length === 1 && day[0])
          diffs.push(`name: the page says "${e.name}", the calendar says "${day[0].name}"`);
      } else {
        if (!t.allDay && !match.allDay && localTime(t.ms, zone) !== localTime(match.start, zone))
          diffs.push(
            `start: the page says ${localTime(t.ms, zone)}, the calendar says ${localTime(match.start, zone)}`,
          );
        const place = e.location?.name ?? e.location?.addressText;
        if (!sameLocation(place, match.location))
          diffs.push(
            `place: the page says "${place ?? ""}", the calendar says "${match.location ?? ""}"`,
          );
      }
      if (diffs.length === 0) continue;
      out.push({
        checkId: "event-jsonld-mismatch",
        severity: "high" as const,
        title: this.title,
        evidence: `"${e.name}" on ${t.date} (${zone}): ${diffs.join("; ")}`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
