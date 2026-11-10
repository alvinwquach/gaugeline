import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { cacheNote, linksTo } from "../switches/text.js";
import {
  NOT_SET_UP,
  pagesInScope,
  pathOf,
  safe,
  trimSlash,
  unreadable,
} from "../switches/shared.js";

export const switchOffStillLinked = defineCheck<PageSnapshot>({
  id: "switch-off-still-linked",
  area: "Sales & prices",
  severity: "high",
  title: "A switch is off but the site still links to what it controls",
  what: "You turned a feature off (pre-orders, online ordering, bookings), and a page still has a link to the page that feature runs on.",
  why: "Visitors click the link, land on a page that no longer works or takes orders you cannot fill, and call or leave. A cached or hard-coded link is the usual cause: the menu and the header were built before the switch was flipped.",
  fix: "Make every link to the controlled page depend on the same switch (in Sanity or the database), or remove the link. If the evidence says the answer came from a cache, purge the cache after the switch changes.",
  tech: "for each switch in gaugeline.switches.json whose state is off, the checked page, the other pages the run read and every page named in the file are searched for same-site links whose path is a whenOff.noLinksTo path or sits under it (/order covers /order/checkout, not /order-history); the state comes from its source (a published Sanity field or a one-row query through the read-only database source); a source that cannot be read, or gives a value that is not on or off, is could not check, and so is a page that cannot be read (one that answers 404 has no links); the evidence adds the Age and Cache-Control headers when a cache served the page",
  async run(page, ctx) {
    const read = await ctx.switches?.();
    if (!read || !ctx.statePages) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const rules = read.switches.filter((s) => (s.rule.whenOff?.noLinksTo ?? []).length > 0);
    for (const s of rules)
      if (s.state === "unknown")
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The switch "${s.id}" is not known, so its links were not checked. ${s.reason}`,
        );
    const off = rules.filter((s) => s.state === "off");
    if (off.length === 0) return [];

    const origin = new URL(page.finalUrl).origin;
    const scope = await pagesInScope(page, ctx);
    const seen = new Set(scope.map((p) => trimSlash(new URL(p.finalUrl).pathname)));
    for (const path of read.paths) {
      if (seen.has(trimSlash(path))) continue;
      const got = await ctx.statePages.get(`${origin}${path}`);
      if (got.ok) {
        seen.add(trimSlash(path));
        scope.push(got.page);
      } else unreadable(ctx, page.finalUrl, got, "silent");
    }

    const out: Finding[] = [];
    for (const s of off) {
      const targets = s.rule.whenOff?.noLinksTo ?? [];
      for (const p of scope) {
        const here = trimSlash(new URL(p.finalUrl).pathname);
        // The controlled page may link to itself.
        if (targets.some((t) => here === trimSlash(t) || here.startsWith(`${trimSlash(t)}/`)))
          continue;
        const links = targets.flatMap((t) => linksTo(p, t));
        if (links.length === 0) continue;
        // One entry per path, with the words of its first links: "/order ("Order now", "Pre-order")".
        const byPath = new Map<string, string[]>();
        for (const l of links) {
          const words = byPath.get(l.path) ?? [];
          if (l.text && !words.includes(l.text)) words.push(l.text);
          byPath.set(l.path, words);
        }
        const shown = [...byPath].map(
          ([path, words]) =>
            `${safe(path, 80)}${
              words.length > 0
                ? ` (${words
                    .slice(0, 2)
                    .map((w) => `"${safe(w, 40)}"`)
                    .join(", ")})`
                : ""
            }`,
        );
        out.push({
          checkId: "switch-off-still-linked",
          severity: "high",
          title: this.title,
          evidence: `${s.id} is off (${s.source}), but ${pathOf(p.finalUrl, origin)} still links to ${shown.slice(0, 3).join(", ")}${shown.length > 3 ? ` and ${shown.length - 3} more` : ""}.${cacheNote(p.hops.at(-1))}`,
          url: p.finalUrl,
        });
      }
    }
    return out;
  },
});
