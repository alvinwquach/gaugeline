import { describePartial } from "../adapters/collect.js";
import type { StagedRead, WebflowReading } from "../adapters/webflow-read.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need Webflow's own answers: what the CMS has saved and not published, and which
 * published items have no page on the live site. Pure over a WebflowReading (ids, slugs, times and
 * statuses, never a name or a field), so the same site gives the same findings. Everything in a
 * reading came from a platform and a site: it is printed as text and never acted on.
 */

const day = (iso: string): string => iso.slice(0, 10);
const nameOf = (i: { slug?: string; id: string }): string => i.slug ?? i.id;

/** What no check can say when the read itself fell short: a closed collection, or a rate limit that stayed. */
function unfinished(r: WebflowReading, ctx: CheckContext): void {
  for (const u of r.unreadable)
    ctx.couldNotCheck?.(r.site, `${u.type}: Webflow would not give this collection (${u.reason})`);
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

const evidenceOf = (i: StagedRead): string =>
  i.state === "staged"
    ? `${i.type}: ${nameOf(i)} is saved and has never been published (last saved ${day(i.lastUpdated)})`
    : `${i.type}: ${nameOf(i)} was saved on ${day(i.lastUpdated)} after it was last published on ${day(i.lastPublished ?? i.lastUpdated)}`;

export const webflowItemStaged = defineCheck<WebflowReading>({
  id: "webflow-item-staged",
  size: "S",
  done: "Every item the client saved is published, or is a draft on purpose, and a run of Gaugeline lists none that is staged.",
  estimateChanges:
    "Publishing is one click in Webflow, but it publishes the whole site, so check what else is waiting before you do. Allow longer where the client has to approve the wording first.",
  area: "Launch day",
  severity: "medium",
  title: "Work saved in the Webflow CMS is not on the live site",
  what: "A collection item was saved as ready (not a draft) and has never been published, or it was changed after it was last published, so the live site still shows the old version or none.",
  why: "The client believes the change is out. Customers see the old price, the old opening hours, or no page for the event they were told about.",
  fix: "In Webflow, review the staged items and publish the site. If an item should not go out yet, set it back to draft so it is not mistaken for finished work.",
  tech: "GET /v2/collections/{id}/items (the staged list) for each collection: isDraft false, isArchived false, and lastPublished absent (staged) or more than 2 seconds earlier than lastUpdated (changed). Drafts and archived items are never reported. Ids, slugs and dates only: no field is used for this.",
  run(r, ctx) {
    unfinished(r, ctx);
    return r.staged.map((i): Finding => ({
      checkId: this.id,
      severity: this.severity,
      title: this.title,
      evidence: evidenceOf(i),
      url: i.url ?? r.site,
    }));
  },
});

export const webflowItemNoPage = defineCheck<WebflowReading>({
  id: "webflow-item-no-page",
  size: "M",
  done: "Every published item of the collections you named has a page that answers on the live site.",
  estimateChanges:
    "A page that is gone for every item of a collection is one template or one address pattern. A single item is a slug that was changed or a page the client switched off. A collection with no pages of its own always shows as could not check, which is expected.",
  area: "Launch day",
  severity: "high",
  title: "A published Webflow item has no page on the live site",
  what: "The CMS says an item is published, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page.",
  fix: "Check the collection's template page is published and its address matches the pattern in gaugeline.adapters.json, then publish the site. If the item should not be public, archive it in Webflow.",
  tech: "GET /v2/collections/{id}/items/live for each collection named in the `urls` settings, then one GET of the live address from the pattern (redirects followed). A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. A collection with published items and no pattern, and an item whose slug the pattern cannot use, are could-not-check by name and are not asked.",
  run(r, ctx) {
    unfinished(r, ctx);
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
        evidence: `${p.type}: ${nameOf(p)} is published in the CMS and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const WEBFLOW_CHECKS = [webflowItemStaged, webflowItemNoPage] as const;

/** The checks a Webflow read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createWebflowRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of WEBFLOW_CHECKS) registry.register(check);
  return registry;
}
