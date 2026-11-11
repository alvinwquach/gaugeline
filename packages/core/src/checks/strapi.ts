import { describePartial } from "../adapters/collect.js";
import type { StrapiReading } from "../adapters/strapi-read.js";
import { STRAPI_LIMITS } from "../adapters/strapi.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need Strapi's own answers: which published entries have no page on the live site,
 * and whether a visitor with no token can list work that was never published. Pure over a
 * StrapiReading (ids, slugs, statuses and counts, never a field), so the same site gives the same
 * findings. Everything in a reading came from a platform and a site: it is printed as text and never
 * acted on.
 */

const nameOf = (i: { slug?: string; id: string }): string => i.slug ?? i.id;

/** What no check can say when the read itself fell short: a collection the token would not give, or a rate limit that stayed. */
function unfinished(r: StrapiReading, ctx: CheckContext): void {
  for (const u of r.unreadable)
    ctx.couldNotCheck?.(r.site, `${u.type}: Strapi would not give this collection (${u.reason})`);
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const strapiEntryNoPage = defineCheck<StrapiReading>({
  id: "strapi-entry-no-page",
  size: "M",
  done: "Every published entry of the collections you named has a page that answers on the live site.",
  estimateChanges:
    "A page that is gone for every entry of a collection is one route or one address pattern in the front end. A single entry is a slug that was changed or a page the front end does not build. A collection with no pages of its own always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A published Strapi entry has no page on the live site",
  what: "Strapi says an entry is published, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page.",
  fix: "Check the front end builds a page for the collection (a static site may need a rebuild or a revalidation after publishing) and that its address matches the pattern in gaugeline.adapters.json. If the entry should not be public, unpublish it in Strapi.",
  tech: "GET /api/{collection} for each collection named in the settings (published entries are the default list; a row marked as a draft is dropped), then one GET of the live address from the `urls` pattern (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A collection with published entries and no pattern, and an entry whose slug the pattern cannot use, are could-not-check by name and are not asked. Ids, slugs and statuses only: no field is used for this.",
  run(r, ctx) {
    unfinished(r, ctx);
    for (const type of r.withoutPattern)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: its pages were not checked. It has published entries and no address pattern in gaugeline.adapters.json (urls), and Gaugeline will not guess where a collection's pages are. If it has no pages of its own, this is expected.`,
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
        evidence: `${p.type}: ${nameOf(p)} is published in Strapi and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

const PROBING_NOTE =
  "this check asks Strapi's public routes for entries that are not published, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const strapiDraftsPublic = defineCheck<StrapiReading>({
  id: "strapi-drafts-public",
  size: "S",
  done: "A visitor with no token cannot list a single entry that was never published, in any collection you named.",
  estimateChanges:
    "Usually one change in Strapi's Users & Permissions plugin: take the draft access away from the Public role, or stop sending drafts from the front end. Allow longer if the front end previews drafts through the public route and needs a preview token instead.",
  area: "Security & email",
  severity: "high",
  title: "Strapi lists unpublished entries to visitors with no token",
  what: "A visitor who sends no token and asks a collection for its drafts (status=draft, or publicationState=preview on Strapi 4) is given entries that have no published version.",
  why: "Unfinished work is public: prices before they are announced, an event before it is confirmed, a draft nobody has approved. Anyone who guesses the route can read it, and search engines or scrapers may already have.",
  fix: "In Strapi's settings, open Users & Permissions, then the Public role, and remove find and findOne from the collection, or give the front end a read-only API token and keep the Public role closed. If the front end previews drafts, send the token from the server, never from the browser.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; per collection named in the settings, with no Authorization header and no cookie: GET /api/{collection} for the published total, GET /api/{collection}?status=draft (and, only if Strapi answers 400 to that, publicationState=preview) for the draft total, both with pagination[pageSize]=1 and fields[0]=updatedAt; when the draft total is larger, the ids of both lists are read (at most ${STRAPI_LIMITS.publicIds} each, fields[0]=updatedAt only) and the entries only the draft list has are counted and named by id (Strapi 5 documentId, Strapi 4 id); a collection that answers 401, 403 or 404 to the published list is not public, and one that refuses only the draft list is safe; a finding is a count and ids, never a field; ids are held in a Set to subtract the published list from the draft list`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check which Strapi collections show unpublished entries to visitors.`,
      );
      return [];
    }
    unfinished(r, ctx);
    const out: Finding[] = [];
    for (const d of r.publicDrafts) {
      if (d.state === "unread") {
        ctx.couldNotCheck?.(r.site, `${d.type}: not read (${d.reason ?? "no reason given"})`);
        continue;
      }
      if (d.state !== "reachable") continue;
      const listed =
        d.ids.length > 0
          ? `: ${d.ids.slice(0, 10).join(", ")}${d.ids.length > 10 ? `, and ${d.ids.length - 10} more` : ""}`
          : " (the lists were too long to name them)";
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${d.type}: ${d.unpublished} ${d.unpublished === 1 ? "entry that is" : "entries that are"} not published can be listed with no token${listed}`,
        url: r.site,
      });
    }
    return out;
  },
});

export const STRAPI_CHECKS = [strapiEntryNoPage, strapiDraftsPublic] as const;

/** The checks a Strapi read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createStrapiRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of STRAPI_CHECKS) registry.register(check);
  return registry;
}
