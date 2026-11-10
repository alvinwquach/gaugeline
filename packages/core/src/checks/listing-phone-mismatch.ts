import { normalisePhone } from "../facts/normalise.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { ANY_LISTING, aside, finding, startListingCheck } from "./listings/shared.js";

export const listingPhoneMismatch = defineCheck<PageSnapshot>({
  id: "listing-phone-mismatch",
  area: "Search & sharing",
  severity: "high",
  title: "A listing shows a different phone number",
  what: "The phone number on your Google, Yelp or Apple listing is not the one on your site.",
  why: "The phone number on the listing is the one people tap from the search result. A wrong one sends bookings and orders to a dead line or a stranger.",
  fix: "Update the phone number in the listing's own dashboard, or on the site if the listing is the right one.",
  tech: "the digits of the listing's phone number (a leading +1 or 1 on a North American number ignored) differ from the digits of the site's: the phone fact in gaugeline.facts.json, else the LocalBusiness telephone in structured data; numbers that are not 7 to 15 digits are not compared",
  async run(page, ctx) {
    const run = await startListingCheck(page, ctx, ANY_LISTING);
    if (!run) return [];
    const phoned = run.listings.filter((l) => normalisePhone(l.phone ?? "") !== undefined);
    if (phoned.length === 0) return [];
    if (!run.site.phone) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "The site states no phone number, so listing phone numbers were not compared. Add a phone fact to gaugeline.facts.json, or LocalBusiness structured data.",
      );
      return [];
    }
    const site = run.site.phone;
    const wanted = normalisePhone(site.value);
    return phoned.flatMap((l) =>
      normalisePhone(l.phone ?? "") === wanted
        ? []
        : [
            finding(
              "listing-phone-mismatch",
              "high",
              this.title,
              `${l.label} says ${l.phone}${aside(l)}; your site says ${site.value} (${site.from})`,
              l.url ?? page.finalUrl,
            ),
          ],
    );
  },
});
