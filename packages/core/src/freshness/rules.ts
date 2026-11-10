import { isTimeZone } from "../ics/time.js";
import type { CheckContext } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { pagesInScope, pathOf, safe, trimSlash } from "../switches/shared.js";
import { isPattern, matchesPage, ruleName, type FreshnessRule } from "./config.js";
import { describeMonths, judgeAge, judgeLag, type AgeVerdict, type LagVerdict } from "./judge.js";
import { readStamp } from "./page.js";
import type { Freshness } from "./read.js";
import { isActive, parseDuration, parseMoment, type Moment } from "./time.js";

export const NOT_SET_UP =
  "gaugeline.freshness.json is not set up, so nothing was checked. See docs/guides/data-freshness.";

/** The run's clock, in ms. */
export function nowOf(ctx: CheckContext): number {
  return (ctx.now?.() ?? new Date()).getTime();
}

/** The site's own zone, when the file or the run's expectations name one. */
export function zoneOf(freshness: Freshness, ctx: CheckContext): string | undefined {
  const zone = freshness.config.timeZone ?? ctx.expect?.timeZone;
  return zone !== undefined && isTimeZone(zone) ? zone : undefined;
}

/** The number of ms a duration in the file means (the schema has already checked it reads). */
export function ms(text: string | undefined): number {
  return (text === undefined ? undefined : parseDuration(text)) ?? 0;
}

/**
 * Whether a rule is in force now. When it is not, says so as a could-not-check (once per check): the
 * report names the months and the check is not marked passed, because nothing was looked at.
 */
export function inSeason(
  freshness: Freshness,
  ctx: CheckContext,
  page: PageSnapshot,
  rule: FreshnessRule,
  whatWasNotChecked: string,
): boolean {
  const now = nowOf(ctx);
  const zone = zoneOf(freshness, ctx) ?? "UTC";
  if (isActive(rule.activeWhen, now, zone)) return true;
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: zone }).format(now);
  ctx.couldNotCheck?.(
    page.finalUrl,
    `The rule "${safe(ruleName(rule), 60)}" only applies in ${describeMonths(rule.activeWhen?.months ?? [])} (it is ${month} in ${zone}), so ${whatWasNotChecked} was not checked.`,
  );
  return false;
}

/**
 * The pages a rule is about. A pattern ("/players/*") is every page the run read that matches it
 * (the checked page and the few it links to, already fetched); a named page is read by the run
 * itself. A rule that has no page to look at is could not check, with the reason.
 */
export async function pagesOf(
  freshness: Freshness,
  ctx: CheckContext,
  page: PageSnapshot,
  rule: FreshnessRule,
): Promise<PageSnapshot[]> {
  if (isPattern(rule.page)) {
    const matching = (await pagesInScope(page, ctx)).filter((p) =>
      matchesPage(rule.page, new URL(p.finalUrl).pathname),
    );
    if (matching.length === 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `The rule "${safe(ruleName(rule), 60)}" was not checked: no page this run read matches "${safe(rule.page, 80)}". A run reads the page it was given and a few it links to; run Gaugeline on a page under it, or name one page in the rule.`,
      );
    return matching;
  }
  const origin = new URL(page.finalUrl).origin;
  const got = await ctx.statePages?.get(`${origin}${trimSlash(rule.page)}`);
  if (!got) return [];
  if (!got.ok) {
    ctx.couldNotCheck?.(page.finalUrl, got.message);
    return [];
  }
  return [got.page];
}

export const WITHOUT_ZONE =
  'The stamp has no time zone and gaugeline.freshness.json sets none, so it could be hours off. Add "timeZone": "America/New_York" (the site\'s own zone) to the file, or print the zone in the stamp.';

/** What a source's newest time says about a page. */
export type SourceReading =
  | { kind: "unreadable"; source: string; reason: string }
  | { kind: "read"; source: string; at: number; lag: LagVerdict; behindBy: number };

/** What a rule's stamp says about a page. */
export type StampReading =
  | { kind: "none" }
  | { kind: "unreadable"; from: string; reason: string }
  | {
      kind: "read";
      from: string;
      raw: string;
      moment: Moment;
      age: AgeVerdict;
      source?: SourceReading;
    };

/** Read a rule's stamp off a page, and judge it against maxAge and, when asked, the source. */
export async function readingOf(
  freshness: Freshness,
  ctx: CheckContext,
  page: PageSnapshot,
  rule: FreshnessRule,
): Promise<StampReading | undefined> {
  if (!rule.stamp) return undefined;
  const found = readStamp(page, rule.stamp);
  if (!found.found) return { kind: "none" };
  const now = nowOf(ctx);
  const zone = zoneOf(freshness, ctx);
  const parsed = parseMoment(found.raw, { now, ...(zone ? { timeZone: zone } : {}) });
  if (!parsed.ok) return { kind: "unreadable", from: found.from, reason: parsed.reason };
  const reading: StampReading = {
    kind: "read",
    from: found.from,
    raw: found.raw,
    moment: parsed.moment,
    age: judgeAge(parsed.moment, now, ms(rule.maxAge)),
  };
  if (rule.source) {
    const got = await freshness.sourceTime(rule.source, now);
    reading.source = got.ok
      ? {
          kind: "read",
          source: rule.source,
          at: got.at,
          lag: judgeLag(parsed.moment, got.at, ms(rule.maxLag)),
          behindBy: Math.max(0, got.at - parsed.moment.latest),
        }
      : { kind: "unreadable", source: rule.source, reason: got.reason };
  }
  return reading;
}

/** What to say when a stamp cannot decide a verdict: it has no zone, or it is a rough "3 hours ago". */
export function whyUnsure(moment: Moment): string {
  return moment.kind === "no-zone"
    ? WITHOUT_ZONE
    : moment.kind === "relative"
      ? "A stamp like this is only roughly how long ago, and the limit falls inside that rough span."
      : "The stamp is a date with no time, and the limit falls inside that day.";
}

/** "/players/jane-example (rule player-pages)" for a note, with an optional detail after the rule. */
export function whereRule(page: PageSnapshot, rule: FreshnessRule, detail?: string): string {
  const origin = new URL(page.finalUrl).origin;
  return `${pathOf(page.finalUrl, origin)} (rule ${safe(ruleName(rule), 60)}${detail ? `, ${detail}` : ""})`;
}
