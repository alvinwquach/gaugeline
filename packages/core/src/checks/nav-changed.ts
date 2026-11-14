import { defineCheck, type Finding } from "../model.js";
import { diffNav, inboundLinks, type NavChange } from "../nav/graph.js";
import type { PageSnapshot } from "../snapshot.js";
import { navOf, where } from "./nav-shared.js";
import { shortUrl } from "./site-helpers.js";

const SEVERITY: Record<NavChange["kind"], Finding["severity"]> = {
  removed: "medium",
  moved: "medium",
  renamed: "low",
  added: "low",
  reordered: "low",
};

export const navChanged = defineCheck<PageSnapshot>({
  id: "nav-changed",
  size: "S",
  done: "Each menu change since the last run was meant, and a page that lost its link has another or a redirect.",
  estimateChanges: "The count of changes since the last run.",
  area: "Visitors",
  severity: "medium",
  title: "The menu changed since the last run",
  what: "Against the last run saved with --since last, links in the header or footer menu were added, removed, moved to another parent, renamed or reordered.",
  why: "A menu restructure changes many links at once and every page still loads, so nothing else reports the page that lost its only link.",
  fix: "Check each change was meant. A removed link whose page now has no other link needs one, or a redirect if the page is gone.",
  tech: "With --since last only. A link is its region, parent item and destination. Same destination under a new parent is moved; same identity with new text is renamed. A removed link whose destination has no inbound link from the pages read is high. On a first run (no saved menu yet): could not check",
  async run(page, ctx) {
    if (!ctx.previous?.nav) {
      // Without --since last there is nothing to compare, like the other change checks. With it,
      // a first run (or a snapshot saved before menus were) is could not check, never a pass.
      if (ctx.baselineRequested)
        ctx.couldNotCheck?.(
          page.finalUrl,
          ctx.previous
            ? "the last run's snapshot has no saved menu: this run saves one"
            : "no saved menu to compare with yet: this run saves one",
        );
      return [];
    }
    const now = navOf(page, ctx.navRules);
    const changes = diffNav(ctx.previous.nav, now.entries);
    if (changes.length === 0) return [];
    const pages = (await ctx.pages?.()) ?? [page];
    const inbound = inboundLinks(pages.map((p) => navOf(p, ctx.navRules)));
    const origin = new URL(page.finalUrl).origin;
    return changes.map((c): Finding => {
      const path = shortUrl(c.destination, origin);
      const orphaned = c.kind === "removed" && (inbound.get(c.destination)?.size ?? 0) === 0;
      const evidence =
        c.kind === "moved"
          ? `Moved: ${where(c.region, "", c.text)} (${path}) from ${c.from} to ${c.to}`
          : c.kind === "renamed"
            ? `Renamed: ${where(c.region, c.parent, `"${c.from ?? ""}" to "${c.text}"`)} (${path})`
            : c.kind === "reordered"
              ? `Reordered: ${where(c.region, c.parent, c.text)} (${path}) from position ${c.from} to ${c.to}`
              : `${c.kind === "added" ? "Added" : "Removed"}: ${where(c.region, c.parent, c.text)} (${path})${orphaned ? `; no page read links to ${path} now` : ""}`;
      return {
        checkId: "nav-changed",
        severity: orphaned ? "high" : SEVERITY[c.kind],
        title: this.title,
        evidence,
        url: page.finalUrl,
      };
    });
  },
});
