import { jsonLdNodes, type PageSnapshot } from "../snapshot.js";
import { normalisePhone, parseDays, parseHoursText, parseTime, type Hours } from "./normalise.js";

/** The facts an assistant is most likely to quote about a business, as one source states them. */
export interface BusinessFacts {
  name?: string;
  /** As written, for evidence. */
  phoneText?: string;
  /** normalisePhone() of phoneText. */
  phone?: string;
  hours: Hours;
  /** As written, for evidence. */
  addressText?: string;
  /** The leading house number of the street address. */
  streetNumber?: string;
  /** A 5-digit ZIP code (other postcodes are not compared). */
  zip?: string;
}

const FACT_KEYS = ["telephone", "address", "openingHours", "openingHoursSpecification"];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function specHours(spec: unknown): Hours {
  const out: Hours = {};
  for (const s of Array.isArray(spec) ? spec : [spec]) {
    if (s === null || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const dayList = Array.isArray(o.dayOfWeek) ? o.dayOfWeek : [o.dayOfWeek];
    const days = dayList.flatMap((d) => (typeof d === "string" ? (parseDays(d) ?? []) : []));
    const opens = parseTime(String(o.opens ?? ""));
    const closes = parseTime(String(o.closes ?? ""));
    if (opens === undefined || closes === undefined) continue;
    // schema.org: opens and closes both 00:00 means closed all day.
    const range = opens === 0 && closes === 0 ? "closed" : `${hhmm(opens)}-${hhmm(closes)}`;
    for (const d of days) out[d] = range;
  }
  return out;
}

/** The leading number of a street address, and a 5-digit ZIP if one is written. */
export function addressParts(text: string): { streetNumber?: string; zip?: string } {
  const lead = /^\s*(\d+[A-Za-z]?)\b/.exec(text);
  const number = lead?.[1];
  // The last 5-digit group that is not the house number itself.
  const zips = [...text.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].filter(
    (m) => !lead || (m.index ?? 0) >= lead[0].length,
  );
  const zip = zips.at(-1)?.[1];
  return { ...(number ? { streetNumber: number.toUpperCase() } : {}), ...(zip ? { zip } : {}) };
}

/**
 * The first JSON-LD node that describes a business: any node with a telephone, an address or
 * opening hours (LocalBusiness and its many subtypes, or an Organization).
 */
export function businessFromJsonLd(page: Pick<PageSnapshot, "jsonLd">): BusinessFacts | undefined {
  const node = jsonLdNodes(page).find((n) => FACT_KEYS.some((k) => n[k] !== undefined));
  if (!node) return undefined;
  const facts: BusinessFacts = { hours: {} };
  const name = str(node.name);
  if (name) facts.name = name;
  const phoneText = str(node.telephone);
  const phone = phoneText ? normalisePhone(phoneText) : undefined;
  if (phoneText && phone) {
    facts.phoneText = phoneText;
    facts.phone = phone;
  }
  const hoursText = Array.isArray(node.openingHours)
    ? node.openingHours.filter((h): h is string => typeof h === "string").join("; ")
    : str(node.openingHours);
  facts.hours = {
    ...(hoursText ? parseHoursText(hoursText) : {}),
    ...specHours(node.openingHoursSpecification),
  };
  const address = node.address;
  if (typeof address === "string") {
    facts.addressText = address;
    Object.assign(facts, addressParts(address));
  } else if (address !== null && typeof address === "object") {
    const a = address as Record<string, unknown>;
    const street = str(a.streetAddress);
    const postal = str(a.postalCode);
    facts.addressText = [street, str(a.addressLocality), postal].filter(Boolean).join(", ");
    const number = street ? addressParts(street).streetNumber : undefined;
    if (number) facts.streetNumber = number;
    if (postal && /^\d{5}(?:-\d{4})?$/.test(postal)) facts.zip = postal.slice(0, 5);
  }
  return facts;
}
