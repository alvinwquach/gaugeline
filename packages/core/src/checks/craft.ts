import { describePartial } from "../adapters/collect.js";
import type { CraftReading } from "../adapters/craft-read.js";
import { CheckRegistry, defineCheck, type Finding } from "../model.js";

/**
 * The check that needs Craft's own answers: which entries are live for a site and have no page on that site's
 * live pages. Pure over a CraftReading (ids, site handles, slugs and statuses, never a field value), so the
 * same install gives the same findings. Everything in a reading came from a platform and a site: it is
 * printed as text and never acted on.
 */
export const craftEntryNoPage = defineCheck<CraftReading>({
  id: "craft-entry-no-page",
  size: "M",
  done: "Every entry that is live on this site, in the sections you named, has a page that answers on the site's live pages.",
  estimateChanges:
    "A page that is gone for every entry of a section is one route or one template in the front end. A single entry is a slug that was changed or a page the front end does not build. On a multi-site install the usual cause is a template that only exists for one site. A section with no pages of its own always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A live Craft entry has no page on its site",
  what: "Craft says an entry is live (enabled, enabled for the site, posted and not expired) on this site, and the address its page should have answers 404 or 410 on the site's live pages.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page. On a multi-site install an entry can be switched on for a site whose templates or routes do not build it.",
  fix: "Check that the site has a route or template for the section (a headless front end may need a rebuild or a revalidation after publishing) and that the entry's URI matches it. If the entry should not be on this site, switch it off for the site in Craft (the entry's Site status).",
  tech: "GET {CRAFT_URL}?query=... with a GraphQL query only (never a mutation): entryCount and entries(section, site, status: [\"live\"], orderBy, limit, offset) for each section named in the settings, asking for id, slug, uri, url, siteHandle, status and the dates, never a field value; pages are stepped by the size each answer returned, and a repeated entry, an over-long page or an empty page before the total is could-not-check. Each live entry's own url (or the settings' urls pattern for its section) is then asked with one GET on the live site (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. An entry whose page is on another site's domain is not counted for this site. A section none of whose live entries is on this site, and a urls pattern on an entry set that spans several Craft sites with no site handle, are could-not-check, never a pass; so is a token whose schema was not shown to be query-only. Entries are kept in a Set by element id and site handle to catch a repeat.",
  run(r, ctx) {
    if (r.keyRefused !== undefined) {
      ctx.couldNotCheck?.(r.site, r.keyRefused);
      return [];
    }
    if (r.nothingNamed)
      ctx.couldNotCheck?.(
        r.site,
        'No section is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Craft lists its sections only to a schema that opted in, so nothing was read.',
      );
    for (const u of r.unreadable)
      ctx.couldNotCheck?.(r.site, `${u.type}: Craft would not give this section (${u.reason})`);
    for (const type of r.empty)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: Craft returned no live entry. The section may have none, or the key's schema may not include it (Craft does not say which).`,
      );
    for (const o of r.onOtherSites)
      ctx.couldNotCheck?.(
        r.site,
        `${o.type}: none of its ${o.count} live ${o.count === 1 ? "entry has" : "entries has"} a page on this site, so nothing was asked. Their addresses are on ${o.hosts.join(", ")}. Check that the address you gave is the site's own, or (a headless site) add a urls pattern for the section in gaugeline.adapters.json.`,
      );
    for (const type of r.patternNeedsSite)
      ctx.couldNotCheck?.(
        r.site,
        `${type}: its urls pattern is the same path on every site and its entries are on several sites, so it cannot say which entries belong to this one. Give the Craft site handle for this site (craftSite) and only that site is read.`,
      );
    if (r.keyUnconfirmed)
      ctx.couldNotCheck?.(
        r.site,
        "Gaugeline could not confirm this token cannot write (the schema's introspection was off or refused). Gaugeline only sends queries, but make the schema query-only (Craft: GraphQL, Schemas) so the key is read-only, and a key that can write is for live-site checks only.",
      );
    if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
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
        evidence: `${p.type}: ${p.slug ?? p.id} is live in Craft for the ${p.siteHandle} site and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const CRAFT_CHECKS = [craftEntryNoPage] as const;

/** The checks a Craft read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createCraftRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of CRAFT_CHECKS) registry.register(check);
  return registry;
}
