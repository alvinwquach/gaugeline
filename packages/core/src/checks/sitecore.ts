import { describePartial } from "../adapters/collect.js";
import type { SitecoreReading } from "../adapters/sitecore-read.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need Sitecore's own answers: which routes Experience Edge says are published have no page on the
 * live site, and whether the preview endpoint answers on the public site when the owner says it should not. Pure
 * over a SitecoreReading (languages, route paths, statuses and counts, never a page's text or a field), so the same
 * site gives the same findings. Everything in a reading came from a platform and a site: it is printed as text and
 * never acted on.
 */

/** What no check can say when the read itself fell short: a language Edge would not give, or a rate limit that stayed. */
function unfinished(r: SitecoreReading, ctx: CheckContext): void {
  for (const u of r.unreadable)
    ctx.couldNotCheck?.(
      r.site,
      `${u.type}: Experience Edge would not give the routes (${u.reason})`,
    );
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const sitecoreRouteNoPage = defineCheck<SitecoreReading>({
  id: "sitecore-route-no-page",
  size: "M",
  done: "Every route published to Experience Edge for the languages you named has a page that answers on the live site.",
  estimateChanges:
    "One route is usually a page the front end does not build, or a path that was renamed. Every route under one folder missing means one route or one template in the front end. After a publish, a headless front end often needs a rebuild or a revalidation. A language with no urls prefix in the settings always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A route published to Sitecore Experience Edge has no page on the live site",
  what: "Experience Edge says a route is published for a language, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page. Edge is what the front end reads, so a route that is on Edge and not on the site means the front end did not build it.",
  fix: "Check that the front end has a route for the path (a rebuild or a revalidation may be needed after publishing), that the language's urls prefix in gaugeline.adapters.json matches how the site addresses that language, and that the item is not published by mistake. If the page should not be public, unpublish the item in Sitecore.",
  tech: "POST https://edge.sitecorecloud.io/api/graphql/v1 (a documented read-only query, through the fetcher's query allowlist, ADR-0006) with the Delivery API token in the sc_apikey header: site { siteInfo(site) { routes(language, first, after) { total pageInfo { endCursor hasNext } results { routePath } } } }, every value a variable; pages are followed by the cursor Edge returns, and a repeated cursor or route, a missing hasNext, an empty page before the end and fewer routes than total are could-not-check. Then one GET of each route's address on the live site: the route path for the first language, the settings' urls prefix plus the route path for any language that has one (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A language with no prefix that is not the first, an address on another site, and a path that is not a plain path (a host, `..`, an escaped slash) are could-not-check by name and are not asked. Routes only: no field of any item is requested. Routes are kept in a Set per language to catch a repeat.",
  run(r, ctx) {
    unfinished(r, ctx);
    for (const type of r.emptyLanguages)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: Experience Edge returned no published route, so no page of it was checked. The site name or the language may be mistyped, or nothing in that language was published to Edge.`,
      );
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(r.site, `${u.type}: route ${u.id} was not checked, because ${u.reason}.`);
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
      const route = p.id.slice(p.type.length + 1);
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence:
          route === p.path
            ? `${p.type}: ${route} is published to Experience Edge and answers ${p.answer.status} on the live site`
            : `${p.type}: ${route} is published to Experience Edge and its page ${p.path} answers ${p.answer.status} on the live site`,
        url: p.url,
      });
    }
    return out;
  },
});

const PROBING_NOTE =
  "this check asks the preview endpoint's path on the public site's own host, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const sitecorePreviewPublic = defineCheck<SitecoreReading>({
  id: "sitecore-preview-public",
  size: "S",
  done: "The preview endpoint's path does not answer on the public site's host, because gaugeline.adapters.json says it should not (expectPrivate).",
  estimateChanges:
    "Usually one rule on the host or the CDN in front of it: block the path /sitecore/api/graph/edge on the public host, or point the front end at the Delivery endpoint only. Allow longer if the public front end calls the preview endpoint from the browser and that call has to move to the server.",
  area: "Security & email",
  severity: "medium",
  title: "The Sitecore preview endpoint answers on the public site",
  what: "gaugeline.adapters.json says the preview endpoint should not be reachable from the public site (expectPrivate: true), and a plain GET of its path on the public host, with no key, is answered by a GraphQL server.",
  why: "The preview endpoint reads from the content management back end, so it can return content that has not been published. It is meant to be protected by its own API key, and its being on the public host means a visitor can reach it and the key is the only thing between them and draft content.",
  fix: "Keep the preview endpoint off the public host: put the content management host on its own address that is not linked from the site, or block the path on the public host at the CDN or the web server, and send the preview key from the server only. If the endpoint is meant to be public, remove expectPrivate from gaugeline.adapters.json.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; only when the settings say expectPrivate: true; one GET of {site origin}/sitecore/api/graph/edge with no sc_apikey header, no cookie and no redirect followed, reading at most 8 KiB; a 200 or 400 whose body is a JSON object with a data or errors key is the finding (a GraphQL server answered a visitor with no key; no content is requested and none is read); 401 or 403 is a protected endpoint and 404 or 410 is a path that is not there, both with no finding; a 200 or 400 that is not a GraphQL answer (a page that answers every path) and any other status, redirects included, are could-not-check`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check whether the Sitecore preview endpoint answers on the public site.`,
      );
      return [];
    }
    unfinished(r, ctx);
    if (!r.expectedPrivate) {
      ctx.couldNotCheck?.(
        r.site,
        "not asked: no privacy expectation given. Gaugeline asks only when gaugeline.adapters.json says expectPrivate: true for sitecore.",
      );
      return [];
    }
    const p = r.preview;
    if (p === undefined) return [];
    if (p.state === "unread") {
      ctx.couldNotCheck?.(
        r.site,
        `the preview endpoint's path was not read (${p.reason ?? "no reason given"})`,
      );
      return [];
    }
    if (p.state !== "answers") return [];
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `a request with no key to /sitecore/api/graph/edge on the public site was answered by a GraphQL server (HTTP ${p.status ?? 200}), and gaugeline.adapters.json says it should not be reachable there (expectPrivate)`,
        url: r.site,
      },
    ];
  },
});

export const SITECORE_CHECKS = [sitecoreRouteNoPage, sitecorePreviewPublic] as const;

/** The checks a Sitecore read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createSitecoreRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of SITECORE_CHECKS) registry.register(check);
  return registry;
}
