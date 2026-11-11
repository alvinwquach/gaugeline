import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { phrasesFor, targetsFor } from "../switches/pages.js";
import { NOT_SET_UP, pathOf, safe, unreadable } from "../switches/shared.js";
import { cacheNote, says, visibleLines } from "../switches/text.js";

export const switchPageWrong = defineCheck<PageSnapshot>({
  id: "switch-page-wrong",
  size: "M",
  done: "The page shows the message from the same switch that turns the feature off.",
  estimateChanges:
    "A cache needs purging, and each page that reads the switch needs the same source.",
  area: "Sales & prices",
  severity: "medium",
  title: "A page does not say what it should for the current switch",
  what: 'You said what a page must tell visitors while a feature is on or off ("order at the bar" while pre-orders are off), and the page does not say it.',
  why: "A visitor who reaches the page learns nothing: no explanation, no other way to order. They are left guessing whether the site is broken.",
  fix: "Show the message from the same switch that turns the feature off, so the two cannot disagree. If the evidence says a cache served the page, purge it after the switch changes.",
  tech: "for each switch in gaugeline.switches.json, the page text for the current state (whenOff.pageSays while off, whenOn.pageSays while on) is read from the page as sent, without JavaScript, with hidden elements left out; the phrase is matched case-insensitively and ignoring accents, spacing and punctuation, in the page's own language when the phrase is given per language (a bilingual site's other-language pages are read through gaugeline.languages.json); a page that answers 404, a source or a page that cannot be read is could not check (the link checks report dead pages); the evidence adds the Age and Cache-Control headers when a cache served the page",
  async run(page, ctx) {
    const read = await ctx.switches?.();
    if (!read || !ctx.statePages) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const s of read.switches) {
      const wanted =
        s.state === "off"
          ? s.rule.whenOff?.pageSays
          : s.state === "on"
            ? s.rule.whenOn?.pageSays
            : undefined;
      if (s.state === "unknown") {
        if (s.rule.whenOff?.pageSays || s.rule.whenOn)
          ctx.couldNotCheck?.(
            page.finalUrl,
            `The switch "${s.id}" is not known, so what its pages say was not checked. ${s.reason}`,
          );
        continue;
      }
      for (const [path, phrase] of Object.entries(wanted ?? {})) {
        for (const target of targetsFor(path, phrase, origin, ctx.languageRules)) {
          const got = await ctx.statePages.get(target.url);
          if (!got.ok) {
            unreadable(ctx, page.finalUrl, got);
            continue;
          }
          const phrases = phrasesFor(target, got.page, ctx.languageRules);
          const text = visibleLines(got.page);
          if (phrases.some((p) => says(text, p))) continue;
          out.push({
            checkId: "switch-page-wrong",
            severity: "medium",
            title: this.title,
            evidence: `${s.id} is ${s.state} (${s.source}), and ${pathOf(got.page.finalUrl, origin)} does not say ${phrases.map((p) => `"${safe(p, 80)}"`).join(" or ")}.${cacheNote(got.page.hops.at(-1))}`,
            url: got.page.finalUrl,
          });
        }
      }
    }
    return out;
  },
});
