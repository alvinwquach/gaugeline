import { asSent, observedEvents } from "../events/observe.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { shortUrl } from "./site-helpers.js";

export const eventsDistinct = defineCheck<PageSnapshot>({
  id: "events-distinct",
  area: "Leads",
  severity: "low",
  title: "Two menu links report the same click",
  what: "Two links to the same page, under different parent menus, send identical event values, so the report can't tell which one was clicked.",
  why: "A comparison of a new menu is only real if every link reports where it sits: identical values merge the two links into one row.",
  fix: "Add the parent menu (or another value that tells them apart) to the event both links send.",
  tech: "Links that passed events-fire, grouped by destination: two with different parent menus whose events carry the same values for the plan's parameters. Needs a rendered read (G39): until then it is could not check",
  async run(page, ctx) {
    if (!ctx.events) return [];
    const read = await ctx.events();
    if ("unchecked" in read.result) {
      ctx.couldNotCheck?.(page.finalUrl, read.result.unchecked);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    // destination -> the first link seen under each parent, with the values it sent.
    const groups = new Map<string, Map<string, { text: string; values: string; sent: string }>>();
    const findings = [];
    for (const { target, rule, verdict } of observedEvents(read)) {
      if (verdict.state !== "ok" || !target.destination || !target.parent) continue;
      const values = JSON.stringify(rule.params.map((p) => verdict.sent[p]));
      const byParent = groups.get(target.destination) ?? new Map();
      groups.set(target.destination, byParent);
      const twin = [...byParent.entries()].find(
        ([parent, v]) => parent !== target.parent && v.values === values,
      );
      if (twin)
        findings.push({
          checkId: "events-distinct",
          severity: "low" as const,
          title: this.title,
          evidence: `${shortUrl(target.destination, origin)} under "${twin[0]}" and under "${target.parent}" both send ${twin[1].sent}`,
          url: page.finalUrl,
        });
      if (!byParent.has(target.parent))
        byParent.set(target.parent, { text: target.text, values, sent: asSent(verdict.sent) });
    }
    return findings;
  },
});
