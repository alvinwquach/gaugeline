import { connectorGet } from "../../connectors/http.js";
import { isConfigured } from "../../connectors/env.js";
import type { Connector } from "../../connectors/types.js";
import type { Day } from "../../facts/normalise.js";
import { DAYS } from "../../facts/normalise.js";
import { addInterval, type DayHours } from "../hours.js";
import type { Listing, ListingStatus, SpecialDay } from "../types.js";
import { datesBetween, jsonBody, list, num, plainUrl, rec, text, ymd } from "./json.js";

export const GOOGLE_BUSINESS_TOKEN = "GOOGLE_BUSINESS_PROFILE_TOKEN";
export const GOOGLE_PLACES_KEY = "GOOGLE_PLACES_API_KEY";

const WEEK = 7 * 1440;
const NAMED_DAYS: Record<string, Day> = {
  MONDAY: "mon",
  TUESDAY: "tue",
  WEDNESDAY: "wed",
  THURSDAY: "thu",
  FRIDAY: "fri",
  SATURDAY: "sat",
  SUNDAY: "sun",
};

/**
 * One period of a week: where it opens and closes, as a day and a clock time. The end is counted
 * from the opening day, so a close on the next day is past midnight on this one.
 */
function addPeriod(
  hours: DayHours,
  open: { day: Day; minutes: number },
  close: { day: Day; minutes: number },
): void {
  const from = DAYS.indexOf(open.day);
  const to = DAYS.indexOf(close.day);
  let length = ((to - from + 7) % 7) * 1440 + close.minutes - open.minutes;
  if (length <= 0) length += WEEK;
  addInterval(hours, open.day, [open.minutes, open.minutes + length]);
}

/** Proto3 JSON leaves out zero fields, so {"hours": 11} is 11:00 and {} is midnight. */
function clockOf(v: unknown, hourKey: string, minuteKey: string): number {
  const r = rec(v);
  return (num(r?.[hourKey]) ?? 0) * 60 + (num(r?.[minuteKey]) ?? 0);
}

function statusOf(open: string | undefined, verified: boolean): ListingStatus {
  if (open === "CLOSED_PERMANENTLY") return "closed-permanently";
  if (open === "CLOSED_TEMPORARILY") return "closed-temporarily";
  return verified ? "open" : "unverified";
}

/**
 * A Business Information API location as a listing. Reads only: title, phone, address, website,
 * weekly and special hours, open status and whether the owner is verified.
 */
export function listingFromBusinessProfile(body: unknown): Listing {
  const loc = rec(body);
  if (!loc)
    throw new Error("Google Business Profile answered with something that is not a location.");
  const hours: DayHours = {};
  const periods = list(rec(loc.regularHours)?.periods);
  for (const p of periods) {
    const o = rec(p);
    const openDay = NAMED_DAYS[String(o?.openDay)];
    const closeDay = NAMED_DAYS[String(o?.closeDay)];
    if (!o || !openDay || !closeDay) continue;
    addPeriod(
      hours,
      { day: openDay, minutes: clockOf(o.openTime, "hours", "minutes") },
      { day: closeDay, minutes: clockOf(o.closeTime, "hours", "minutes") },
    );
  }
  const specialDays: SpecialDay[] = [];
  const special = rec(loc.specialHours);
  for (const p of list(special?.specialHourPeriods)) {
    const r = rec(p);
    const s = rec(r?.startDate);
    if (!r || !s) continue;
    const first = ymd(num(s.year) ?? 0, num(s.month) ?? 0, num(s.day) ?? 0);
    const e = rec(r.endDate);
    const last = e ? ymd(num(e.year) ?? 0, num(e.month) ?? 0, num(e.day) ?? 0) : first;
    for (const date of datesBetween(first, last))
      specialDays.push({ date, closed: r.closed === true });
  }
  const a = rec(loc.storefrontAddress);
  const address = a
    ? [
        ...list(a.addressLines).filter((l): l is string => typeof l === "string"),
        text(a.locality),
        [text(a.administrativeArea), text(a.postalCode)].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const verified = rec(loc.metadata)?.hasVoiceOfMerchant !== false;
  const phone = text(rec(loc.phoneNumbers)?.primaryPhone);
  const name = text(loc.title);
  const website = text(loc.websiteUri);
  const url = plainUrl(rec(loc.metadata)?.mapsUri);
  return {
    source: "google-business",
    label: "Google Business Profile",
    ...(url ? { url } : {}),
    status: statusOf(text(rec(loc.openInfo)?.status), verified),
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(website ? { website } : {}),
    ...(periods.length > 0 ? { hours } : {}),
    ...(special ? { specialDays } : {}),
  };
}

/**
 * Google Business Profile through the Business Information API, with the owner's OAuth access
 * token. One GET of one location. Google offers no read-only scope for this API, so the token is
 * the owner's business.manage token: Gaugeline sends it to Google in an Authorization header on
 * a GET, never anywhere else, and never prints it. `location` is "locations/<id>".
 */
export function googleBusinessConnector(location: string): Connector<Listing> {
  const envVars = [GOOGLE_BUSINESS_TOKEN];
  return {
    id: "google-business",
    envVars,
    configured: (env) => isConfigured(env, envVars),
    async read(env, fetcher) {
      const mask =
        "title,phoneNumbers,storefrontAddress,websiteUri,regularHours,specialHours,openInfo,metadata";
      const hop = await connectorGet(
        fetcher,
        `https://mybusinessbusinessinformation.googleapis.com/v1/${location}?readMask=${encodeURIComponent(mask)}`,
        { authorization: `Bearer ${env[GOOGLE_BUSINESS_TOKEN] ?? ""}` },
      );
      return [listingFromBusinessProfile(jsonBody(hop, "Google Business Profile"))];
    },
  };
}

const PLACE_DAYS: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A Places API (New) place as a listing: the public fields only, no special hours. */
export function listingFromPlace(body: unknown): Listing {
  const place = rec(body);
  if (!place) throw new Error("Google Maps answered with something that is not a place.");
  const hours: DayHours = {};
  const periods = list(rec(place.regularOpeningHours)?.periods);
  for (const p of periods) {
    const r = rec(p);
    const open = rec(r?.open);
    const close = rec(r?.close);
    const openDay = PLACE_DAYS[num(open?.day) ?? -1];
    if (!open || !openDay) continue;
    if (!close) {
      // A place open around the clock has one period with no close.
      for (const d of DAYS) addInterval(hours, d, [0, 1440]);
      continue;
    }
    const closeDay = PLACE_DAYS[num(close.day) ?? -1];
    if (!closeDay) continue;
    addPeriod(
      hours,
      { day: openDay, minutes: clockOf(open, "hour", "minute") },
      { day: closeDay, minutes: clockOf(close, "hour", "minute") },
    );
  }
  const status = text(place.businessStatus);
  const name = text(rec(place.displayName)?.text);
  const phone = text(place.nationalPhoneNumber) ?? text(place.internationalPhoneNumber);
  const address = text(place.formattedAddress);
  const website = text(place.websiteUri);
  const url = plainUrl(place.googleMapsUri);
  return {
    source: "google-places",
    label: "Google Maps",
    ...(url ? { url } : {}),
    status: statusOf(status === "OPERATIONAL" ? undefined : status, true),
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(website ? { website } : {}),
    ...(periods.length > 0 ? { hours } : {}),
  };
}

/**
 * Google Maps through the Places API (New) Place Details, with an API key for the public fields.
 * The key travels in the X-Goog-Api-Key header of a GET, not in the address, and the field mask
 * asks for the fields compared and nothing else.
 */
export function googlePlacesConnector(placeId: string): Connector<Listing> {
  const envVars = [GOOGLE_PLACES_KEY];
  return {
    id: "google-places",
    envVars,
    configured: (env) => isConfigured(env, envVars),
    async read(env, fetcher) {
      const hop = await connectorGet(
        fetcher,
        `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
        {
          headers: {
            "x-goog-api-key": env[GOOGLE_PLACES_KEY] ?? "",
            "x-goog-fieldmask":
              "displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,businessStatus,googleMapsUri",
          },
        },
      );
      return [listingFromPlace(jsonBody(hop, "Google Maps"))];
    },
  };
}
