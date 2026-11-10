import { websiteProblem } from "../listings/match.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { aside, finding, startListingCheck } from "./listings/shared.js";

export const listingWebsiteWrong = defineCheck<PageSnapshot>({
  id: "listing-website-wrong",
  area: "Search & sharing",
  severity: "high",
  title: "A listing links to the wrong place",
  what: "The website link on a listing, or in a social bio, leads to an old domain, to a page that no longer works, or through a long chain of redirects.",
  why: "The website button on the listing is how a guest reaches the menu and the booking form. When it points at an old domain that lapses, or a page you deleted, every one of those visits ends in an error.",
  fix: "Set the listing's website to your site's current address, in the listing's own dashboard or in the bio.",
  tech: "the link is opened with GET (at most 8 distinct links, one request each): it is wrong when it cannot be opened, answers 400 or above, is on a different host from the checked site (www ignored) even if it redirects there, or takes 3 redirects or more; a link-in-bio page is right when it lands on the site or links to it; Yelp does not return a website, so it is not compared",
  async run(page, ctx) {
    const run = await startListingCheck(
      page,
      ctx,
      (c) => c === "google-business" || c === "google-places" || c === "apple" || c === "bio-link",
    );
    if (!run) return [];
    const linked = run.listings.filter((l) => l.website !== undefined);
    return linked.flatMap((l) => {
      const found = run.read.links.get(l.website ?? "");
      if (!found) {
        ctx.couldNotCheck?.(
          l.url ?? page.finalUrl,
          `${l.label} has a website link that was not opened: Gaugeline opens at most 8 links in a run.`,
        );
        return [];
      }
      const problem = websiteProblem(l.website ?? "", found, run.site.host);
      return problem === undefined
        ? []
        : [
            finding(
              "listing-website-wrong",
              "high",
              this.title,
              `${l.label}: ${problem}${aside(l)}`,
              l.url ?? page.finalUrl,
            ),
          ];
    });
  },
});
