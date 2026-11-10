import { namesAgree } from "../listings/match.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { ANY_LISTING, aside, finding, startListingCheck } from "./listings/shared.js";

export const listingNameMismatch = defineCheck<PageSnapshot>({
  id: "listing-name-mismatch",
  area: "Search & sharing",
  severity: "high",
  title: "A listing still uses your old business name",
  what: "The name on your Google, Yelp or Apple listing is not the name your site uses.",
  why: "Most people find a bar or a clinic through the listing, not the website. If it still shows a name you retired, they search for the wrong thing and doubt that the place is the one they want.",
  fix: "Change the name in the listing's own dashboard (Google Business Profile, Yelp for Business, Apple Business Connect) to the one on your site, or fix the site if the listing is right.",
  tech: "the listing's name, normalised (case, accents, punctuation and a leading or trailing \"The\" ignored), is neither equal to the site's name nor the site's name with words around it; the site's name is the text fact \"name\" in gaugeline.facts.json, else the LocalBusiness name in structured data; permanently closed listings are not compared",
  async run(page, ctx) {
    const run = await startListingCheck(page, ctx, ANY_LISTING);
    if (!run) return [];
    const named = run.listings.filter((l) => l.name !== undefined);
    if (named.length === 0) return [];
    if (!run.site.name) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        'The site states no business name, so listing names were not compared. Add a text fact with the id "name" to gaugeline.facts.json, or LocalBusiness structured data.',
      );
      return [];
    }
    const site = run.site.name;
    return named.flatMap((l) =>
      namesAgree(l.name ?? "", site.value)
        ? []
        : [
            finding(
              "listing-name-mismatch",
              "high",
              this.title,
              `${l.label} says "${l.name}"${aside(l)}; your site says "${site.value}" (${site.from})`,
              l.url ?? page.finalUrl,
            ),
          ],
    );
  },
});
