import { readListing } from "../content-model/listing.js";
import { idList, ready, safe, why } from "../content-model/shared.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { countType, idsNotIn } from "../sources/sanity-schema.js";

/** Missing entries named in a finding. */
const NAMED = 10;

export const modelListingCount = defineCheck<PageSnapshot>({
  id: "model-listing-count",
  area: "Visitors",
  severity: "high",
  title: "A listing shows fewer entries than are published",
  what: "A listing page you mapped to a document type shows fewer entries, across all its pages of results, than there are published documents of that type (less the ones you said it leaves out).",
  why: "A query that drops documents (a filter on a field older documents lack, a reference that does not resolve) leaves the page looking complete: 31 cards instead of 48 is not an error, and nobody counts.",
  fix: "Open the entries named in the evidence in the Studio and compare them with the listing's query. If the listing leaves some out on purpose, say so with filter in gaugeline.model.json.",
  tech: "For each listing in gaugeline.model.json: the page is read with GET and its next link (rel=next, or the next selector) is followed, up to 10 pages; entries are the item selector's matches, counted once per address. The published count is count(*[_type == T && (filter)]) over published documents (GET). When fewer are shown, the ids of the published documents whose slug is not on the page come back (up to ten, in id order); titles are never requested. A page that cannot be read, or a listing longer than 10 pages, is could not check",
  async run(page, ctx) {
    const r = ready(page, ctx, false);
    if (!r) return [];
    const listings = r.model.config.listings ?? [];
    if (listings.length === 0) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        'No listing is named in gaugeline.model.json, so nothing was counted. Add one under "listings" (its page, document type and item selector). See docs/sources/sanity-schema.',
      );
      return [];
    }
    if (!ctx.statePages) return [];
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const listing of listings) {
      const name = safe(listing.name ?? listing.page, 60);
      const shownOn = await readListing(listing, origin, ctx.statePages);
      if (!shownOn.ok) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The listing "${name}" was not counted: ${safe(shownOn.reason, 160)}.`,
        );
        continue;
      }
      let published: number;
      let missing;
      try {
        published = await countType(r.read, listing.type, listing.filter);
        if (shownOn.shown >= published) continue;
        missing = shownOn.allAddressed
          ? await idsNotIn(
              r.read,
              listing.type,
              listing.filter,
              listing.slug ?? "slug.current",
              shownOn.slugs,
              NAMED,
            )
          : ({
              ok: false,
              reason: "some entries on the page have no link to read an address from",
            } as const);
      } catch (err) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The documents of "${safe(listing.type)}" could not be counted: ${why(err)}`,
        );
        break;
      }
      const left = missing.ok
        ? missing.ids.length === 0
          ? " Every published document's address is on the page, so some documents share an address (gaugeline query --dupes finds them)."
          : ` Not on the page: ids ${idList(missing.ids)}${published - shownOn.shown > missing.ids.length ? " (the first ten)" : ""}.`
        : ` Which ones are missing could not be named: ${missing.reason}.`;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${name} shows ${shownOn.shown} of ${published} published "${safe(listing.type)}" entries (${shownOn.pages} page${shownOn.pages === 1 ? "" : "s"} of results).${left}`,
        url: `${origin}${listing.page}`,
      } satisfies Finding);
    }
    return out;
  },
});
