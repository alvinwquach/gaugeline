import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { phrasesFor, targetsFor } from "../switches/pages.js";
import { NOT_SET_UP, label, pathOf, safe, unreadable } from "../switches/shared.js";
import { cacheNote, says, visibleLines } from "../switches/text.js";

export const capacityZeroNotSoldOut = defineCheck<PageSnapshot>({
  id: "capacity-zero-not-sold-out",
  size: "M",
  done: "When the count reaches zero the page shows the sold-out message and no order button, in the visible page and in its structured data.",
  estimateChanges:
    "A cache or a static build between the count and the page adds work. Two systems that each keep a count need one chosen as the source.",
  area: "Sales & prices",
  severity: "high",
  title: "Nothing is left, but the page still looks open for orders",
  what: "Your remaining capacity (dishes for tonight, seats, tickets) is zero, and the order page does not say it is sold out.",
  why: "Customers keep ordering or paying for something you cannot make. Each one is a refund, an apology and a bad review.",
  fix: "Show the sold-out message from the same number that counts what is left, and remove the order button when it reaches zero. If the evidence says a cache served the page, purge it after the count changes.",
  tech: "for each capacity rule in gaugeline.switches.json, the remaining count is read from its source (a published Sanity field or a one-row query through the read-only database source); when it is zero or below, each whenZero.pageSays page must say its phrase (case-insensitive, accents and spacing ignored, per language where given) in the page as sent without JavaScript; the evidence says whether the page still has a form; a page that answers 404, a source or a page that cannot be read is could not check (the link checks report dead pages); the evidence adds the Age and Cache-Control headers when a cache served the page",
  async run(page, ctx) {
    const read = await ctx.switches?.();
    if (!read || !ctx.statePages) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const c of read.capacity) {
      if (c.state === "unknown") {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The capacity "${c.id}" is not known, so its pages were not checked. ${c.reason}`,
        );
        continue;
      }
      if (c.remaining > 0) continue;
      for (const [path, phrase] of Object.entries(c.rule.whenZero.pageSays)) {
        for (const target of targetsFor(path, phrase, origin, ctx.languageRules)) {
          const got = await ctx.statePages.get(target.url);
          if (!got.ok) {
            unreadable(ctx, page.finalUrl, got);
            continue;
          }
          const phrases = phrasesFor(target, got.page, ctx.languageRules);
          const text = visibleLines(got.page);
          if (phrases.some((p) => says(text, p))) continue;
          const forms = got.page.forms.length;
          out.push({
            checkId: "capacity-zero-not-sold-out",
            severity: "high",
            title: this.title,
            evidence: `${label(c.rule)} has ${c.remaining} left, and ${pathOf(got.page.finalUrl, origin)} does not say ${phrases.map((p) => `"${safe(p, 80)}"`).join(" or ")}${forms > 0 ? `; it still has ${forms === 1 ? "an order form" : `${forms} forms`}` : ""}.${cacheNote(got.page.hops.at(-1))}`,
            url: got.page.finalUrl,
          });
        }
      }
    }
    return out;
  },
});
