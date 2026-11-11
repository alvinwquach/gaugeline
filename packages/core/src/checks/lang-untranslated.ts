import { contentIndex } from "./content/parse.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const langUntranslated = defineCheck<PageSnapshot>({
  id: "lang-untranslated",
  size: "M",
  done: "The strings that were left in the other language are translated.",
  estimateChanges:
    "Strings hard-coded in shared components are found and moved to the translations, then translated by someone who knows the language.",
  area: "Visitors",
  severity: "low",
  title: "Some text wasn't translated",
  what: "Strings you listed as default-language text (button labels, headings) appear on another language version.",
  why: 'A Spanish page with an English "Add to cart" button looks unfinished, and some visitors won\'t know what it does.',
  fix: "Translate the strings in the components that render them; they are usually hard-coded in a shared button or heading.",
  tech: "a string from untranslated in gaugeline.languages.json appears in another version's main text or link names (case ignored); needs the list",
  async run(page, ctx) {
    const strings = ctx.languageRules?.untranslated ?? [];
    if (strings.length === 0) return [];
    const group = await ctx.languages?.();
    const origin = new URL(page.finalUrl).origin;
    const hits: string[] = [];
    for (const v of group?.versions ?? []) {
      if (!v.page) continue;
      const index = contentIndex(v.page);
      const text = `${index.mainText} ${index.links.map((l) => l.name).join(" ")}`.toLowerCase();
      for (const s of strings)
        if (text.includes(s.toLowerCase()))
          hits.push(`"${s}" on ${shortUrl(v.url, origin)} (${v.lang})`);
    }
    if (hits.length === 0) return [];
    return [
      {
        checkId: "lang-untranslated",
        severity: "low",
        title: this.title,
        evidence: `${hits.length} untranslated: ${firstFew(hits)}`,
        url: page.finalUrl,
      },
    ];
  },
});
