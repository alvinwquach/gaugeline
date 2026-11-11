import { describePartial } from "../adapters/collect.js";
import type { ContentfulReading } from "../adapters/contentful-read.js";
import { CheckRegistry, defineCheck, type Finding } from "../model.js";

/**
 * The check that needs Contentful's own answers: which published entries have no page on the live
 * site. Pure over a ContentfulReading (ids, slugs and statuses, never a field value), so the same site
 * gives the same findings. Everything in a reading came from a platform and a site: it is printed as
 * text and never acted on.
 */
export const contentfulEntryNoPage = defineCheck<ContentfulReading>({
  id: "contentful-entry-no-page",
  size: "M",
  done: "Every published entry of the content types you named has a page that answers on the live site.",
  estimateChanges:
    "A page that is gone for every entry of a content type is one route or one address pattern. A single entry is a slug that was changed or a page the site no longer builds. A content type with no pages of its own always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A published Contentful entry has no page on the live site",
  what: "Contentful says an entry is published, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and an announcement the client sent leads to an error page. On a statically built site this is often a build that has not run since the entry was published.",
  fix: "Check the site was rebuilt after the entry was published (a webhook from Contentful to your host can fail quietly) and that the address pattern in gaugeline.adapters.json matches the route. If the entry should not be public, unpublish it in Contentful.",
  tech: "GET /spaces/{space}/environments/{env}/content_types and /entries?content_type=... on cdn.contentful.com (Content Delivery API, delivery token in an Authorization header) for each content type, then one GET of the live address from the `urls` pattern (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A content type with published entries and no pattern, and an entry whose slug the pattern cannot use, are could-not-check by name and are not asked.",
  run(r, ctx) {
    for (const u of r.unreadable)
      ctx.couldNotCheck?.(
        r.site,
        `${u.type}: Contentful would not give this content type (${u.reason})`,
      );
    if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
    for (const type of r.withoutPattern)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: its pages were not checked. It has published entries and no address pattern in gaugeline.adapters.json (urls), and Gaugeline will not guess where a content type's pages are. If it has no pages of its own, this is expected.`,
      );
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(r.site, `${u.type}: entry ${u.id} was not checked, because ${u.reason}.`);
    if (r.pagesSkipped > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.pagesSkipped} ${r.pagesSkipped === 1 ? "page was" : "pages were"} not asked for, because a run asks for at most ${r.pageBudget}.`,
      );
    const out: Finding[] = [];
    for (const p of r.pages) {
      if (p.answer.kind === "unread") {
        ctx.couldNotCheck?.(p.url, `the page was not read (${p.answer.reason})`);
        continue;
      }
      if (p.answer.kind !== "missing") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${p.type}: ${p.slug ?? p.id} is published in Contentful and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const CONTENTFUL_CHECKS = [contentfulEntryNoPage] as const;

/** The checks a Contentful read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createContentfulRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of CONTENTFUL_CHECKS) registry.register(check);
  return registry;
}
