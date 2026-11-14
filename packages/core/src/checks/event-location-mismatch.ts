import { businessFromJsonLd } from "../facts/business.js";
import { jsonLdNodes } from "../snapshot.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { pageEvents } from "./events/events.js";
import { sameName } from "./quotable-facts-disagree.js";

export const eventLocationMismatch = defineCheck<PageSnapshot>({
  id: "event-location-mismatch",
  size: "S",
  done: "Each event lists the venue's own address, ideally by the venue's @id.",
  estimateChanges:
    "Events entered by hand are edited one by one. One venue record referenced by all of them needs a template change.",
  area: "Visitors",
  severity: "medium",
  title: "An event at your venue lists a different address",
  what: "An event the page says is at the venue (by the venue's name or id) gives a different street address than the venue's own structured data.",
  why: "Maps and search results send guests to the event's address, so a stale one sends them to the wrong door.",
  fix: "Use the venue's own address in each event's location, ideally by referring to the venue's @id instead of repeating it.",
  tech: "Event location names the LocalBusiness (same name or @id) and its address differs by house number or ZIP",
  run(page) {
    const venue = businessFromJsonLd(page);
    if (!venue?.name || (!venue.streetNumber && !venue.zip)) return [];
    const venueId = jsonLdNodes(page).find((n) => n.name === venue.name)?.["@id"];
    return pageEvents(page).flatMap((e) => {
      const loc = e.location;
      if (!loc || (!loc.streetNumber && !loc.zip)) return [];
      const atVenue =
        (loc.name && sameName(loc.name, venue.name ?? "")) ||
        (loc.id !== undefined && loc.id === venueId);
      if (!atVenue) return [];
      const differs =
        (venue.streetNumber && loc.streetNumber && venue.streetNumber !== loc.streetNumber) ||
        (venue.zip && loc.zip && venue.zip !== loc.zip);
      if (!differs) return [];
      return [
        {
          checkId: "event-location-mismatch",
          severity: "medium" as const,
          title: this.title,
          evidence: `"${e.name}" is at "${loc.addressText ?? ""}"; ${venue.name} is at "${venue.addressText ?? ""}"`,
          url: page.finalUrl,
        },
      ];
    });
  },
});
