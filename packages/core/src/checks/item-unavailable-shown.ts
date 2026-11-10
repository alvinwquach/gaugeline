import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import type { ItemName } from "../switches/types.js";
import { NOT_SET_UP, label, pathOf, safe, trimSlash, unreadable } from "../switches/shared.js";
import { cacheNote, findName, menuItemNames, sameName, visibleLines } from "../switches/text.js";

/** One item found on a page: the name as the page writes it, and the database's. */
function listed(found: string, item: ItemName): string {
  return found === item.name
    ? `"${safe(found, 60)}"`
    : `"${safe(found, 60)}" (the database has "${item.shown}")`;
}

function few(lines: string[]): string {
  return lines.length > 4
    ? `${lines.slice(0, 4).join(", ")} and ${lines.length - 4} more`
    : lines.join(", ");
}

export const itemUnavailableShown = defineCheck<PageSnapshot>({
  id: "item-unavailable-shown",
  area: "Sales & prices",
  severity: "high",
  title: "An item that is sold out or off the menu is still listed",
  what: "An item your database or CMS marks as unavailable (86'd, sold out, off the menu) is still on a page that lists items, or in the page's Menu structured data.",
  why: "Customers order or plan around something you cannot serve, and search results and assistants repeat it from the structured data long after the page is fixed.",
  fix: "Build the menu pages and the Menu structured data from the same list that holds the availability, so an item that is off cannot be rendered. If the evidence says a cache served the page, purge it.",
  tech: "for each availability rule in gaugeline.switches.json, the unavailable item names are read from the source (a Sanity list of names or one column of a query through the read-only database source) and looked for in the text of each mustNotAppearOn page, as sent without JavaScript and with hidden elements left out: an item is found when its words stand on their own in a row, ignoring case, accents and plural endings, at the start of a line or after punctuation (so Tamal is not found in Tamal de rajas); with alsoIn menu-jsonld the names of MenuItem nodes in the structured data of those pages and of the page checked are compared the same way; the evidence gives both spellings when they differ and adds the Age and Cache-Control headers when a cache served the page; an unreadable source or page is could not check (one that answers 404 lists nothing)",
  async run(page, ctx) {
    const read = await ctx.switches?.();
    if (!read || !ctx.statePages) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const a of read.availability) {
      if (a.state === "unknown") {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The list "${a.id}" is not known, so its items were not checked. ${a.reason}`,
        );
        continue;
      }
      if (a.items.length === 0) continue;
      const structured = new Map<string, PageSnapshot>();
      if (a.rule.alsoIn === "menu-jsonld")
        structured.set(trimSlash(new URL(page.finalUrl).pathname), page);
      for (const path of a.rule.mustNotAppearOn) {
        const got = await ctx.statePages.get(`${origin}${path}`);
        if (!got.ok) {
          unreadable(ctx, page.finalUrl, got, "silent");
          continue;
        }
        const here = got.page;
        const text = visibleLines(here);
        const lines = a.items.flatMap((item) =>
          findName(text, item.name).map((found) => listed(found, item)),
        );
        if (lines.length > 0)
          out.push({
            checkId: "item-unavailable-shown",
            severity: "high",
            title: this.title,
            evidence: `${label(a.rule)} marks ${lines.length === 1 ? "an item" : `${lines.length} items`} unavailable, but ${pathOf(here.finalUrl, origin)} still shows ${few(lines)}.${cacheNote(here.hops.at(-1))}`,
            url: here.finalUrl,
          });
        if (a.rule.alsoIn === "menu-jsonld")
          structured.set(trimSlash(new URL(here.finalUrl).pathname), here);
      }
      for (const here of structured.values()) {
        const names = menuItemNames(here);
        const lines = a.items.flatMap((item) =>
          names.filter((n) => sameName(n, item.name)).map((n) => listed(n, item)),
        );
        if (lines.length === 0) continue;
        out.push({
          checkId: "item-unavailable-shown",
          severity: "high",
          title: this.title,
          evidence: `${label(a.rule)} marks ${lines.length === 1 ? "an item" : `${lines.length} items`} unavailable, but the Menu structured data of ${pathOf(here.finalUrl, origin)} still has ${few(lines)}.${cacheNote(here.hops.at(-1))}`,
          url: here.finalUrl,
        });
      }
    }
    return out;
  },
});
