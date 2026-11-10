import { businessFromJsonLd } from "../facts/business.js";
import { visibleText } from "../facts/extract.js";
import { DAYS, normalisePhone, parseDays, parseTime, type Day } from "../facts/normalise.js";
import type { FactsConfig } from "../facts/types.js";
import { localDate } from "../ics/time.js";
import { jsonLdNodes, type PageSnapshot } from "../snapshot.js";
import { closuresInText, type Closure } from "./closures.js";
import { addInterval, intervalFrom, parseListedHours, type DayHours } from "./hours.js";
import { datesBetween } from "./sources/json.js";
import { hostOf } from "./match.js";

/** A fact about the business as the site states it, and where that came from. */
export interface Stated<T> {
  value: T;
  /** "gaugeline.facts.json" or "the page's structured data": for the evidence. */
  from: string;
}

export interface SiteFacts {
  /** The site's host without "www.". */
  host: string;
  name?: Stated<string>;
  phone?: Stated<string>;
  address?: Stated<string>;
  hours?: Stated<DayHours>;
  /** Dates the site says it is closed, with the page each came from. */
  closures: (Closure & { page: string })[];
}

const FACTS_FILE = "gaugeline.facts.json";
const STRUCTURED = "the page's structured data";

function declared(facts: FactsConfig | undefined, kind: string, ids: string[] = []) {
  return facts?.facts.find((f) => f.kind === kind && (ids.length === 0 || ids.includes(f.id)));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Hours from a LocalBusiness node, as intervals: openingHours text and plain openingHoursSpecification. */
function jsonLdHours(node: Record<string, unknown>): DayHours {
  const out: DayHours = {};
  const text = Array.isArray(node.openingHours)
    ? node.openingHours.filter((h): h is string => typeof h === "string").join("; ")
    : str(node.openingHours);
  if (text) Object.assign(out, parseListedHours(text));
  for (const spec of [node.openingHoursSpecification].flat()) {
    if (spec === null || typeof spec !== "object") continue;
    const s = spec as Record<string, unknown>;
    // A specification with dates is an exception to the week, handled as a closure or ignored.
    if (s.validFrom !== undefined || s.validThrough !== undefined) continue;
    const days = [s.dayOfWeek]
      .flat()
      .flatMap((d) => (typeof d === "string" ? (parseDays(d) ?? []) : []));
    const opens = parseTime(String(s.opens ?? ""));
    const closes = parseTime(String(s.closes ?? ""));
    if (opens === undefined || closes === undefined) continue;
    for (const d of days as Day[]) {
      // schema.org: opens and closes both 00:00 is closed all day.
      if (opens === 0 && closes === 0) out[d] = [];
      else addInterval(out, d, intervalFrom(opens, closes));
    }
  }
  return out;
}

/** Closures in structured data: a specification with dates whose opens and closes are both 00:00. */
function jsonLdClosures(node: Record<string, unknown>): Closure[] {
  const out: Closure[] = [];
  for (const spec of [node.openingHoursSpecification].flat()) {
    if (spec === null || typeof spec !== "object") continue;
    const s = spec as Record<string, unknown>;
    const from = str(s.validFrom)?.slice(0, 10);
    const through = str(s.validThrough)?.slice(0, 10) ?? from;
    if (!from || !through) continue;
    if (parseTime(String(s.opens ?? "")) !== 0 || parseTime(String(s.closes ?? "")) !== 0) continue;
    for (const date of datesBetween(from, through, 14)) out.push({ date, label: date });
  }
  return out;
}

/**
 * What the site says about itself, for the listings to be compared with. The business's declared
 * facts (gaugeline.facts.json, X23) come first; the LocalBusiness structured data of the pages read
 * fills in what was not declared. A name or address is declared as a text fact with the id "name"
 * or "address". Closures come from the structured data and from the words on the pages.
 */
export function readSiteFacts(
  pages: readonly PageSnapshot[],
  facts: FactsConfig | undefined,
  today: string,
): SiteFacts {
  const first = pages[0];
  const out: SiteFacts = { host: hostOf(first?.finalUrl ?? "") ?? "", closures: [] };
  const ld = pages
    .map((p) => ({ page: p, business: businessFromJsonLd(p) }))
    .find((x) => x.business);
  const node = ld
    ? jsonLdNodes(ld.page).find((n) =>
        ["telephone", "address", "openingHours", "openingHoursSpecification"].some(
          (k) => n[k] !== undefined,
        ),
      )
    : undefined;

  const name = declared(facts, "text", ["name", "business-name"]);
  if (name) out.name = { value: name.value, from: FACTS_FILE };
  else if (ld?.business?.name) out.name = { value: ld.business.name, from: STRUCTURED };

  const phone = declared(facts, "phone");
  if (phone) out.phone = { value: phone.value, from: FACTS_FILE };
  else if (ld?.business?.phoneText) out.phone = { value: ld.business.phoneText, from: STRUCTURED };
  if (out.phone && normalisePhone(out.phone.value) === undefined) delete out.phone;

  const address = declared(facts, "text", ["address"]);
  if (address) out.address = { value: address.value, from: FACTS_FILE };
  else if (ld?.business?.addressText)
    out.address = { value: ld.business.addressText, from: STRUCTURED };

  const hours = declared(facts, "hours");
  if (hours) {
    const parsed = parseListedHours(hours.value);
    if (Object.keys(parsed).length > 0) out.hours = { value: parsed, from: FACTS_FILE };
  }
  if (!out.hours && node) {
    const parsed = jsonLdHours(node);
    if (DAYS.some((d) => parsed[d] !== undefined)) out.hours = { value: parsed, from: STRUCTURED };
  }

  const seen = new Set<string>();
  const add = (c: Closure, page: string): void => {
    if (c.date >= today && !seen.has(c.date)) {
      seen.add(c.date);
      out.closures.push({ ...c, page });
    }
  };
  for (const p of pages) {
    const path = new URL(p.finalUrl).pathname;
    for (const n of jsonLdNodes(p)) for (const c of jsonLdClosures(n)) add(c, path);
    for (const c of closuresInText(visibleText(p), today)) add(c, path);
  }
  out.closures.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

/** Today's date in the venue's zone (UTC when none is known). */
export function todayIn(now: Date, zone: string | undefined): string {
  return localDate(now.getTime(), zone ?? "UTC");
}
