import { defineCheck, type Finding } from "../model.js";
import { discoverRoutes, displayPath, withoutQuery } from "../delivery/routes.js";
import { askRoute } from "../delivery/probe.js";
import { LIMITS } from "../limits.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

/** Why a run without consent did not ask. Reads after "could not be checked:". */
export const NO_CONSENT_REASON =
  "this check asks download routes for their file with no login, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const gatedDownloadOpen = defineCheck<PageSnapshot>({
  id: "gated-download-open",
  size: "L",
  done: "A request with no session to the download route gets 401 or 403, and a paying customer gets a short-lived link.",
  estimateChanges:
    "Several download routes, no purchase record to check, or files in public folders mean building the check and moving files.",
  area: "Sales & prices",
  severity: "high",
  title: "A download meant for customers is handed to anyone",
  what: "A download route returns its file to a request with no session and no purchase.",
  why: "A route that protects a paid file should refuse, or send the visitor to sign in. If it returns the file, everyone who has the address gets it for free, and the address is easy to find in the page, in a search engine or in a customer's email.",
  fix: "Check the purchase inside the route before it answers, then hand back a short-lived signed link instead of the file itself. A route with no session should answer 401, 403 or a redirect to sign in.",
  tech: "probing check, off without --owner-consent: one anonymous GET per route (no cookie, no Authorization, no Referer, no compression), the status and headers, then at most 1,024 bytes of the body and the connection is closed; the route is a same-site link whose path contains download, file, deliver or export or sits under /api/, or a route file given with --routes (app/**/route.ts, pages/api/**) whose path says the same; a dynamic segment is asked only for an address seen in a link and ids are never guessed; at most 10 routes, in sorted order, the rest named; a finding is status 200 with a file content type or Content-Disposition attachment and first bytes that are not HTML (%PDF, PK, ID3 and a few other signatures are read); 401, 403, 404, a redirect to a sign-in address and a 200 HTML page pass; a redirect elsewhere is followed one hop; the body and the query string are never stored, logged or printed",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_CONSENT_REASON);
      return [];
    }
    const fetcher = ctx.fetcher;
    if (!fetcher) return [];
    const found = discoverRoutes(page, ctx.routeFiles ?? []);
    const asked = ctx.budget
      ? ctx.budget.take("downloadRoutes", found.found)
      : found.found.slice(0, LIMITS.downloadRoutes);
    const origin = new URL(page.finalUrl).origin;
    const at = (path: string) => new URL(path, origin).href;
    for (const n of found.notProbed) {
      ctx.couldNotCheck?.(
        at(n.path),
        n.reason === "signed"
          ? "not asked: the link carries its own signature and expiry, so it is a signed link, not a gate"
          : "not asked: no link on the page gives an address for this dynamic route, and Gaugeline never guesses ids",
      );
    }
    for (const address of found.found.slice(asked.length)) {
      ctx.couldNotCheck?.(
        address,
        `not asked: more than ${LIMITS.downloadRoutes} download routes were found, and only the first ${LIMITS.downloadRoutes} in sorted order are asked`,
      );
    }
    const outcomes = await Promise.all(asked.map((address) => askRoute(fetcher, address)));
    const findings: Finding[] = [];
    asked.forEach((address, i) => {
      const outcome = outcomes[i];
      if (!outcome) return;
      if (outcome.kind === "unclear") {
        ctx.couldNotCheck?.(withoutQuery(address), outcome.reason);
        return;
      }
      if (outcome.kind !== "open") return;
      const path = escapeInvisible(displayPath(address), 120);
      const type = escapeInvisible(outcome.contentType, 80);
      const via = outcome.via;
      const evidence = via
        ? `${path} -> ${via.status}, then ${outcome.status} ${type} from ${escapeInvisible(via.host, 80)}. Asked with no session and no purchase, the route sent the visitor to the file${via.signed ? ": the signed link was issued without a purchase check" : ""}.`
        : `${path} -> ${outcome.status} ${type}. Asked with no session and no purchase, the route handed over the file.`;
      findings.push({
        checkId: "gated-download-open",
        severity: "high",
        title: this.title,
        evidence,
        url: withoutQuery(address),
      });
    });
    return findings;
  },
});
