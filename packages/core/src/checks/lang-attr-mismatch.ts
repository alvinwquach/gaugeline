import { primaryLanguage } from "../languages.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const langAttrMismatch = defineCheck<PageSnapshot>({
  id: "lang-attr-mismatch",
  size: "S",
  done: "Each version's html lang matches the language of its content.",
  estimateChanges: "One layout component usually sets it for every version.",
  area: "Visitors",
  severity: "low",
  title: "A language version declares the wrong language",
  what: 'A version\'s <html lang> names a different language than the version is (for example the Spanish page still says lang="en").',
  why: "Screen readers read the page with the wrong voice and pronunciation, and browsers offer to translate it into its own language.",
  fix: "Set <html lang> per version from the page's language, usually in the layout component.",
  tech: "<html lang>'s primary subtag differs from the version's language (from hreflang or the configured scheme)",
  async run(page, ctx) {
    const group = await ctx.languages?.();
    if (!group) return [];
    const origin = new URL(page.finalUrl).origin;
    const checked = [
      ...(group.lang && page.htmlLang
        ? [{ lang: group.lang, url: page.finalUrl, htmlLang: page.htmlLang }]
        : []),
      ...group.versions.flatMap((v) =>
        v.page?.htmlLang ? [{ lang: v.lang, url: v.url, htmlLang: v.page.htmlLang }] : [],
      ),
    ];
    const wrong = checked.filter((c) => primaryLanguage(c.htmlLang) !== primaryLanguage(c.lang));
    if (wrong.length === 0) return [];
    return [
      {
        checkId: "lang-attr-mismatch",
        severity: "low",
        title: this.title,
        evidence: firstFew(
          wrong.map((w) => `${shortUrl(w.url, origin)} is ${w.lang} but has lang="${w.htmlLang}"`),
        ),
        url: page.finalUrl,
      },
    ];
  },
});
