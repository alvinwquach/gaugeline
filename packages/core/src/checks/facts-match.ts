import { findFact } from "../facts/extract.js";
import {
  hoursDisagree,
  normaliseAmount,
  normaliseHandle,
  normalisePhone,
  parseHoursText,
  type Hours,
} from "../facts/normalise.js";
import type { Fact, Occurrence } from "../facts/types.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

/** Same, different, or unchecked (a value that doesn't parse is never guessed). */
export function compareFact(
  fact: Fact,
  raw: string,
  source: Occurrence["source"],
): "same" | "different" | "unchecked" {
  switch (fact.kind) {
    case "phone": {
      const a = normalisePhone(fact.value);
      const b = normalisePhone(raw);
      return a === undefined || b === undefined ? "unchecked" : a === b ? "same" : "different";
    }
    case "handle": {
      const a = normaliseHandle(fact.value);
      const b = normaliseHandle(raw);
      return a === undefined || b === undefined ? "unchecked" : a === b ? "same" : "different";
    }
    case "price": {
      const a = normaliseAmount(fact.value);
      const b = normaliseAmount(raw);
      return a === undefined || b === undefined ? "unchecked" : a === b ? "same" : "different";
    }
    case "hours": {
      const declared = parseHoursText(fact.value);
      let found: Hours;
      try {
        found = source === "structured data" ? (JSON.parse(raw) as Hours) : parseHoursText(raw);
      } catch {
        return "unchecked";
      }
      const shared = Object.keys(found).filter((d) => d in declared);
      // No day in common: nothing to compare, so unchecked rather than "same".
      if (shared.length === 0) return "unchecked";
      return hoursDisagree(declared, found).length > 0 ? "different" : "same";
    }
    case "text":
      return "same";
  }
}

export const factsMatch = defineCheck<PageSnapshot>({
  id: "facts-match",
  size: "S",
  done: "The fact reads the same on every page the evidence names.",
  estimateChanges:
    "The number of pages that repeat the fact. A fact stored once and rendered everywhere takes a template change instead.",
  area: "Sales & prices",
  severity: "high",
  title: "A fact about your business differs between pages",
  what: "A phone number, opening hours, payment handle or price you declared shows a different value somewhere on the site, in the text, a link or the structured data.",
  why: "Customers call the old number, turn up at the old time or send money to a mistyped handle. Search engines show whichever version they read.",
  fix: "Correct each place the evidence names. Better, render the fact from one source so the pages cannot drift.",
  tech: 'every occurrence (visible text by pattern or selector, links, JSON-LD; not image descriptions) equals the declared value in gaugeline.facts.json. "$5" = "$5.00", "5pm" = "5:00 PM", handle case ignored; a value that doesn\'t parse is unchecked',
  async run(page, ctx) {
    const facts = ctx.facts?.facts ?? [];
    if (facts.length === 0) return [];
    const pages = (await ctx.pages?.()) ?? [page];
    const out = [];
    for (const fact of facts) {
      const wrong: string[] = [];
      const right = new Set<string>();
      for (const p of pages) {
        for (const o of findFact(p, fact)) {
          if (o.source === "image description") continue;
          const verdict = compareFact(fact, o.raw, o.source);
          if (verdict === "unchecked")
            ctx.warn(
              `facts-match: could not read ${fact.id} "${o.raw}" on ${o.path} (${o.source}); unchecked.`,
            );
          else if (verdict === "different") wrong.push(`${o.path} has "${o.raw}" (${o.source})`);
          else right.add(o.path);
        }
      }
      if (wrong.length === 0) continue;
      out.push({
        checkId: "facts-match",
        severity: "high" as const,
        title: this.title,
        evidence: `${fact.id}: declared "${fact.value}"${right.size > 0 ? `, as on ${firstFew([...right])}` : ""}; ${firstFew([...new Set(wrong)])}`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
