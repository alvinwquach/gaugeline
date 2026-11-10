import { passedBy } from "../freshness/judge.js";
import {
  NOT_SET_UP,
  inSeason,
  ms,
  nowOf,
  pagesOf,
  readingOf,
  whereRule,
  whyUnsure,
} from "../freshness/rules.js";
import { ruleName } from "../freshness/config.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { pathOf, safe } from "../switches/shared.js";
import { cacheNote, duration } from "../switches/text.js";

export const dataStale = defineCheck<PageSnapshot>({
  id: "data-stale",
  area: "Visitors",
  severity: "high",
  title: "The numbers on this page are older than they should be",
  what: "The page says when its data was last updated, and that time is older than the limit you set for it while the data is expected to move.",
  why: "A sync that stopped fails quietly: the page keeps showing last week's numbers, and nobody notices until a visitor or a customer does.",
  fix: "Find out why the sync stopped (the evidence says whether the source is just as old), or why the page is not rebuilt after it runs. Then check the stamp itself is generated from the data, not typed or built once.",
  tech: "for each rule with a stamp in gaugeline.freshness.json, the stamp is read from the page as sent, without JavaScript (the selector's datetime, content or named attribute, else its text; else the structured data property) in the stamp's own time zone, else the file's timeZone; it is older than maxAge only when it is older at every instant the stamp could mean (a date alone is a whole day, a time with no zone and no timeZone could be any zone, 3 hours ago is a span of an hour); the rule is checked only in the months of activeWhen, in the site's time zone, and a rule that is not active is listed as could not check, not passed; when the rule also has a source and the page is behind it by more than maxLag, data-behind-source reports that cause instead, so each cause has one finding; a stamp that cannot be read or is undecided is could not check; the evidence adds the Age and Cache-Control headers when a cache served the page",
  async run(page, ctx) {
    const fr = ctx.freshness;
    if (!fr) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const now = nowOf(ctx);
    const out: Finding[] = [];
    for (const rule of fr.config.freshness) {
      if (!rule.stamp) continue;
      if (!inSeason(fr, ctx, page, rule, "how old the stamp is")) continue;
      for (const here of await pagesOf(fr, ctx, page, rule)) {
        const reading = await readingOf(fr, ctx, here, rule);
        if (!reading || reading.kind === "none") continue;
        if (reading.kind === "unreadable") {
          ctx.couldNotCheck?.(
            page.finalUrl,
            `The stamp on ${whereRule(here, rule, safe(reading.from, 80))} was not understood: ${reading.reason}.`,
          );
          continue;
        }
        if (reading.age === "fresh") continue;
        if (reading.age === "unsure") {
          ctx.couldNotCheck?.(
            page.finalUrl,
            `The stamp "${safe(reading.raw, 60)}" on ${whereRule(here, rule)} could not be judged against ${duration(ms(rule.maxAge) / 1000)}. ${whyUnsure(reading.moment)}`,
          );
          continue;
        }
        const src = reading.source;
        // A page behind a source that has moved on is a revalidation problem: data-behind-source's finding.
        if (src?.kind === "read" && src.lag === "behind") continue;
        let cause = "";
        if (src?.kind === "read" && src.lag === "level")
          cause = ` ${src.source} was last updated ${duration(Math.max(0, Math.floor((now - src.at) / 1000)))} ago and the page is within ${duration(ms(rule.maxLag) / 1000)} of it, so the sync looks stopped, not the site.`;
        else if (src?.kind === "read")
          cause = " Whether the sync stopped could not be told from this stamp.";
        else if (src?.kind === "unreadable")
          cause = ` ${src.source} could not be read, so whether the sync stopped is not known.`;
        out.push({
          checkId: "data-stale",
          severity: "high",
          title: this.title,
          evidence: `${pathOf(here.finalUrl, new URL(page.finalUrl).origin)} is stamped "${safe(reading.raw, 60)}" (${passedBy(reading.moment, now)} ago), and ${safe(ruleName(rule), 60)} allows ${duration(ms(rule.maxAge) / 1000)}.${cause}${cacheNote(here.hops.at(-1))}`,
          url: here.finalUrl,
        });
      }
    }
    return out;
  },
});
