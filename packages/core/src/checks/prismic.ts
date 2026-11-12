import { describePartial } from "../adapters/collect.js";
import type { PrismicReading } from "../adapters/prismic-read.js";
import { PRISMIC_LIMITS } from "../adapters/prismic.entry.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need Prismic's own answers: which published documents have no page on the live site, whether the
 * public cache serves an older master ref than the origin, and whether a release holds an older copy of a document
 * than the live one. Pure over a PrismicReading (ids, types, times and counts, never a field), so the same
 * repository gives the same findings. Everything in a reading came from a platform and a site: it is printed as
 * text and never acted on.
 */

const nameOf = (i: { slug?: string; id: string }): string => i.slug ?? i.id;

/** What no check can say when the read itself fell short: a rate limit that stayed. */
function stopped(r: PrismicReading, ctx: CheckContext): void {
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const prismicDocumentNoPage = defineCheck<PrismicReading>({
  id: "prismic-document-no-page",
  size: "M",
  done: "Every published document of the types you gave an address pattern for has a page that answers on the live site.",
  estimateChanges:
    "A page that is gone for every document of a type is one route or one address pattern in the front end. A single document is a uid that was changed or a page the front end does not build. A type with no pages of its own always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A published Prismic document has no page on the live site",
  what: "Prismic says a document is published, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page.",
  fix: "Check the front end builds a page for the type (a static site may need a rebuild or a revalidation after publishing, which a Prismic webhook can trigger) and that its address matches the pattern in gaugeline.adapters.json. If the document should not be public, unpublish it in Prismic.",
  tech: "GET /api/v2 on the repository's cdn.prismic.io host for the master ref and the document types, then GET /api/v2/documents/search for each type that has an address pattern in the settings (ref, lang=*, page, pageSize, an explicit orderings, q for the type, fetch for the fields the settings fingerprint); each page asks for the number it should, the same total and page count as the first, no document twice, and the list ends only when the count read equals the total, otherwise it is could-not-check; then one GET of the live address from the urls pattern (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A document in a language other than the repository's main one, a document with no uid where the pattern needs one, a type with documents and no pattern, a type the repository would not list and a private repository without an access token are could-not-check by name and are not asked. Ids, uids and times only: no field is used for this.",
  run(r, ctx) {
    if (r.unreadable !== undefined) {
      ctx.couldNotCheck?.(r.site, `Prismic would not list its document types (${r.unreadable})`);
      return [];
    }
    if (r.nothingNamed)
      ctx.couldNotCheck?.(
        r.site,
        'No document type has an address pattern in gaugeline.adapters.json (under "urls"), and Gaugeline will not guess where a type\'s pages are, so no page was asked for.',
      );
    for (const u of r.unreadableTypes)
      ctx.couldNotCheck?.(r.site, `${u.type}: Prismic would not list this type (${u.reason})`);
    stopped(r, ctx);
    for (const type of r.withoutPattern)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: its pages were not checked. It has published documents and no address pattern in gaugeline.adapters.json (urls), and Gaugeline will not guess where a type's pages are. If it has no pages of its own, this is expected.`,
      );
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(
        r.site,
        `${u.type}: document ${u.id} was not checked, because ${u.reason}.`,
      );
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
        evidence: `${p.type}: ${nameOf(p)} is published in Prismic and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const prismicMasterRefStale = defineCheck<PrismicReading>({
  id: "prismic-master-ref-stale",
  size: "S",
  done: "The public cache of your Prismic repository serves the same master ref as the origin, so visitors see what you last published.",
  estimateChanges:
    "Usually nothing to change: a stale ref clears when the cache refreshes. If it stays, a few minutes to look at what sits in front of Prismic (a proxy, a build that stored the ref, or a hosting cache) and to make the front end ask for the master ref on each request or after each publish webhook.",
  area: "Launch day",
  severity: "medium",
  title: "The Prismic cache is serving an older master ref than the origin",
  what: "The repository's root on the public cache host (cdn.prismic.io) names a different master ref than the origin host (prismic.io) did on three reads about six seconds apart, and the origin's ref shows a document published after the newest one the cache's ref shows.",
  why: "A site built or rendered against the cache's ref keeps showing the older content, so what the client just published does not appear, and nothing on the site says so.",
  fix: "Wait a minute and run again. If it stays, find what holds the old ref: a front end that stores the master ref at build time (ask for it again on each request, or rebuild from Prismic's publish webhook), or a proxy or hosting cache in front of the Prismic API. Prismic's own client keeps the ref for five seconds.",
  tech: `GET /api/v2 on <repository>.cdn.prismic.io and on <repository>.prismic.io (the origin), no token unless the repository refuses without it (then an Authorization: Token header, never the address), reading the one ref with isMasterRef true from each; the same master ref is a pass; different refs are read again after ${PRISMIC_LIMITS.settleSeconds} seconds, and the same two different refs on the second read are compared by the newest document each shows (GET /api/v2/documents/search with that ref, pageSize=1, orderings=[document.last_publication_date desc], lang=*); a finding only when the origin's newest publication is later than the cache's; two different refs that show no such difference, or refs that keep changing across three reads (a publication in flight), are could-not-check; the finding quotes two times and one document id, never a field`,
  run(r, ctx) {
    stopped(r, ctx);
    const m = r.master;
    if (m.state === "unread") {
      ctx.couldNotCheck?.(r.site, `the master ref was not read (${m.reason})`);
      return [];
    }
    if (m.state === "undetermined") {
      ctx.couldNotCheck?.(r.site, `the master ref could not be judged: ${m.reason}`);
      return [];
    }
    if (m.state === "same") return [];
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `the cache's master ref shows its newest publication at ${m.cacheLatest ?? "an unknown time"}, and the origin's shows document ${m.originLatestId ?? "unknown"} published at ${m.originLatest ?? "an unknown time"}`,
        url: r.site,
      },
    ];
  },
});

const PROBING_NOTE =
  "this check reads the repository's releases, which hold content that is not published, with the access token you gave Gaugeline, so it runs only with --owner-consent (or gaugeline.consent.json) and checkReleases: true in gaugeline.adapters.json, on sites you own or have permission to test";

export const prismicReleaseDocumentLive = defineCheck<PrismicReading>({
  id: "prismic-release-document-live",
  size: "S",
  done: "No release in your Prismic repository holds an older copy of a document than the one that is already live.",
  estimateChanges:
    "A few minutes in Prismic per release: open the release, remove the documents that are already live in a newer version, or update them from the live version, before the release is published.",
  area: "Launch day",
  severity: "medium",
  title: "A Prismic release holds a document that is already live in a newer version",
  what: "A release lists a document whose copy in the release was last published before the copy that is live now.",
  why: "Publishing the release would put the older copy back over the newer live one, and the change someone published since would disappear from the site.",
  fix: "In Prismic open the release, and for each document named remove it from the release or refresh it from the live version. If the older copy is what you want live, publish it as a new version and leave it in the release.",
  tech: `probing check, off without --owner-consent and checkReleases: true: ${PROBING_NOTE}; GET /api/v2 with the token in an Authorization: Token header (never the address) for the refs, then for the master ref and for each release ref (at most ${PRISMIC_LIMITS.releases} releases, ordered by id) GET /api/v2/documents/search with that ref, lang=*, an explicit orderings, page and pageSize, read as ids, types and publication times only; each list is a snapshot at its ref and is checked page by page (the page asked for, the same total, no document twice, the count read equal to the total); a document in a release whose last publication time is earlier than the same document's at the master ref is the finding (its id and type, never a field); the refs are read again afterwards and a change in the master ref or a release's ref starts the reading over once, a second change is could-not-check; a release that cannot be listed, more than the release limit, a repository that lists no release and a token the repository does not accept are could-not-check for that part; what a release read returns for a document is Prismic's own and this comparison is not described on its documentation page, which the docs page says`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check the releases of the Prismic repository.`,
      );
      return [];
    }
    if (!r.releasesEnabled) {
      ctx.couldNotCheck?.(
        r.site,
        "not asked: reading releases reads unpublished content, so Gaugeline asks only when gaugeline.adapters.json says checkReleases: true for prismic.",
      );
      return [];
    }
    stopped(r, ctx);
    if (r.releasesError !== undefined) {
      ctx.couldNotCheck?.(r.site, `the releases were not read (${r.releasesError})`);
      return [];
    }
    const out: Finding[] = [];
    if (r.releases.length === 0 && !r.partial)
      ctx.couldNotCheck?.(
        r.site,
        "the repository lists no release, so there was nothing to compare. A repository that hides its releases from the token looks the same.",
      );
    for (const rel of r.releases) {
      const label = rel.label === "" ? rel.id : rel.label;
      if (rel.state === "unread") {
        ctx.couldNotCheck?.(
          r.site,
          `release ${label}: not read (${rel.reason ?? "no reason given"})`,
        );
        continue;
      }
      if (rel.behind.length === 0) continue;
      const ids = rel.behind.slice(0, 5).map((d) => `${d.type} ${d.id}`);
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `release ${label} holds ${rel.behind.length} ${rel.behind.length === 1 ? "document" : "documents"} last published before the live copy (${ids.join(", ")}${rel.behind.length > 5 ? ", and more" : ""}); publishing it would put the older copy back`,
        url: r.site,
      });
    }
    return out;
  },
});

export const PRISMIC_CHECKS = [
  prismicDocumentNoPage,
  prismicMasterRefStale,
  prismicReleaseDocumentLive,
] as const;

/** The checks a Prismic read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createPrismicRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of PRISMIC_CHECKS) registry.register(check);
  return registry;
}
