import { defineCheck } from "../model.js";
import {
  describeAddress,
  draftMarker,
  endsAtLogin,
  isHeadlessWordPress,
  previewLinks,
} from "../headless-wordpress/detect.js";
import { NO_CONSENT_PREVIEW, ask } from "../headless-wordpress/read.js";
import type { PageSnapshot } from "../snapshot.js";

export const headlessWpPreviewOpen = defineCheck<PageSnapshot>({
  id: "headless-wp-preview-open",
  size: "S",
  done: "A preview address answers a visitor who is not logged in with the login page, not the draft.",
  estimateChanges:
    "The preview route needs an authenticated check on the server; a front end that checks only in the browser (Faust's default) needs the data request authenticated too.",
  area: "Launch day",
  severity: "high",
  title: "A preview link shows an unpublished page without a login",
  what: "A preview address this headless WordPress site links to answers a visitor who is not logged in with a page that looks like an unpublished draft, not a login page.",
  why: "Anyone with the address sees posts, prices or announcements nobody approved yet, as if they were live.",
  fix: "Serve previews only to a logged-in editor: check the session on the server before the draft is fetched or rendered, and redirect everyone else to the login page. In Faust.js, keep the draft query behind the authenticated client.",
  tech: "Probing check: off unless --owner-consent or gaugeline.consent.json; run only on sites you own or have permission to test. Headless WordPress sites only. One GET, with no cookie or secret, of each preview address the checked page itself links to on its own origin (a query with preview=true, preview_id or previewId; at most 3). A finding needs an answer of 200 HTML that is not a login address or form and carries a draft marker: a status of draft, auto-draft, pending, private or future in its embedded data, isPreview set, or a draft title. An answer with no marker is could not check, because an unpublished page cannot be told from a published one without a marker. Only the path and the query parameter names are shown, never their values. Faust.js checks the login in the browser and fetches the draft with an authenticated client (read from the @faustwp/core source, 4.1.1: preview=true, previewPathname and p); the markers other than that are conventions (uncited)",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || !isHeadlessWordPress(page)) return [];
    const links = previewLinks(page);
    if (links.length === 0) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_CONSENT_PREVIEW);
      return [];
    }
    const out = [];
    for (const url of ctx.budget.take("draftRoutes", links)) {
      const a = await ask(ctx, url);
      if ("none" in a) {
        ctx.couldNotCheck?.(url, `the preview address could not be read: ${a.none}`);
        continue;
      }
      const last = a.hops.at(-1);
      if (!last || endsAtLogin(a.hops)) continue;
      if (last.status < 200 || last.status >= 300) continue;
      const type = (last.headers["content-type"] ?? "").toLowerCase();
      if (!type.includes("html")) continue;
      if (last.truncated === true) {
        ctx.couldNotCheck?.(url, "the preview page was cut before it could be read in full");
        continue;
      }
      const marker = draftMarker(last.body ?? "");
      if (marker === undefined) {
        ctx.couldNotCheck?.(
          url,
          "the preview address answered with a page and no sign of whether it is a draft",
        );
        continue;
      }
      out.push({
        checkId: "headless-wp-preview-open",
        severity: "high" as const,
        title: this.title,
        evidence: `${describeAddress(url)} answered 200 with no login and ${marker}`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
