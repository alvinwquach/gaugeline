import { describePartial } from "../adapters/collect.js";
import type { DatocmsReading } from "../adapters/datocms-read.js";
import { CheckRegistry, defineCheck, type Finding } from "../model.js";

/**
 * The check that needs DatoCMS's own answers: whether the token the owner calls published-only can read draft
 * records. Pure over a DatocmsReading (ids and counts, never a field or a name), so the same project gives the same
 * findings. Everything in a reading came from a platform: it is printed as text and never acted on.
 */
const PROBING_NOTE =
  "this check asks DatoCMS for draft content with the token you gave Gaugeline, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const datocmsDraftsReachable = defineCheck<DatocmsReading>({
  id: "datocms-drafts-reachable",
  size: "S",
  done: "The DatoCMS token you gave Gaugeline cannot read a draft record, as gaugeline.adapters.json says it should not (expectPublishedOnly).",
  estimateChanges:
    "A few minutes in the DatoCMS dashboard: turn off draft access on the token, or make a new token for the live site and swap it in the hosting settings. Allow longer if the same token also powers a preview site that needs drafts, because that site needs its own token first.",
  area: "Security & email",
  severity: "high",
  title: "A DatoCMS token meant for published content can read drafts",
  what: "gaugeline.adapters.json says the token is meant for published content only (expectPublishedOnly: true), and a request that asks for drafts with it is answered with records that are not published.",
  why: "A token for the live site is often placed in the front end or in a build setting. If it can read drafts, anyone who finds it can read unpublished work: prices not announced yet, a closure notice, a page that was pulled.",
  fix: "In the DatoCMS dashboard, open Settings, API tokens, and edit the token the live site uses: turn off access to the Content Delivery API with draft content (the preview flag), keep the Content Delivery API on for published content, and keep the Content Management API off. Give a preview site its own token. If the token is meant to preview drafts, remove expectPublishedOnly from gaugeline.adapters.json.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; run only on sites you own or have permission to test; only when the settings say expectPublishedOnly: true for datocms and name the collections, since a token that may preview is a normal setup; per collection, POSTs of one GraphQL query each, through fetcher.query and the registered allowlist entry datocms-cda-query (a document that parses as one query is the only body ever sent): the published list, then the same list with the header X-Include-Drafts: true, each asking for id only, first 100, an explicit orderBy: [id_ASC], skip stepping by the number of records that came back, a page shorter than the page asked for ending the list, and the first page also asking the collection's count (a list that ends with another number of records is could-not-check, and a count over 10000 fails on the first page); the ids of the first list are held in a Set and subtracted from the second, and a non-empty difference is the finding (a count; ids only when the settings say showDraftIds, at most five; never a field); when there is a difference the published list is read once more and a list that changed in between is could-not-check; HTTP 401 or 403 to the first page of the draft request, after the published one was answered, means the token cannot read drafts, which is a pass for that collection, while a refusal on a later page is could-not-check; a draft request that is accepted with no extra record shows no sign of drafts, which is not proof since none may exist, so it is could-not-check; the check judges the token you give Gaugeline, so to test the live site's token give Gaugeline that token; a collection that cannot be read, a list that moves while it is read, one over 10000 records scanned and a rate limit that stays are could-not-check for that part`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check whether the DatoCMS token can read drafts.`,
      );
      return [];
    }
    if (!r.expectedPublishedOnly) {
      ctx.couldNotCheck?.(
        r.site,
        "not asked: no expectation given. A token that can preview drafts is a normal setup, so Gaugeline asks only when gaugeline.adapters.json says expectPublishedOnly: true for datocms.",
      );
      return [];
    }
    if (r.nothingNamed) {
      ctx.couldNotCheck?.(
        r.site,
        'No collection is named in gaugeline.adapters.json (under "collections"), and the DatoCMS Content Delivery API does not list its content types, so nothing was read.',
      );
      return [];
    }
    const out: Finding[] = [];
    for (const d of r.drafts) {
      if (d.state === "unread") {
        ctx.couldNotCheck?.(
          r.site,
          `${d.type}: DatoCMS would not give this collection (${d.reason ?? "no reason given"})`,
        );
      } else if (d.state === "accepted-no-drafts") {
        ctx.couldNotCheck?.(
          r.site,
          `${d.type}: the token was accepted with a request that asks for drafts, and there is no record that is not published, so whether drafts can be read cannot be told from here.`,
        );
      } else if (d.state === "reachable") {
        const ids =
          d.extraIds.length === 0
            ? ""
            : ` (${d.extraIds.length === 1 && d.extra === 1 ? "id" : "ids"} ${d.extraIds.join(", ")}${d.extra > d.extraIds.length ? ", and more" : ""})`;
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${d.type}: a request that asks for drafts returned ${d.extra} ${d.extra === 1 ? "record" : "records"} that the published list does not have${ids}`,
          url: r.site,
        });
      }
    }
    if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
    return out;
  },
});

export const DATOCMS_CHECKS = [datocmsDraftsReachable] as const;

/** The checks a DatoCMS read runs. They are not in the page registry: they read the CMS, not one page. */
export function createDatocmsRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of DATOCMS_CHECKS) registry.register(check);
  return registry;
}
