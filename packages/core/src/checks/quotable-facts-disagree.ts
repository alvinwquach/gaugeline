import { businessFromJsonLd } from "../facts/business.js";
import { llmsFacts } from "../llms.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

/** Case, accents, punctuation and a leading "The" do not make a different name. */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/^the /, "")
      .trim();
  const x = n(a);
  const y = n(b);
  if (x === "" || y === "") return true;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/**
 * Until X23's facts model lands, this compares the structured data with llms.txt only (as the
 * spec says). Phone, address and hours disagreements there are llms-txt-stale-facts' finding, so
 * one wrong number is reported once; this check reports the business name. X23 adds page text.
 */
export const quotableFactsDisagree = defineCheck<PageSnapshot>({
  id: "quotable-facts-disagree",
  size: "S",
  done: "The business name in the LocalBusiness data matches the first heading of llms.txt.",
  estimateChanges: "A name kept in several places is one edit each.",
  area: "Search & sharing",
  severity: "high",
  title: "Assistants find two different names for your business",
  what: "The business name in the page's structured data and the title of /llms.txt are not the same name.",
  why: "Assistants match a question to a business by name. Two names can make them treat one business as two, or quote the wrong one.",
  fix: "Use the same business name in the LocalBusiness structured data and as the first heading of llms.txt.",
  tech: 'LocalBusiness JSON-LD name and the llms.txt H1 disagree (case, punctuation and a leading "The" ignored)',
  async run(_page, ctx) {
    const site = await ctx.site?.();
    const file = site?.llms.file;
    const ld = businessFromJsonLd(_page);
    if (!site || !file || !ld?.name) return [];
    const name = llmsFacts(file).name;
    if (!name || sameName(name, ld.name)) return [];
    return [
      {
        checkId: "quotable-facts-disagree",
        severity: "high",
        title: this.title,
        evidence: `structured data says "${ld.name}"; llms.txt is titled "${name}"`,
        url: site.llms.url,
      },
    ];
  },
});
