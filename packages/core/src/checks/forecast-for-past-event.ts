import { ruleName } from "../freshness/config.js";
import { readForecasts } from "../freshness/page.js";
import { NOT_SET_UP, inSeason, ms, nowOf, pagesOf, zoneOf } from "../freshness/rules.js";
import { parseMoment } from "../freshness/time.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { pathOf, safe } from "../switches/shared.js";
import { cacheNote } from "../switches/text.js";

/** How long a game with a start time is taken to last when the rule does not say. */
const DEFAULT_LASTS = "3h";
const SHOWN = 3;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export const forecastForPastEvent = defineCheck<PageSnapshot>({
  id: "forecast-for-past-event",
  size: "S",
  done: "Items for events that already happened are gone from the list, or show their result.",
  estimateChanges:
    "A list built by hand is edited by hand. One built from the schedule fixes itself but needs code, and a cache needs purging.",
  area: "Visitors",
  severity: "medium",
  title: "The page still shows a prediction for something that already happened",
  what: "A page lists a prediction, a pick or a preview whose event date is already past, and it does not show the result.",
  why: "A prediction for a finished game or a past night looks careless at best, and misleads at worst: visitors act on it and the page loses their trust the next time.",
  fix: "Remove the item or switch it to the result when the event ends. Generate the list from the schedule so an event leaves it by itself, and rebuild or revalidate the page after the result is in.",
  tech: "for each rule with a forecast in gaugeline.freshness.json that is active, each item matching forecast.item (up to 200 per page) has its date read from forecast.date inside it, its own datetime or named attribute, or a time element with a datetime inside it, or the page's Event structured data with the property named in forecast.jsonld; the event is past when it is past at every instant the date could mean (a date alone is over when the whole day is, in the site's time zone; a time is over after forecast.lasts, 3h by default); an item that contains forecast.settled already shows its result and is skipped; no items, a date that cannot be read or an item with no date is could not check; the evidence adds the Age and Cache-Control headers when a cache served the page",
  async run(page, ctx) {
    const fr = ctx.freshness;
    if (!fr) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const now = nowOf(ctx);
    const zone = zoneOf(fr, ctx);
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const rule of fr.config.freshness) {
      const forecast = rule.forecast;
      if (!forecast) continue;
      if (!inSeason(fr, ctx, page, rule, "whether predictions are for past events")) continue;
      const name = safe(ruleName(rule), 60);
      const lasts = ms(forecast.lasts ?? DEFAULT_LASTS);
      for (const here of await pagesOf(fr, ctx, page, rule)) {
        const where = pathOf(here.finalUrl, origin);
        const items = readForecasts(here, forecast);
        if (items.length === 0) {
          ctx.couldNotCheck?.(
            page.finalUrl,
            `No predictions were found on ${where} (${name}): ${forecast.item !== undefined ? `nothing matches ${safe(forecast.item, 80)}` : `the page has no Event with a ${safe(forecast.jsonld ?? "", 60)} in its structured data`}.`,
          );
          continue;
        }
        const past: string[] = [];
        let undated = 0;
        let unreadable: string | undefined;
        let unreadableCount = 0;
        for (const item of items) {
          if (item.settled) continue;
          if (item.raw === undefined) {
            undated += 1;
            continue;
          }
          const got = parseMoment(item.raw, { now, ...(zone ? { timeZone: zone } : {}) });
          if (!got.ok) {
            unreadableCount += 1;
            unreadable ??= got.reason;
            continue;
          }
          const m = got.moment;
          const over = m.latest + (m.kind === "exact" || m.kind === "no-zone" ? lasts : 0) < now;
          if (over) past.push(`"${item.label}" (${safe(item.raw, 40)})`);
        }
        if (undated > 0)
          ctx.couldNotCheck?.(
            page.finalUrl,
            `${plural(undated, "prediction")} on ${where} has no date, so ${undated === 1 ? "it was" : "they were"} not checked (${name}).`,
          );
        if (unreadable !== undefined)
          ctx.couldNotCheck?.(
            page.finalUrl,
            `${plural(unreadableCount, "prediction")} on ${where} has a date that was not understood: ${unreadable} (${name}).`,
          );
        if (past.length === 0) continue;
        const shown = past.slice(0, SHOWN).join(", ");
        const more = past.length > SHOWN ? ` and ${past.length - SHOWN} more` : "";
        out.push({
          checkId: "forecast-for-past-event",
          severity: "medium",
          title: this.title,
          evidence: `${where} lists ${plural(past.length, "prediction")} whose event is already over (${name}): ${shown}${more}.${cacheNote(here.hops.at(-1))}`,
          url: here.finalUrl,
        });
      }
    }
    return out;
  },
});
