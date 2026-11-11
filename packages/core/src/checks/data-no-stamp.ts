import { NOT_SET_UP, inSeason, pagesOf, readingOf } from "../freshness/rules.js";
import { ruleName } from "../freshness/config.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { pathOf, safe } from "../switches/shared.js";

export const dataNoStamp = defineCheck<PageSnapshot>({
  id: "data-no-stamp",
  size: "S",
  done: "The page prints when its numbers were last updated, from the same record.",
  estimateChanges: "Several pages with changing numbers each need the stamp.",
  area: "Visitors",
  severity: "low",
  title: "A page of changing numbers does not say when they were updated",
  what: "A page under one of your freshness rules shows no update time at all, in the place you named or in its structured data.",
  why: "Without a stamp nobody can tell fresh numbers from stale ones, and neither can Gaugeline: a sync can stop and the page gives no sign.",
  fix: "Print the time the data was last updated on the page, from the same record the numbers come from (a time element with a datetime attribute, or dateModified in the structured data), then point the rule at it.",
  tech: "for each rule with a stamp in gaugeline.freshness.json that is active (in the months of activeWhen, in the site's time zone), the page as sent without JavaScript has no element matching the selector with a datetime, content, named attribute or text, and no property of that name in its structured data; a stamp that is there but cannot be read is not reported here (data-stale lists it as could not check); a rule that is not active is listed as could not check, not passed",
  async run(page, ctx) {
    const fr = ctx.freshness;
    if (!fr) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const out: Finding[] = [];
    for (const rule of fr.config.freshness) {
      if (!rule.stamp) continue;
      if (!inSeason(fr, ctx, page, rule, "whether the page has a stamp")) continue;
      for (const here of await pagesOf(fr, ctx, page, rule)) {
        const reading = await readingOf(fr, ctx, here, rule);
        if (reading?.kind !== "none") continue;
        const looked = [
          rule.stamp.selector !== undefined
            ? `nothing matches ${safe(rule.stamp.selector, 80)}`
            : undefined,
          rule.stamp.jsonld !== undefined
            ? `the page has no ${safe(rule.stamp.jsonld, 60)} in its structured data`
            : undefined,
        ].filter((s): s is string => s !== undefined);
        out.push({
          checkId: "data-no-stamp",
          severity: "low",
          title: this.title,
          evidence: `${pathOf(here.finalUrl, new URL(page.finalUrl).origin)} shows no stamp (${safe(ruleName(rule), 60)}): ${looked.join(", and ")}.`,
          url: here.finalUrl,
        });
      }
    }
    return out;
  },
});
