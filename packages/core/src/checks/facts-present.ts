import { findFact } from "../facts/extract.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { compareFact } from "./facts-match.js";

export const factsPresent = defineCheck<PageSnapshot>({
  id: "facts-present",
  area: "Sales & prices",
  severity: "medium",
  title: "A page is missing a fact it should show",
  what: "A fact you declared must appear on a page (mustAppearOn) is not in that page's HTML as it is sent.",
  why: "The page visitors use to decide (the order page, the contact page) leaves out the thing they came for, or shows it only after JavaScript runs, which search engines and assistants may not.",
  fix: "Put the fact in the page's server-rendered HTML. A fact in an image's description only is not visible text: write it out.",
  tech: "for each mustAppearOn path among the pages checked, the fact's declared value is in the visible text, a link or JSON-LD of the HTML as sent (image descriptions don't count, and say so)",
  async run(page, ctx) {
    const facts = (ctx.facts?.facts ?? []).filter((f) => (f.mustAppearOn ?? []).length > 0);
    if (facts.length === 0) return [];
    const pages = (await ctx.pages?.()) ?? [page];
    const byPath = new Map(
      pages.map((p) => [new URL(p.finalUrl).pathname.replace(/(.)\/+$/, "$1"), p]),
    );
    const out = [];
    for (const fact of facts) {
      for (const want of fact.mustAppearOn ?? []) {
        const p = byPath.get(want.replace(/(.)\/+$/, "$1"));
        if (!p) {
          ctx.warn(
            `facts-present: ${want} is not among the pages checked, so ${fact.id} was not checked there.`,
          );
          continue;
        }
        const found = findFact(p, fact);
        const visible = found.filter(
          (o) => o.source !== "image description" && compareFact(fact, o.raw, o.source) === "same",
        );
        if (visible.length > 0) continue;
        const onlyAlt = found.some((o) => o.source === "image description");
        out.push({
          checkId: "facts-present",
          severity: "medium" as const,
          title: this.title,
          evidence: `${fact.id} ("${fact.value}") is not on ${want}${onlyAlt ? ": it is only in an image description" : ""}`,
          url: p.finalUrl,
        });
      }
    }
    return out;
  },
});
