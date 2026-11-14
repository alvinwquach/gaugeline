import { describePartial } from "../adapters/collect.js";
import type { DrupalReading } from "../adapters/drupal-read.js";
import { DRUPAL_LIMITS } from "../adapters/drupal.entry.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The check that needs Drupal's own answers: which nodes are not published and still open for a visitor at /node/ID. Pure
 * over a DrupalReading (ids, node numbers, addresses and statuses, never a title or a field), so the same site gives the
 * same findings. Everything in a reading came from a platform and a site: it is printed as text and never acted on.
 */

const PROBING_NOTE =
  "this check lists unpublished nodes with the credential you gave Gaugeline and asks the site for their pages as a visitor, so it runs only with --owner-consent (or gaugeline.consent.json) and a readUnpublished entry in gaugeline.adapters.json, and you should run it only on sites you own or have permission to test";

/** The reasons the read fell short, said once each; shared so a missing credential and a rate limit read the same everywhere. */
function stopped(r: DrupalReading, ctx: CheckContext): void {
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const drupalUnpublishedReachable = defineCheck<DrupalReading>({
  id: "drupal-unpublished-reachable",
  size: "S",
  done: "Every node you named that is not published answers a visitor with Drupal's own access denied.",
  estimateChanges:
    "A few minutes when one node is open: check who may view unpublished content under Permissions, and whether a module or a custom access rule opens the node. Allow an hour when a module such as a content access or caching layer serves unpublished nodes to everyone.",
  area: "Security & email",
  severity: "high",
  title: "A Drupal node that is not published can be opened by a visitor",
  what: "A node is saved in Drupal and not published, and its own page at /node/ID answers a visitor with a page instead of Drupal's access denied.",
  why: "Unpublished work is meant to be private: a staff change not announced yet, a price list for next year, a notice that was pulled. If a visitor can open it, so can anyone who guesses the number, and a search engine may already have it.",
  fix: "In Drupal open People, then Permissions, and check which roles can view unpublished content: Bypass content access control, or a permission from a contributed module such as View unpublished, especially for the Anonymous and Authenticated roles. Remove it from roles that should not have it, then clear the caches and check that a page cache or a CDN is not serving an old copy of the page.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; per type named in the settings that is a node type, GETs of /jsonapi/node/BUNDLE with filter[status]=0, sort=id, page[limit] and page[offset] (up to 50 a page, the offset stepping by the page size asked, the next link read for the paging it states and never requested, and it must stay on the host and the path asked) and a sparse fieldset of status, drupal_internal__nid and path, with the credential in an Authorization header and nowhere else, never followed to a redirect and never sent over plain http; Drupal core reports no total, so the list is checked for a repeated id, a first page that differs when read again at the end, and a count when the site reports one (meta.count); a node listed with a status that is not false is could-not-check; at most ${DRUPAL_LIMITS.unpublishedPerType} unpublished nodes are asked about per type (the rest are counted as not asked); then per node one GET of /node/NID on the Drupal address only, with no credential, no cookie and nothing the fetcher adds per address, redirects followed up to three times and only within the same host, at most ${DRUPAL_LIMITS.pages} pages a run; an answer counts only when Drupal sent it (an X-Generator: Drupal header, or a Drupal generator meta tag), and when the final path is the node's path or its alias; a 403 or 404 that is Drupal's own is the node closed to a visitor; a 2xx that is Drupal's own is looked at once more with the credential (GET of the resource by its id, status only) and is the finding only when the node is still unpublished (a node published in between is could-not-check); anything else, a firewall's 403, a login page, a redirect elsewhere, a type that is not a node type, a list the credential cannot read, and a credential whose list is empty (its role may not view unpublished content), is could-not-check for that part, never a pass; a finding is a type, a node number and a status, never a title or a field`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site || "Drupal",
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check whether a visitor can open an unpublished Drupal node.`,
      );
      return [];
    }
    if (!r.unpublishedAllowed) {
      ctx.couldNotCheck?.(
        r.site || "Drupal",
        'not asked: unpublished nodes are listed only when gaugeline.adapters.json says "readUnpublished": true for drupal.',
      );
      return [];
    }
    if (!r.hasCredential) {
      ctx.couldNotCheck?.(
        r.site || "Drupal",
        "not asked: listing unpublished nodes needs a credential (DRUPAL_TOKEN, or DRUPAL_USER and DRUPAL_PASSWORD) of a dedicated user whose role can view unpublished content. Published content needs none.",
      );
      return [];
    }
    if (r.nothingNamed) {
      ctx.couldNotCheck?.(
        r.site || "Drupal",
        'No type is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Gaugeline does not ask Drupal to list its resource types, so nothing was read.',
      );
      return [];
    }
    if (r.setup !== undefined) {
      ctx.couldNotCheck?.(r.site || "Drupal", `not read: ${r.setup}`);
      return [];
    }
    for (const t of r.types) {
      if (t.state === "unread")
        ctx.couldNotCheck?.(
          r.site,
          `${t.type}: Drupal would not give the unpublished nodes (${t.reason ?? "no reason given"})`,
        );
      else if (t.state === "unsupported")
        ctx.couldNotCheck?.(
          r.site,
          `${t.type}: not checked, ${t.reason ?? "it is not a node type"}.`,
        );
      else {
        if (t.nodes.length === 0)
          ctx.couldNotCheck?.(
            r.site,
            `${t.type}: the credential lists no unpublished node, so nothing was checked. There may be none, or the user's role may not be allowed to view unpublished content, and the two look the same.`,
          );
        if (t.more)
          ctx.couldNotCheck?.(
            r.site,
            `${t.type}: more unpublished nodes than a run asks about were listed, and the rest were not checked.`,
          );
      }
    }
    stopped(r, ctx);
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
      if (p.answer.kind !== "open") continue;
      if (p.recheck === "published") {
        ctx.couldNotCheck?.(
          p.url,
          `${p.type}: node ${p.nid} was published while the check ran, so its page being open is not a finding.`,
        );
        continue;
      }
      if (typeof p.recheck === "object") {
        ctx.couldNotCheck?.(
          p.url,
          `${p.type}: node ${p.nid} answered a visitor, and Drupal would not confirm it is unpublished (${p.recheck.unread}).`,
        );
        continue;
      }
      if (p.recheck !== "unpublished") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${p.type}: node ${p.nid} is not published in Drupal and ${p.path} answers a visitor ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const DRUPAL_CHECKS = [drupalUnpublishedReachable] as const;

/** The checks a Drupal read runs. They are not in the page registry: they read the CMS and the site, not one page. */
export function createDrupalRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of DRUPAL_CHECKS) registry.register(check);
  return registry;
}
