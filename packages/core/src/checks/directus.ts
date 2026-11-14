import { describePartial } from "../adapters/collect.js";
import type { DirectusReading } from "../adapters/directus-read.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need Directus's own answers: which published items have no page on the live site, and whether the
 * Public role can read a collection the owner marked private. Pure over a DirectusReading (ids, slugs, statuses
 * and counts, never a field), so the same site gives the same findings. Everything in a reading came from a
 * platform and a site: it is printed as text and never acted on.
 */

const nameOf = (i: { slug?: string; id: string }): string => i.slug ?? i.id;

/** What no check can say when the read itself fell short: a rate limit that stayed. */
function stopped(r: DirectusReading, ctx: CheckContext): void {
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const directusEntryNoPage = defineCheck<DirectusReading>({
  id: "directus-entry-no-page",
  size: "M",
  done: "Every published item of the collections you named has a page that answers on the live site.",
  estimateChanges:
    "A page that is gone for every item of a collection is one route or one address pattern in the front end. A single item is a slug that was changed or a page the front end does not build. A collection with no pages of its own always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A published Directus item has no page on the live site",
  what: "Directus says an item is published, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page.",
  fix: "Check the front end builds a page for the collection (a static site may need a rebuild or a revalidation after publishing) and that its address matches the pattern in gaugeline.adapters.json. If the item should not be public, set its status back to draft in Directus.",
  tech: "GET /items/{collection} for each collection named in the settings (limit, offset and sort=id, fields=id,status,slug and the dates; meta=filter_count for the total), a row whose status is not published is dropped, then one GET of the live address from the `urls` pattern (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A collection the token may not read, one with published items and no pattern, and an item whose slug the pattern cannot use are could-not-check by name and are not asked. Ids, slugs and statuses only: no field is used for this.",
  run(r, ctx) {
    if (r.nothingNamed)
      ctx.couldNotCheck?.(
        r.site,
        'No collection is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Gaugeline does not ask Directus to list its collections, so nothing was read.',
      );
    for (const u of r.unreadable)
      ctx.couldNotCheck?.(
        r.site,
        `${u.type}: Directus would not give this collection (${u.reason})`,
      );
    stopped(r, ctx);
    let said = r.nothingNamed || r.unreadable.length > 0 || r.partial !== undefined ? 1 : 0;
    for (const type of r.emptyTypes) {
      said++;
      ctx.couldNotCheck?.(
        r.site,
        `${type}: no item read as published, so no page of it was checked. The collection may be empty, or its status values may not be exactly "published" (Gaugeline reads only that word as live), or the status field may be missing or unreadable.`,
      );
    }
    for (const type of r.withoutPattern)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: its pages were not checked. It has published items and no address pattern in gaugeline.adapters.json (urls), and Gaugeline will not guess where a collection's pages are. If it has no pages of its own, this is expected.`,
      );
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(r.site, `${u.type}: item ${u.id} was not checked, because ${u.reason}.`);
    if (r.pagesSkipped > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.pagesSkipped} ${r.pagesSkipped === 1 ? "page was" : "pages were"} not asked for, because a run asks for at most ${r.pageBudget}.`,
      );
    if (
      r.pages.length === 0 &&
      said === 0 &&
      r.withoutPattern.length === 0 &&
      r.unaddressed.length === 0
    )
      ctx.couldNotCheck?.(
        r.site,
        "no published item with an address was asked, so no page was checked.",
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
        evidence: `${p.type}: ${nameOf(p)} is published in Directus and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

const PROBING_NOTE =
  "this check asks Directus for collections you marked private, as a visitor with no token, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const directusCollectionPublic = defineCheck<DirectusReading>({
  id: "directus-collection-public",
  size: "S",
  done: "A visitor with no token cannot list a single item of any collection you marked private.",
  estimateChanges:
    "Usually one change in Directus: open Settings, then Access Policies, then the Public policy, and remove read access from the collection. Allow longer if the front end reads that collection with no token and needs a server-side token instead.",
  area: "Security & email",
  severity: "high",
  title: "A Directus collection marked private is readable by visitors with no token",
  what: "gaugeline.adapters.json marks a collection private (privateCollections), and a plain GET of its items with no token is answered with items.",
  why: "Anyone who guesses the route can read the collection as data: bookings, customer notes, prices before they are announced. A search engine or scraper may already have it.",
  fix: "In Directus open Settings, then Access Policies, then the Public policy, and remove read access from the collection (or narrow it with a filter). If the front end needs the data, read it on the server with a token whose role is limited to what the page shows. If the collection is meant to be public, take it out of privateCollections.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; only for the collections named in the settings' privateCollections; per collection one GET of /items/{collection}?limit=1&fields=id&meta=filter_count with no Authorization header, no cookie and nothing the fetcher adds per address; a 200 with at least one item is the finding (its count is the reported filter_count, or "at least 1" when none is reported); a 200 with no items is could-not-check (the role may read it and there is nothing to count); a 401 or 403 is a closed collection only when its body is Directus's own error envelope (error code FORBIDDEN or INVALID_CREDENTIALS), otherwise it is could-not-check (a firewall or CDN page answers 403 too); a closed collection passes only when the token can read the same collection (a second request with the token, id only), because Directus also answers 403 for a collection that does not exist, and a Public policy that allows some fields but not id also answers 403 for fields=id, so a pass means no public read of id was seen, not that nothing is public; any other answer is could-not-check; the answer is read as a count and nothing else, and a finding is a collection name and a count, never an item`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check which Directus collections visitors can read.`,
      );
      return [];
    }
    if (r.markedPrivate.length === 0) {
      ctx.couldNotCheck?.(
        r.site,
        "not asked: no collection is marked private. Directus's Public role is often open on purpose, so Gaugeline asks only for the collections named in privateCollections in gaugeline.adapters.json.",
      );
      return [];
    }
    stopped(r, ctx);
    const out: Finding[] = [];
    for (const c of r.publicCollections) {
      if (c.state === "unread") {
        ctx.couldNotCheck?.(r.site, `${c.type}: not read (${c.reason ?? "no reason given"})`);
        continue;
      }
      if (c.state === "empty") {
        ctx.couldNotCheck?.(
          r.site,
          `${c.type}: Directus answered a visitor with no items, so there was nothing to count. The collection may be empty, or the Public role may read it and the filter in its permission may match nothing.`,
        );
        continue;
      }
      if (c.state === "closed") {
        if (c.exists !== true)
          ctx.couldNotCheck?.(
            r.site,
            `${c.type}: Directus answered a visitor 403, which it also answers for a missing collection, and the spelling is unconfirmed: ${c.unconfirmed ?? "the token could not read the collection."} Check the name in privateCollections.`,
          );
        continue;
      }
      if (c.state !== "public") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${c.type}: a request with no token listed ${c.exact ? c.listed : `at least ${c.listed}`} ${c.listed === 1 ? "item" : "items"}, and gaugeline.adapters.json marks the collection private`,
        url: r.site,
      });
    }
    // A collection that was marked and is missing from the answer was not asked (the read stopped first).
    const asked = new Set(r.publicCollections.map((c) => c.type));
    for (const name of r.markedPrivate)
      if (!asked.has(name) && !r.partial) ctx.couldNotCheck?.(r.site, `${name}: not asked.`);
    return out;
  },
});

export const DIRECTUS_CHECKS = [directusEntryNoPage, directusCollectionPublic] as const;

/** The checks a Directus read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createDirectusRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of DIRECTUS_CHECKS) registry.register(check);
  return registry;
}
