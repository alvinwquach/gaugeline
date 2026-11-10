import { isConfigured } from "../../connectors/env.js";
import { connectorGet } from "../../connectors/http.js";
import type { Connector } from "../../connectors/types.js";
import { DAYS } from "../../facts/normalise.js";
import { addInterval, intervalFrom, type DayHours } from "../hours.js";
import type { Listing, ListingStatus, SpecialDay } from "../types.js";
import { jsonBody, list, num, plainUrl, rec, text } from "./json.js";

export const YELP_KEY = "YELP_API_KEY";

/** Yelp writes a clock time as "1100" or "0200". */
function clock(v: unknown): number | undefined {
  const s = text(v);
  if (!s || !/^\d{4}$/.test(s)) return undefined;
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2));
  return h <= 24 && m <= 59 ? h * 60 + m : undefined;
}

/**
 * A Fusion business-details answer as a listing: name, phone, address, weekly hours (day 0 is
 * Monday; a close at or before the open is the next morning), special hours, and whether the
 * business is closed for good or unclaimed. Yelp does not return the business's own website, so
 * `website` is never set.
 */
export function listingFromYelp(body: unknown): Listing {
  const b = rec(body);
  if (!b) throw new Error("Yelp answered with something that is not a business.");
  const hours: DayHours = {};
  const sets = list(b.hours);
  const regular = sets
    .map(rec)
    .find((h) => h && (h.hours_type === undefined || h.hours_type === "REGULAR"));
  const open = list(regular?.open);
  for (const o of open) {
    const r = rec(o);
    const day = DAYS[num(r?.day) ?? -1];
    const start = clock(r?.start);
    const end = clock(r?.end);
    if (!r || !day || start === undefined || end === undefined) continue;
    addInterval(hours, day, intervalFrom(start, end));
  }
  const specialDays: SpecialDay[] = [];
  for (const s of list(b.special_hours)) {
    const r = rec(s);
    const date = text(r?.date);
    if (r && date && /^\d{4}-\d{2}-\d{2}$/.test(date))
      specialDays.push({ date, closed: r.is_closed === true });
  }
  const loc = rec(b.location);
  const address =
    list(loc?.display_address)
      .filter((l): l is string => typeof l === "string")
      .join(", ") ||
    [text(loc?.address1), text(loc?.city), text(loc?.state), text(loc?.zip_code)]
      .filter(Boolean)
      .join(", ");
  const status: ListingStatus =
    b.is_closed === true ? "closed-permanently" : b.is_claimed === false ? "unverified" : "open";
  const name = text(b.name);
  const phone = text(b.display_phone) ?? text(b.phone);
  const url = plainUrl(b.url);
  return {
    source: "yelp",
    label: "Yelp",
    ...(url ? { url } : {}),
    status,
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(open.length > 0 ? { hours } : {}),
    specialDays,
  };
}

/** Yelp Fusion business details with an API key: one GET of one business, key in the header. */
export function yelpConnector(businessId: string): Connector<Listing> {
  const envVars = [YELP_KEY];
  return {
    id: "yelp",
    envVars,
    configured: (env) => isConfigured(env, envVars),
    async read(env, fetcher) {
      const hop = await connectorGet(
        fetcher,
        `https://api.yelp.com/v3/businesses/${encodeURIComponent(businessId)}`,
        { authorization: `Bearer ${env[YELP_KEY] ?? ""}` },
      );
      return [listingFromYelp(jsonBody(hop, "Yelp"))];
    },
  };
}
