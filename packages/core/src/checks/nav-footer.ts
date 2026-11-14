import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { navOf } from "./nav-shared.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const navFooter = defineCheck<PageSnapshot>({
  id: "nav-footer",
  size: "S",
  done: "Every page shows the same footer with every required link.",
  estimateChanges: "Templates that each carry their own footer are edited one by one.",
  area: "Visitors",
  severity: "medium",
  title: "The footer isn't the same on every page",
  what: "A page's footer links differ from the footer most of the pages read have, or a footer link gaugeline.nav.json marks as required (privacy, terms, contact) is missing.",
  why: "A footer that differs on one template usually means that template was missed in a change; a missing privacy or terms link can be a legal problem.",
  fix: "Use one footer for every template, and add any required link that is missing.",
  tech: "With --since last or a gaugeline.nav.json (it reads the run's other pages). Footer destinations on the checked page and the run's other pages (4); the most common set is the reference. Required links match a footer link's text or path, case-insensitively",
  async run(page, ctx) {
    // Reads the run's other pages (more requests): only when the run tracks its menu.
    if (!ctx.navRules && !ctx.baselineRequested) return [];
    const pages = (await ctx.pages?.()) ?? [page];
    const origin = new URL(page.finalUrl).origin;
    const footers = pages.map((p) => ({
      url: p.finalUrl,
      links: navOf(p, ctx.navRules).entries.filter((e) => e.region === "footer"),
    }));
    const out: Finding[] = [];
    const sets = footers
      .filter((f) => f.links.length > 0)
      .map((f) => ({
        url: f.url,
        dests: new Set(f.links.map((l) => l.destination)),
      }));
    const keyOf = (s: Set<string>) => [...s].sort().join(" ");
    const counts = new Map<string, number>();
    for (const s of sets) counts.set(keyOf(s.dests), (counts.get(keyOf(s.dests)) ?? 0) + 1);
    const [common, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (sets.length > 1 && n > 1) {
      const reference = new Set(common.split(" ").filter((s) => s !== ""));
      for (const s of sets) {
        if (keyOf(s.dests) === common) continue;
        const missing = [...reference].filter((d) => !s.dests.has(d));
        const extra = [...s.dests].filter((d) => !reference.has(d));
        out.push({
          checkId: "nav-footer",
          severity: "medium",
          title: this.title,
          evidence: `The footer on ${shortUrl(s.url, origin)} differs from ${n} other page${n === 1 ? "" : "s"}${missing.length ? `: no link to ${firstFew(missing.map((d) => shortUrl(d, origin)))}` : ""}${extra.length ? `${missing.length ? ";" : ":"} an extra link to ${firstFew(extra.map((d) => shortUrl(d, origin)))}` : ""}`,
          url: s.url,
        });
      }
    }
    const own = footers[0]?.links ?? [];
    for (const word of ctx.navRules?.requiredFooter ?? []) {
      const w = word.toLowerCase();
      const found = own.some(
        (l) =>
          l.text.toLowerCase().includes(w) ||
          new URL(l.destination).pathname.toLowerCase().includes(w),
      );
      if (!found)
        out.push({
          checkId: "nav-footer",
          severity: "medium",
          title: this.title,
          evidence: `The footer has no "${word}" link, which gaugeline.nav.json marks as required`,
          url: page.finalUrl,
        });
    }
    return out;
  },
});
