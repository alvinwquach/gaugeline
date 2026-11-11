import { describePartial } from "../adapters/collect.js";
import type { HubspotCmsReading } from "../adapters/hubspot-cms-read.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need HubSpot's own answers: which published pages are a 404 on the live domain, which
 * HubDB rows differ from the page that shows them, and which forms a page embeds that HubSpot no longer has.
 * Pure over a HubspotCmsReading (ids, paths, statuses, column names and counts, never a text or a value),
 * so the same site gives the same findings. Everything in a reading came from a platform and a site: it is
 * printed as text and never acted on. Every page they ask of the live site is a public page, so none of
 * them is a probing check.
 */

/** What no check can say when the read itself fell short: a part the token would not give, or a rate limit that stayed. */
function unfinished(r: HubspotCmsReading, ctx: CheckContext, parts: (p: string) => boolean): void {
  for (const u of r.unreadable)
    if (parts(u.part))
      ctx.couldNotCheck?.(r.site, `${u.part}: HubSpot would not give this (${u.reason})`);
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
  if (r.pagesSkipped > 0)
    ctx.couldNotCheck?.(
      r.site,
      `${r.pagesSkipped} ${r.pagesSkipped === 1 ? "page was" : "pages were"} not asked for, because a run asks for at most ${r.pageBudget}.`,
    );
}

const isPageList = (p: string): boolean => !p.startsWith("hubdb");
const isHubdb = (p: string): boolean => p.startsWith("hubdb");

export const hubspotPage404 = defineCheck<HubspotCmsReading>({
  id: "hubspot-page-404",
  size: "M",
  done: "Every page HubSpot says is published on this domain answers on the live site.",
  estimateChanges:
    "A page that is gone for a whole list is a domain, a language or a URL setting in HubSpot. A single page is usually a slug that was changed after publishing or a page a redirect rule swallows. Pages HubSpot serves on another domain of the same account are not counted.",
  area: "Launch day",
  severity: "high",
  title: "A page published in HubSpot answers 404 on the live domain",
  what: "HubSpot says a site page, landing page or blog post is published on this domain, and the address it gives for it answers 404 or 410 on the live site.",
  why: "Links, the sitemap, search results and the client's announcement point at a page that is not there, while the CMS shows it as live.",
  fix: "In HubSpot, open the page and check its domain, its URL and that it is published to this domain and not only to a staging one; republish it if it was cloned or moved. If it should not be public, unpublish it.",
  tech: "GET /cms/v3/pages/site-pages, /cms/v3/pages/landing-pages and /cms/v3/blogs/posts (each page of each list, stepped by the cursor the answer gives), keeping the pages whose state is PUBLISHED and whose own url is on the domain being checked (a page on another domain of the same portal is counted and not asked), then one anonymous GET of that address (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A page with no usable https address is could-not-check. Ids, slugs and statuses only: no field is read for this.",
  run(r, ctx) {
    unfinished(r, ctx, isPageList);
    if (r.noAddress > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.noAddress} published ${r.noAddress === 1 ? "page" : "pages"} had no usable https address from HubSpot and ${r.noAddress === 1 ? "was" : "were"} not asked.`,
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
        evidence: `${p.type} ${p.slug ?? p.id} is published in HubSpot and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const hubspotHubdbDrift = defineCheck<HubspotCmsReading>({
  id: "hubspot-hubdb-drift",
  size: "M",
  done: "Every column you named for a HubDB table shows the table's value on the page that displays the row.",
  estimateChanges:
    "Usually a page template that reads a different column, or a table published after the page was cached. Allow longer when the template formats the value (a price with a currency sign is looked for as written and with two decimals).",
  area: "Visitors",
  severity: "medium",
  title: "A HubDB row differs from the page that shows it",
  what: "A published row of a HubDB table has a value in a column you named in gaugeline.adapters.json, and the dynamic page for that row does not show it.",
  why: "Visitors see a price, a time or a name that is not the one the client keeps in the table, so what is sold or announced is not what the table says.",
  fix: "Open the dynamic page's template and check the column it prints, then publish the table again (a table change shows on the page only once the table is published). If the template formats the value differently, name another column or accept the difference.",
  tech: "GET /cms/v3/hubdb/tables for the published tables, GET /cms/v3/hubdb/tables/{table}/rows for the published rows (stepped by the cursor), and the dynamic page that uses the table (a published page whose dynamicPageHubDbTableId is the table's id); for each row with a path, one anonymous GET of the page's address plus the row's path. Only the columns named under `fingerprint` for `hubdb.<table>` are used: each value is looked for in the words of the page (scripts, styles and tags removed, entities decoded, case ignored; a number as written, with two decimals and with a thousands comma, as a whole number). The values are held only for that comparison; a finding names the table, the row id, the page and the column, never a value. A table with no dynamic page, a row with no path, a row with nothing that can be looked for and a page that was not read are could-not-check.",
  run(r, ctx) {
    unfinished(r, ctx, isHubdb);
    for (const t of r.hubdbWithoutPage)
      ctx.couldNotCheck?.(
        r.site,
        `hubdb.${t}: no published dynamic page on this domain shows this table, so its rows were not compared. Pages that list a table without a page for each row are not checked.`,
      );
    if (r.hubdbRowsWithoutPath > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.hubdbRowsWithoutPath} HubDB ${r.hubdbRowsWithoutPath === 1 ? "row has" : "rows have"} no path, so no page of ${r.hubdbRowsWithoutPath === 1 ? "its" : "their"} own, and ${r.hubdbRowsWithoutPath === 1 ? "was" : "were"} not compared.`,
      );
    const out: Finding[] = [];
    for (const d of r.hubdb) {
      if (d.state === "unread") {
        ctx.couldNotCheck?.(
          `${r.site}${d.path}`,
          `hubdb.${d.table} row ${d.rowId} was not compared (${d.reason ?? "no reason given"})`,
        );
        continue;
      }
      if (d.state !== "differs") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `hubdb.${d.table} row ${d.rowId}: ${d.columns.length === 1 ? "column" : "columns"} ${d.columns.join(", ")} ${d.columns.length === 1 ? "is" : "are"} not on ${d.path}`,
        url: `${r.site}${d.path}`,
      });
    }
    return out;
  },
});

export const hubspotFormDeleted = defineCheck<HubspotCmsReading>({
  id: "hubspot-form-deleted",
  size: "S",
  done: "Every HubSpot form a page embeds still exists in the portal.",
  estimateChanges:
    "Minutes to point the embed at the form that replaced the deleted one, or to restore it from HubSpot's recently deleted forms. Longer when the page's template holds the form id in several places.",
  area: "Launch day",
  severity: "high",
  title: "A page embeds a HubSpot form that has been deleted",
  what: "A page on the live site embeds a HubSpot form by its id, and HubSpot answers that the form does not exist in this portal.",
  why: "The form shows nothing or an error, so enquiries and orders sent through it are lost without anyone seeing a failure.",
  fix: "Restore the form in HubSpot (Marketing, Forms, recently deleted), or edit the page or its template to embed a form that exists.",
  tech: "The form ids and portal ids are read as text from the HTML of the published pages already asked for (data-form-id and portalId/formId in an hbspt.forms.create call; nothing is run); only forms of the portal the token belongs to (GET /account-info/v3/details) are asked about, one GET /marketing/v3/forms/{formId} for each different form (at most 50 a run); a 404, or a form marked archived, is the finding. A token without the forms scope, a page that names no portal or more than one, and a form of another portal are could-not-check or not counted, never a pass. Form ids and page paths only.",
  run(r, ctx) {
    unfinished(r, ctx, isPageList);
    if (r.forms.unread !== undefined)
      ctx.couldNotCheck?.(r.site, `forms were not checked: ${r.forms.unread}`);
    const out: Finding[] = [];
    for (const f of r.forms.deleted)
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `form ${f.formId} no longer exists in HubSpot and is embedded on ${f.paths.slice(0, 10).join(", ")}${f.paths.length > 10 ? `, and ${f.paths.length - 10} more` : ""}`,
        url: `${r.site}${f.paths[0] ?? "/"}`,
      });
    return out;
  },
});

export const HUBSPOT_CMS_CHECKS = [hubspotPage404, hubspotHubdbDrift, hubspotFormDeleted] as const;

/** The checks a HubSpot read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createHubspotCmsRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of HUBSPOT_CMS_CHECKS) registry.register(check);
  return registry;
}
