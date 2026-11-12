import { describePartial } from "../adapters/collect.js";
import type { KontentReading } from "../adapters/kontent-ai-read.js";
import { CheckRegistry, defineCheck, type Finding } from "../model.js";

/**
 * The check that needs Kontent.ai's own answers: which items are not published (the Preview API lists them, the
 * Delivery API does not) and still have a page on the live site. Pure over a KontentReading (ids, types, slugs, workflow
 * steps, addresses and statuses, never an element or a name), so the same project gives the same findings. Everything in
 * a reading came from a platform and a site: it is printed as text and never acted on.
 */
const PROBING_NOTE =
  "this check asks the Kontent.ai Preview API for unpublished items with the Preview API key you gave Gaugeline, so it runs only with --owner-consent (or gaugeline.consent.json) and a readPreview entry in gaugeline.adapters.json, and you should run it only on sites you own or have permission to test";

export const kontentAiUnpublishedLive = defineCheck<KontentReading>({
  id: "kontent-ai-unpublished-live",
  size: "S",
  done: "Every Kontent.ai item that is not in the Published workflow step, in the types you gave an address for, has no page on the live site.",
  estimateChanges:
    "A few minutes when it is one page: remove it from the front end, or find the route that builds pages from the Preview API. Allow an hour when the front end reads the Preview API everywhere and needs the Delivery API for the live build.",
  area: "Security & email",
  severity: "high",
  title: "A Kontent.ai item that is not published has a live page",
  what: "An item is in Kontent.ai in a workflow step other than Published (a draft, in review, scheduled or archived) and has no published version, and the address its page should have answers on the live site.",
  why: "Unpublished work is meant to be private: a price not announced yet, a closure notice, a page that was pulled. If the live site builds pages from the Preview API, anyone who guesses or is sent the address can read it, and search engines can find it.",
  fix: "Make the live site read the Delivery API only: in the front end's data fetching use the Delivery API (with the secure access key if the project needs one) and keep the Preview API for a preview site behind a login. Then rebuild or revalidate the pages so the unpublished page is gone.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; run only on sites you own or have permission to test; one list of GETs of {environment id}/items on deliver.kontent.ai with the secure access key if there is one (Authorization: Bearer, never in the address), then the same list on preview-deliver.kontent.ai with the Preview API key (Authorization: Bearer, sent to that host only), each in pages of 100 ordered by system.codename with includeTotalCount, skip stepping by the number of items that came back, asking only the slug element, redirects not followed; a list that ends with another number of items than its total_count, repeats an item, echoes another skip or counts a page wrongly is could-not-check; the ids of the Delivery list are held in a Set and the Preview list is filtered against it; a Preview list that lacks an item the Delivery list has is not the Preview list and is could-not-check; an item in the Preview list only whose workflow step is published, or is not a plain codename, is most likely published a moment ago and is never reported (it is counted and named as could-not-check); when something is left the Delivery list is read once more and a list that changed in between is could-not-check; HTTP 401 or 403 from the Preview API is the Preview key refused, which says nothing about unpublished items, so it is could-not-check, never a pass; an unpublished item's address comes from the urls pattern for its type and its slug (an item with no pattern or no slug, or with the same slug as a published item of its type, is could-not-check for that item), then one GET of that page on the checked site's own host only, redirects followed, at most 40 pages a run (the rest are could-not-check); a final 2xx answer is the finding, 404 or 410 is a pass for that item, a page reached through a redirect to another path, and any other answer, is could-not-check for that page; the Delivery API lists the default language, so an item published only in another language is not seen; the finding shows the type, the item's slug or id, its workflow step, the path and the status, never an element`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check whether an unpublished Kontent.ai item has a live page.`,
      );
      return [];
    }
    if (!r.previewAllowed) {
      ctx.couldNotCheck?.(
        r.site,
        'not asked: the Preview API is read only when gaugeline.adapters.json says "readPreview": true for kontent-ai.',
      );
      return [];
    }
    if (r.nothingNamed) {
      ctx.couldNotCheck?.(
        r.site,
        'No type has an address in gaugeline.adapters.json (under "urls"), so there is no page to ask about and nothing was read.',
      );
      return [];
    }
    if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
    const read = r.read;
    if (read === undefined) return [];
    if (read.state === "refused") {
      ctx.couldNotCheck?.(
        r.site,
        `the Preview API was refused (${read.reason ?? "HTTP 401 or 403"}), so which items are not published cannot be told from here. To run this check give Gaugeline a Preview API key, on a site you own.`,
      );
      return [];
    }
    if (read.state === "unread") {
      ctx.couldNotCheck?.(
        r.site,
        `Kontent.ai would not give its items (${read.reason ?? "no reason given"}), so which are not published cannot be told from here.`,
      );
      return [];
    }
    if (read.unclear > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${read.unclear} ${read.unclear === 1 ? "item is" : "items are"} in the Preview list and not in the Delivery list with a workflow step that says published or cannot be read, most likely published a moment ago, so ${read.unclear === 1 ? "it was" : "they were"} not checked.`,
      );
    for (const w of read.withoutPattern)
      ctx.couldNotCheck?.(
        r.site,
        `${w.type}: ${w.count} unpublished ${w.count === 1 ? "item was" : "items were"} not asked about, because the settings give no address (urls) for this type.`,
      );
    if (read.unlisted > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${read.unlisted} unpublished ${read.unlisted === 1 ? "item was" : "items were"} not asked about, because a run asks about at most 40 and names only plain ids. The rest was not checked.`,
      );
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(
        r.site,
        `${u.type}: unpublished item ${u.id} was not checked, because ${u.reason}.`,
      );
    const out: Finding[] = [];
    for (const p of r.pages) {
      if (p.answer.kind === "unread") {
        ctx.couldNotCheck?.(p.url, `the page was not read (${p.answer.reason})`);
        continue;
      }
      if (p.answer.kind !== "page") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${p.type}: ${p.slug ?? p.id} is in the workflow step ${p.step} in Kontent.ai, not published, and ${p.path} answers ${p.answer.status} on the live site`,
        url: p.url,
      });
    }
    return out;
  },
});

export const KONTENT_AI_CHECKS = [kontentAiUnpublishedLive] as const;

/** The checks a Kontent.ai read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createKontentAiRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of KONTENT_AI_CHECKS) registry.register(check);
  return registry;
}
