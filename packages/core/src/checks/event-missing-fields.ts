import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { pageEvents } from "./events/events.js";
import { firstFew } from "./site-helpers.js";

export const eventMissingFields = defineCheck<PageSnapshot>({
  id: "event-missing-fields",
  area: "Visitors",
  severity: "low",
  title: "Some events are missing details search engines need",
  what: "An event in the page's structured data has no start date, no location or no event status.",
  why: "Google needs these to show the event in results, and the status is how a cancelled or moved night is shown as such.",
  fix: "Give every Event a startDate, a location and an eventStatus (for example https://schema.org/EventScheduled).",
  tech: "Event JSON-LD without startDate, location or eventStatus (one finding listing each event and what it lacks)",
  run(page) {
    const gaps = pageEvents(page).flatMap((e) => {
      const missing = [
        ...(e.startRaw ? [] : ["startDate"]),
        ...(e.hasLocation ? [] : ["location"]),
        ...(e.status ? [] : ["eventStatus"]),
      ];
      return missing.length > 0 ? [`"${e.name}" has no ${missing.join(", ")}`] : [];
    });
    if (gaps.length === 0) return [];
    return [
      {
        checkId: "event-missing-fields",
        severity: "low",
        title: this.title,
        evidence: firstFew(gaps),
        url: page.finalUrl,
      },
    ];
  },
});
