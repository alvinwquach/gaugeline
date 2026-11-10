import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { aside, finding, startListingCheck } from "./listings/shared.js";

/**
 * How far ahead a closure is looked for. A page that says "closed Thanksgiving" says it all year;
 * the listing needs the closure in the weeks before it, not eleven months early.
 */
const DAYS_AHEAD = 60;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const listingSpecialHoursMissing = defineCheck<PageSnapshot>({
  id: "listing-special-hours-missing",
  area: "Search & sharing",
  severity: "medium",
  title: "A listing doesn't know about a holiday closure",
  what: "Your site announces a day you are closed, such as Thanksgiving or Christmas, and a listing still shows its normal hours for that day.",
  why: "People check the listing on the day. If it says you open at 4 on a day you are shut, they come anyway.",
  fix: "Add the closure to the listing's special hours in its own dashboard (Google Business Profile: Special hours; Yelp for Business: Holiday hours).",
  tech: 'closures on the site are dates in LocalBusiness openingHoursSpecification (validFrom and validThrough, opens and closes both 00:00) and dates or fixed US holidays within 40 characters of the word "closed" in the pages read, from today in the venue\'s time zone up to 60 days ahead; a listing is missing one when its special hours (Google Business Profile, Yelp) do not mark that date closed; sources that give no special hours (Google Maps, Apple) are reported as could not check',
  async run(page, ctx) {
    const run = await startListingCheck(
      page,
      ctx,
      (c) => c === "google-business" || c === "google-places" || c === "yelp" || c === "apple",
    );
    if (!run) return [];
    const upcoming = run.site.closures.filter((c) => daysBetween(run.today, c.date) <= DAYS_AHEAD);
    if (upcoming.length === 0) return [];
    return run.listings.flatMap((l) => {
      if (l.specialDays === undefined) {
        ctx.couldNotCheck?.(
          l.url ?? page.finalUrl,
          `${l.label} gives Gaugeline no special hours, so its holiday closures were not compared.`,
        );
        return [];
      }
      const closed = new Set(l.specialDays.filter((d) => d.closed).map((d) => d.date));
      const missing = upcoming.filter((c) => !closed.has(c.date));
      return missing.length === 0
        ? []
        : [
            finding(
              "listing-special-hours-missing",
              "medium",
              this.title,
              `${l.label}${aside(l)} has no closure for ${missing.map((c) => (c.label === c.date ? c.date : `${c.label} (${c.date})`)).join(", ")}; your site says closed on ${missing.length === 1 ? "it" : "them"} (${missing[0]?.page})`,
              l.url ?? page.finalUrl,
            ),
          ];
    });
  },
});
