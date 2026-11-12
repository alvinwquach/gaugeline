import { describePartial } from "../adapters/collect.js";
import type { HygraphReading } from "../adapters/hygraph-read.js";
import { CheckRegistry, defineCheck, type Finding } from "../model.js";

/**
 * The check that needs Hygraph's own answers: which entries are not published (they are in the DRAFT stage and not
 * in the PUBLISHED stage) and still have a page on the live site. Pure over a HygraphReading (ids, slugs, addresses
 * and statuses, never a field or a name), so the same project gives the same findings. Everything in a reading came
 * from a platform and a site: it is printed as text and never acted on.
 */
const PROBING_NOTE =
  "this check asks Hygraph for the DRAFT stage with the token you gave Gaugeline, so it runs only with --owner-consent (or gaugeline.consent.json) and a readDraftStage entry in gaugeline.adapters.json, and you should run it only on sites you own or have permission to test";

export const hygraphDraftLive = defineCheck<HygraphReading>({
  id: "hygraph-draft-live",
  size: "S",
  done: "Every Hygraph entry that is not published, in the models you named, has no page on the live site.",
  estimateChanges:
    "A few minutes when it is one page: unpublish or remove it in the front end, or find the route that builds pages from the DRAFT stage. Allow an hour when the front end reads the DRAFT stage everywhere and needs a PUBLISHED-only token for the live build.",
  area: "Security & email",
  severity: "high",
  title: "A Hygraph entry that is not published has a live page",
  what: "An entry is saved in Hygraph and never published (it is in the DRAFT stage and not in the PUBLISHED stage), and the address its page should have answers on the live site.",
  why: "Unpublished work is meant to be private: a price not announced yet, a closure notice, a page that was pulled. If the live site builds pages from the DRAFT stage, anyone who guesses or is sent the address can read it, and search engines can find it.",
  fix: "Make the live site read the PUBLISHED stage only: in the front end's data fetching use stage PUBLISHED (or a permanent auth token whose default stage is PUBLISHED), and keep DRAFT for a preview site behind a login. Then rebuild or revalidate the pages so the unpublished page is gone.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; run only on sites you own or have permission to test; per model named under collections, POSTs of one GraphQL query each, through fetcher.query and the registered allowlist entry hygraph-content-api or hygraph-content-cdn (a document that parses as one query is the only body ever sent, to the host and path in HYGRAPH_ENDPOINT only): the PUBLISHED list asking for id only, then the DRAFT list asking for id and the slug field only, each first 100, an explicit orderBy: id_ASC, skip stepping by the number of entries that came back, a page shorter than the page asked for ending the list, and the first page also asking the model's count through aggregate (a list that ends with another number of entries is could-not-check, and a count over 5000 fails on the first page); the ids of the PUBLISHED list are held in a Set and the DRAFT list is filtered against it, and when something is left the PUBLISHED list is read once more and a list that changed in between is could-not-check; HTTP 401 or 403, or a GraphQL error, on the first DRAFT page after the PUBLISHED page was answered is read as the DRAFT stage refused or errored (the narrowest key, as recommended, is refused it), which says nothing about unpublished entries, so it is could-not-check, never a pass; a DRAFT list that lacks a published entry (the DRAFT stage holds every published entry) is could-not-check for that model, because it is not the DRAFT stage; each unpublished entry's address comes from the urls pattern for its type and its slug (an entry with no pattern or no slug, or with the same slug as a published entry, is could-not-check for that entry), then one GET of that page on the checked site's own host only, redirects followed, at most 40 pages a run (the rest are could-not-check, and so are the unpublished entries beyond 40 a model); a final 2xx answer is the finding, 404 or 410 is a pass for that entry, a page reached through a redirect to another path, and any other answer, is could-not-check for that page; the finding shows the model, the entry's slug or id, the path and the status, never a field`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check whether an unpublished Hygraph entry has a live page.`,
      );
      return [];
    }
    if (!r.draftStageAllowed) {
      ctx.couldNotCheck?.(
        r.site,
        'not asked: the DRAFT stage is read only when gaugeline.adapters.json says "readDraftStage": true for hygraph.',
      );
      return [];
    }
    if (r.nothingNamed) {
      ctx.couldNotCheck?.(
        r.site,
        'No model is named in gaugeline.adapters.json (under "collections"), and Gaugeline does not ask Hygraph to list its models, so nothing was read.',
      );
      return [];
    }
    for (const m of r.models) {
      if (m.state === "unread")
        ctx.couldNotCheck?.(
          r.site,
          `${m.type}: Hygraph would not give this model (${m.reason ?? "no reason given"})`,
        );
      else if (m.state === "refused")
        ctx.couldNotCheck?.(
          r.site,
          `${m.type}: the DRAFT stage was refused or errored (HTTP 401 or 403, or a GraphQL error), so which entries are not published cannot be told from here. A token limited to PUBLISHED is the narrowest key and is expected to be refused; to run this check give Gaugeline a token that may read DRAFT, on a site you own.`,
        );
    }
    if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(
        r.site,
        `${u.type}: unpublished entry ${u.id} was not checked, because ${u.reason}.`,
      );
    for (const u of r.unlisted)
      ctx.couldNotCheck?.(
        r.site,
        `${u.type}: ${u.count} unpublished ${u.count === 1 ? "entry was" : "entries were"} not asked about, because a run lists at most 40 unpublished entries for a model and names only plain ids. The rest of that model was not checked.`,
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
      if (p.answer.kind !== "page") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${p.type}: ${p.slug ?? p.id} is not published in Hygraph and ${p.path} answers ${p.answer.status} on the live site`,
        url: p.url,
      });
    }
    return out;
  },
});

export const HYGRAPH_CHECKS = [hygraphDraftLive] as const;

/** The checks a Hygraph read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createHygraphRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of HYGRAPH_CHECKS) registry.register(check);
  return registry;
}
