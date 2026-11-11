import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { navOf } from "./nav-shared.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const navParity = defineCheck<PageSnapshot>({
  id: "nav-parity",
  size: "S",
  done: "The mobile menu has every link the desktop menu has.",
  estimateChanges:
    "Two menus kept by hand are edited twice. One list feeding both needs a code change.",
  area: "Visitors",
  severity: "medium",
  title: "The mobile menu is missing links the desktop menu has",
  what: "The page has a separate mobile menu, and some destinations in the desktop header menu aren't in it.",
  why: "Most visitors are on a phone: a page missing from the mobile menu is missing for them.",
  fix: "Add the missing links to the mobile menu, or build both menus from one list.",
  tech: "The separate mobile menu's destinations (gaugeline.nav.json regions.mobile, or a [data-mobile-menu], #mobile-menu or .mobile-menu element) against the header's. A menu toggle whose menu isn't in the HTML is could not check: it is built at a phone width, which needs a rendered read (not on yet)",
  run(page, ctx) {
    const nav = navOf(page, ctx.navRules);
    if (!nav.mobile) {
      if (nav.mobileBuiltByScript)
        ctx.couldNotCheck?.(
          page.finalUrl,
          "the mobile menu is built by JavaScript when it opens, and rendered reads aren't on yet",
        );
      return [];
    }
    const mobile = new Set(nav.mobile);
    // The home page is left out: a logo links to it, and mobile menus usually don't repeat it.
    const home = new URL("/", page.finalUrl).href;
    const desktop = [
      ...new Set(
        nav.entries
          .filter((e) => e.region === "header" && e.destination !== home)
          .map((e) => e.destination),
      ),
    ];
    const missing = desktop.filter((d) => !mobile.has(d));
    if (missing.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    return [
      {
        checkId: "nav-parity",
        severity: "medium",
        title: this.title,
        evidence: `The mobile menu has no link to ${firstFew(missing.map((d) => shortUrl(d, origin)))}, which the desktop menu has`,
        url: page.finalUrl,
      },
    ];
  },
});
