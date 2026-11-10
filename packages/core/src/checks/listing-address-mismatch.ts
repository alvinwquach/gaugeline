import { addressesAgree } from "../listings/match.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { ANY_LISTING, aside, finding, startListingCheck } from "./listings/shared.js";

export const listingAddressMismatch = defineCheck<PageSnapshot>({
  id: "listing-address-mismatch",
  area: "Search & sharing",
  severity: "medium",
  title: "A listing shows a different address",
  what: "The street number or ZIP code on your Google, Yelp or Apple listing is not the one on your site.",
  why: "Maps sends people to the address on the listing. After a move, or with a typo, guests arrive at the wrong door.",
  fix: "Correct the address in the listing's own dashboard, or on the site if the listing is the right one.",
  tech: 'the house number and the 5-digit ZIP code are read from both addresses and each one both sides state must be equal; street names are not compared; the site\'s address is the text fact "address" in gaugeline.facts.json, else the LocalBusiness address in structured data',
  async run(page, ctx) {
    const run = await startListingCheck(page, ctx, ANY_LISTING);
    if (!run) return [];
    const placed = run.listings.filter((l) => l.address !== undefined);
    if (placed.length === 0) return [];
    if (!run.site.address) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        'The site states no address, so listing addresses were not compared. Add a text fact with the id "address" to gaugeline.facts.json, or LocalBusiness structured data.',
      );
      return [];
    }
    const site = run.site.address;
    return placed.flatMap((l) =>
      addressesAgree(l.address ?? "", site.value) === false
        ? [
            finding(
              "listing-address-mismatch",
              "medium",
              this.title,
              `${l.label} says "${l.address}"${aside(l)}; your site says "${site.value}" (${site.from})`,
              l.url ?? page.finalUrl,
            ),
          ]
        : [],
    );
  },
});
