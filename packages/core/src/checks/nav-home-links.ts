import { defineCheck } from "../model.js";
import { jsonLdNodes, type PageSnapshot } from "../snapshot.js";
import { collectNav, contentIndex, navKey, normaliseLabel } from "./content/parse.js";
import { firstFew } from "./site-helpers.js";

const HOME = new Set(["home", "homepage", "home page", "start", "back to home"]);

/** Names the site goes by: og:site_name, a WebSite or Organization name, the title's first part. */
function siteNames(page: PageSnapshot): Set<string> {
  const names = new Set<string>();
  if (page.og["og:site_name"]) names.add(normaliseLabel(page.og["og:site_name"]));
  for (const n of jsonLdNodes(page)) {
    const t = n["@type"];
    const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
    if (
      types.some((x) => /WebSite|Organization|LocalBusiness|Store|Restaurant/.test(x)) &&
      typeof n.name === "string"
    )
      names.add(normaliseLabel(n.name));
  }
  const first = page.title?.split(/\s+[|·–—-]\s+/)[0];
  if (first) names.add(normaliseLabel(first));
  return names;
}

export const navHomeLinks = defineCheck<PageSnapshot>({
  id: "nav-home-links",
  area: "Visitors",
  severity: "medium",
  title: "Menu items go to the homepage",
  what: "Links in the menu or header point at the homepage but are labelled as something else, such as Services or Contact.",
  why: "Visitors who click Services land back on the homepage and think the page is missing. It usually means a menu item was added with no link.",
  fix: "Point each menu item at its own page, or remove it until the page exists.",
  tech: "a nav or header a[href] resolving to / whose text (or aria-label) is not Home or the site's name",
  run(page) {
    const index = contentIndex(page);
    const home = navKey(new URL("/", page.finalUrl).href);
    const names = siteNames(page);
    const bad = index.links.filter((l) => {
      if ((l.region !== "nav" && l.region !== "header") || l.name === "" || navKey(l.href) !== home)
        return false;
      const label = normaliseLabel(l.name);
      return !HOME.has(label) && !names.has(label);
    });
    const labels = [...new Set(bad.map((l) => `"${l.name}"`))];
    if (labels.length === 0 || !collectNav(index).has(home)) return [];
    return [
      {
        checkId: "nav-home-links",
        severity: "medium",
        title: this.title,
        evidence: `${labels.length} menu ${labels.length === 1 ? "item goes" : "items go"} to /: ${firstFew(labels)}`,
        url: page.finalUrl,
      },
    ];
  },
});
