import { ruleName } from "../freshness/config.js";
import { show, within, numberFrom, parseTolerance } from "../freshness/decimal.js";
import { duration } from "../switches/text.js";
import {
  whyUnsure,
  NOT_SET_UP,
  inSeason,
  ms,
  nowOf,
  pagesOf,
  readingOf,
  whereRule,
} from "../freshness/rules.js";
import { readFigure } from "../freshness/page.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { cacheNote } from "../switches/text.js";
import { pathOf, safe } from "../switches/shared.js";

/** The last part of a page's address: the key a query's row is looked up by. */
function keyOf(url: string): string {
  const last = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export const dataBehindSource = defineCheck<PageSnapshot>({
  id: "data-behind-source",
  area: "Visitors",
  severity: "medium",
  title: "The page is behind the data it is built from",
  what: "The source (your database or CMS) has newer data than the page shows, or a figure on the page differs from the same figure in the source.",
  why: "The sync works but the visitor does not see it: a cache or a revalidation setting is serving an old copy, so fixing the sync would change nothing.",
  fix: "Look at how the page is rebuilt after the data changes: its revalidate time, an on-demand revalidation that the sync should call, or a CDN that keeps the old copy. The evidence shows the Age header when a cache served it.",
  tech: "for each rule with a source and maxLag in gaugeline.freshness.json, the newest time is read from the source (a one-row query or a Sanity field) and compared with the page's stamp: reported only when the page is older than the source by more than maxLag at every instant the stamp could mean; for each spot check (up to five per rule) the figure at the selector is compared with the source's figure for the page (a one-row query, or the row whose key column is the last part of the page's address) with exact decimal arithmetic and the tolerance given (an amount or a percentage of the source's figure); an unreadable source, stamp or figure is could not check; the evidence adds the Age and Cache-Control headers when a cache served the page",
  async run(page, ctx) {
    const fr = ctx.freshness;
    if (!fr) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const now = nowOf(ctx);
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const rule of fr.config.freshness) {
      if (!(rule.source && rule.stamp) && !rule.spot) continue;
      if (!inSeason(fr, ctx, page, rule, "whether the page is behind its source")) continue;
      const name = safe(ruleName(rule), 60);
      for (const here of await pagesOf(fr, ctx, page, rule)) {
        const where = pathOf(here.finalUrl, origin);
        const reading = await readingOf(fr, ctx, here, rule);
        const src = reading?.kind === "read" ? reading.source : undefined;
        if (reading?.kind === "read" && src) {
          if (src.kind === "unreadable")
            ctx.couldNotCheck?.(
              page.finalUrl,
              `${safe(src.source, 80)} could not be read, so how far behind it ${where} is was not checked (rule ${name}). ${src.reason}`,
            );
          else if (src.lag === "unsure")
            ctx.couldNotCheck?.(
              page.finalUrl,
              `The stamp "${safe(reading.raw, 60)}" on ${whereRule(here, rule)} does not say enough to tell whether it is more than ${duration(ms(rule.maxLag) / 1000)} behind ${safe(src.source, 80)}. ${whyUnsure(reading.moment)}`,
            );
          else if (src.lag === "behind")
            out.push({
              checkId: "data-behind-source",
              severity: "medium",
              title: this.title,
              evidence: `${where} is stamped "${safe(reading.raw, 60)}", ${reading.moment.kind === "exact" ? "" : "at least "}${duration(Math.floor(src.behindBy / 1000))} older than ${safe(src.source, 80)} (updated ${duration(Math.max(0, Math.floor((now - src.at) / 1000)))} ago); ${name} allows ${duration(ms(rule.maxLag) / 1000)}. The data is in the source, so the site is not picking it up: look at caching and revalidation.${cacheNote(here.hops.at(-1))}`,
              url: here.finalUrl,
            });
        }
        for (const spot of rule.spot ?? []) {
          const label = safe(spot.name ?? spot.selector, 60);
          const skipped = (why: string): void =>
            ctx.couldNotCheck?.(page.finalUrl, `${label} was not checked on ${where}${why}`);
          const shown = readFigure(here, spot);
          if (!shown.found) {
            skipped(`: nothing matches ${safe(spot.selector, 80)} (rule ${name}).`);
            continue;
          }
          const onPage = numberFrom(shown.raw);
          if (!onPage) {
            skipped(
              `: "${safe(shown.raw, 40)}" at ${safe(spot.selector, 80)} is not a plain number (rule ${name}).`,
            );
            continue;
          }
          const truth = await fr.sourceFigure(spot.source, keyOf(here.finalUrl));
          if (!truth.ok) {
            skipped(` (rule ${name}). ${truth.reason}`);
            continue;
          }
          const tolerance = parseTolerance(spot.tolerance ?? 0);
          if (!tolerance || within(onPage, truth.value, tolerance)) continue;
          const allowed =
            tolerance.kind === "percent" ? `${show(tolerance.amount)}%` : show(tolerance.amount);
          out.push({
            checkId: "data-behind-source",
            severity: "medium",
            title: this.title,
            evidence: `${label} on ${where} shows ${safe(shown.raw, 40)}, and ${safe(spot.source, 80)} has ${show(truth.value)} (${tolerance.kind === "abs" && tolerance.amount.units === 0n ? "they must be equal" : `allowed difference ${allowed}`}; ${name}).${cacheNote(here.hops.at(-1))}`,
            url: here.finalUrl,
          });
        }
      }
    }
    return out;
  },
});
