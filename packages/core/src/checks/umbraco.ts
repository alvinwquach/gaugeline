import { describePartial } from "../adapters/collect.js";
import type { UmbracoReading } from "../adapters/umbraco-read.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need Umbraco's own answers: which published nodes have no page on the live site, and whether the
 * Delivery API answers a visitor who has no key when the owner has said it is private. Pure over an UmbracoReading
 * (ids, slugs, statuses and counts, never a property or a name), so the same site gives the same findings.
 * Everything in a reading came from a platform and a site: it is printed as text and never acted on.
 */

const nameOf = (i: { slug?: string; id: string }): string => i.slug ?? i.id;

/** What no check can say when the read itself fell short: a type the key would not give, or a rate limit that stayed. */
function unfinished(r: UmbracoReading, ctx: CheckContext): void {
  if (r.nothingNamed)
    ctx.couldNotCheck?.(
      r.site,
      'No content type is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and the Umbraco Delivery API does not list its content types, so nothing was read.',
    );
  if (r.noTypeSelected)
    ctx.couldNotCheck?.(
      r.site,
      "none of the content types asked for is named in the settings, so nothing was read.",
    );
  for (const u of r.unreadable)
    ctx.couldNotCheck?.(
      r.site,
      `${u.type}: Umbraco would not give this content type (${u.reason})`,
    );
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const umbracoNodeNoPage = defineCheck<UmbracoReading>({
  id: "umbraco-node-no-page",
  size: "M",
  done: "Every published node of the content types you named has a page that answers on the live site.",
  estimateChanges:
    "One node is usually a page that was unpublished in a different language or a route that was renamed. Every node of a content type missing means the template or the front end route for that type. A content type with no pages of its own always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A published Umbraco node has no page on the live site",
  what: "Umbraco says a node is published, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page.",
  fix: "Check the content type has a template (or the front end builds a route for it), that the node's culture and domain settings match the site being checked, and that a headless front end was rebuilt or revalidated after publishing. If the node should not be public, unpublish it in the Umbraco backoffice.",
  tech: "GET /umbraco/delivery/api/v2/content?filter=contentType:{alias} for each content type named in the settings (the published list; skip and take step by the number of nodes that came back, and a list is complete only when the position reaches the total it reports), then one GET of the live address: the settings' `urls` pattern when the type has one, else the route.path the API gave the node (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A node with no route and no pattern, and a path that is not a plain path (a host, `..`, an escaped slash), are could-not-check by name and are not asked. Ids and paths only: no property is requested beyond those named in `fingerprint`, and none is used for this. A site with several root nodes and no domains may give paths relative to a start item: set `urls` for those types.",
  run(r, ctx) {
    unfinished(r, ctx);
    for (const type of r.emptyTypes)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: no published nodes were read, so no page of it was checked. The alias may be mistyped, the type may be hidden from the API (DisallowedContentTypeAliases), or its content may exist only in another language.`,
      );
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(r.site, `${u.type}: node ${u.id} was not checked, because ${u.reason}.`);
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
        evidence: `${p.type}: ${nameOf(p)} is published in Umbraco and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

const PROBING_NOTE =
  "this check asks the Delivery API's public route as a visitor with no key, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const umbracoDeliveryApiPublic = defineCheck<UmbracoReading>({
  id: "umbraco-delivery-api-public",
  size: "S",
  done: "The Delivery API answers a visitor who sends no key with 401, and nothing else, because gaugeline.adapters.json says it is private (expectPrivate).",
  estimateChanges:
    "One setting in appsettings.json: Umbraco:CMS:DeliveryApi:PublicAccess to false (and an ApiKey set). Allow longer if the public front end calls the API from the browser and needs to move that call to the server.",
  area: "Security & email",
  severity: "high",
  title: "The Umbraco Delivery API answers visitors with no key",
  what: "gaugeline.adapters.json says the Content Delivery API is meant to be private (expectPrivate: true), and a plain GET of its list route with no key is answered with the list of published nodes.",
  why: "Anyone who finds the route can read every published node as data, including nodes that are published but not linked from the site, and can page through the whole content tree. If the API was meant to be private, its protection is off.",
  fix: "In appsettings.json set Umbraco:CMS:DeliveryApi:PublicAccess to false and keep an ApiKey, then send the key from the server only (never from the browser). If the API is meant to be public (a public API that also has a key, so that preview works, is a normal setup), remove expectPrivate from gaugeline.adapters.json: the key is not touched.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; only when the settings say expectPrivate: true (a key being set says nothing: Umbraco's preview needs the key on a public API too); one GET of /umbraco/delivery/api/v2/content?take=1 with no Api-Key header, no cookie and nothing the fetcher adds per address, fields=properties[] and expand=none; a 200 with a list and a numeric total is the finding (the total is a count, never a node); 401 or 403 is a protected API and 404 is an API that is off or not at that address, both with no finding; a 200 that is not the API's list (a page that answers every path) and any other status are could-not-check; the answer is read as a count and nothing else`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check whether the Umbraco Delivery API answers visitors with no key.`,
      );
      return [];
    }
    unfinished(r, ctx);
    if (!r.expectedPrivate) {
      ctx.couldNotCheck?.(
        r.site,
        "not asked: no privacy expectation given. A public Delivery API is a normal setup (a key is also needed for preview), so Gaugeline asks only when gaugeline.adapters.json says expectPrivate: true for umbraco.",
      );
      return [];
    }
    const api = r.publicApi;
    if (api === undefined) return [];
    if (api.state === "unread") {
      ctx.couldNotCheck?.(
        r.site,
        `the Delivery API was not read (${api.reason ?? "no reason given"})`,
      );
      return [];
    }
    if (api.state !== "public") return [];
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `a request with no key to /umbraco/delivery/api/v2/content was answered with a list of ${api.total ?? 0} ${api.total === 1 ? "node" : "nodes"}, and gaugeline.adapters.json says the API is private (expectPrivate)`,
        url: r.site,
      },
    ];
  },
});

export const UMBRACO_CHECKS = [umbracoNodeNoPage, umbracoDeliveryApiPublic] as const;

/** The checks an Umbraco read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createUmbracoRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of UMBRACO_CHECKS) registry.register(check);
  return registry;
}
