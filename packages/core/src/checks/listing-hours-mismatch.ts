import { compareHours, describeHours } from "../listings/hours.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { aside, finding, startListingCheck } from "./listings/shared.js";

export const listingHoursMismatch = defineCheck<PageSnapshot>({
  id: "listing-hours-mismatch",
  area: "Search & sharing",
  severity: "high",
  title: "A listing shows different opening hours",
  what: "On at least one day, the hours on your Google, Yelp or Apple listing are not the hours on your site.",
  why: "People decide where to go from the hours in the search result. A listing that says you close at 10 when you stay open until 2 loses the late crowd, and one that says you open early sends people to a locked door.",
  fix: "Make the hours the same in the listing's own dashboard and on the site. Decide which one is right first, then fix the other.",
  tech: "both sides become seven lists of intervals in the venue's local time (a close after midnight belongs to the day it opens, split shifts stay split) and each day the site states is compared; a day the site does not mention is not; a day missing from a listing that gave hours is closed; the site's hours are the hours fact in gaugeline.facts.json, else LocalBusiness openingHours or openingHoursSpecification",
  async run(page, ctx) {
    const run = await startListingCheck(page, ctx, (c) => c !== "bio-link");
    if (!run) return [];
    const timed = run.listings.filter((l) => l.hours !== undefined);
    if (timed.length === 0) return [];
    if (!run.site.hours) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "The site states no opening hours, so listing hours were not compared. Add an hours fact to gaugeline.facts.json, or LocalBusiness openingHours in structured data.",
      );
      return [];
    }
    const site = run.site.hours;
    return timed.flatMap((l) => {
      const differences = compareHours(site.value, l.hours ?? {});
      return differences.length === 0
        ? []
        : [
            finding(
              "listing-hours-mismatch",
              "high",
              this.title,
              `${describeHours(differences, l.label)}${aside(l)} (site hours from ${site.from})`,
              l.url ?? page.finalUrl,
            ),
          ];
    });
  },
});
