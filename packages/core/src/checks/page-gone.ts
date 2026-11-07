import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { comparePages } from "./page-shared.js";

export const pageGone = defineCheck<PageSnapshot>({
  id: "page-gone",
  area: "Visitors",
  severity: "high",
  title: "A page from the last run is gone",
  what: "An address the last run read (saved with --since last) now answers 404 or 410, or redirects to a different page; the evidence says where it now leads.",
  why: "Links from other sites, bookmarks and search results still point at the old address: a page that went missing loses them all, and one redirected to the wrong place loses them more slowly.",
  fix: "Put the page back, or redirect it with a 301 to the page that replaces it. A page removed on purpose goes under expectedChanges in gaugeline.pages.json.",
  tech: "With --since last only. Each saved address is taken from this run's pages when it was read anyway, else requested once with GET. A redirect that ends on the same path (a trailing slash, https) is not gone. A server error or refusal is could not check. On a first run: could not check",
  async run(page, ctx) {
    const list = await comparePages(page, ctx);
    if (!list) return [];
    return list.flatMap(({ key, url, now }): Finding[] => {
      if (now.kind === "unread") ctx.couldNotCheck?.(url, now.reason);
      if (now.kind !== "gone") return [];
      return [
        {
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: now.leadsTo
            ? `${key} redirects with ${now.status} to ${now.leadsTo} now; last run it was a page of its own`
            : `${key} answers ${now.status} now; last run it was a page`,
          url,
        },
      ];
    });
  },
});
