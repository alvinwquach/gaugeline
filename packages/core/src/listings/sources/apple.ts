import type { Connector } from "../../connectors/types.js";
import { DAYS, type Day } from "../../facts/normalise.js";
import { namesAgree, normaliseName } from "../match.js";
import { parseListedHours, type DayHours } from "../hours.js";
import type { Listing, ListingStatus } from "../types.js";
import { parseCsv } from "./csv.js";

/** Header spellings read for each field, compared lower case without spaces or punctuation. */
const HEADERS = {
  id: ["locationid", "storecode", "id", "partnerlocationid"],
  name: ["name", "businessname", "locationname", "displayname", "title"],
  phone: ["phone", "phonenumber", "primaryphone", "telephone"],
  website: ["website", "websiteurl", "url", "websiteuri", "link"],
  address: ["address", "streetaddress", "addressline1", "address1", "street"],
  city: ["city", "locality"],
  state: ["state", "region", "administrativearea"],
  zip: ["zip", "zipcode", "postalcode", "postcode"],
  hours: ["hours", "openinghours", "businesshours", "regularhours"],
  status: ["status", "businessstatus", "locationstatus", "verificationstatus"],
} as const;

const DAY_HEADERS: Record<Day, string[]> = {
  mon: ["monday", "mon"],
  tue: ["tuesday", "tue"],
  wed: ["wednesday", "wed"],
  thu: ["thursday", "thu"],
  fri: ["friday", "fri"],
  sat: ["saturday", "sat"],
  sun: ["sunday", "sun"],
};

function key(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function statusOf(text: string): ListingStatus {
  const s = text.toLowerCase();
  if (/permanent/.test(s) || /closed\s*(for\s*good|down)/.test(s)) return "closed-permanently";
  if (/temporar/.test(s)) return "closed-temporarily";
  if (/unverified|pending|not\s*verified|unclaimed/.test(s)) return "unverified";
  return "open";
}

/**
 * The rows of a CSV exported from Apple Business Connect as listings. Apple documents no public
 * read API for a business's data, so the owner exports a file and Gaugeline reads it. Column names
 * are matched loosely (see HEADERS above and docs/connectors/listings.md); hours come from one
 * "Hours" column written as "Mon-Thu 11am-2am; Fri-Sat 11am-3am" or from one column per weekday.
 * A column that is not there is a field Apple's export does not give: it is never compared.
 */
export function listingsFromAppleCsv(csv: string): Listing[] {
  const [head, ...body] = parseCsv(csv);
  if (!head || body.length === 0) throw new Error("The Apple Business Connect export has no rows.");
  const columns = head.map(key);
  const find = (names: readonly string[]): number => columns.findIndex((c) => names.includes(c));
  const at = Object.fromEntries(
    Object.entries(HEADERS).map(([field, names]) => [field, find(names)]),
  ) as Record<keyof typeof HEADERS, number>;
  if (at.name < 0 && at.address < 0 && at.phone < 0 && at.hours < 0)
    throw new Error(
      "The Apple Business Connect export has none of the columns Gaugeline reads (name, phone, address, website, hours).",
    );
  const dayAt = DAYS.map((d) => ({ day: d, index: find(DAY_HEADERS[d]) }));
  return body.map((r): Listing => {
    const cell = (i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");
    const hours: DayHours = {};
    const written = cell(at.hours);
    if (written !== "") Object.assign(hours, parseListedHours(written));
    for (const { day, index } of dayAt) {
      const v = cell(index);
      if (v === "") continue;
      Object.assign(hours, parseListedHours(`${day} ${v}`));
    }
    const street = [
      cell(at.address),
      cell(at.city),
      [cell(at.state), cell(at.zip)].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(", ");
    const name = cell(at.name);
    const phone = cell(at.phone);
    const website = cell(at.website);
    return {
      source: "apple",
      label: "Apple Business Connect",
      status: statusOf(cell(at.status)),
      ...(name ? { name } : {}),
      ...(phone ? { phone } : {}),
      ...(street ? { address: street } : {}),
      ...(website ? { website } : {}),
      ...(Object.keys(hours).length > 0 ? { hours } : {}),
    };
  });
}

/** Which row of an export is this business: the location id or the name the owner gave. */
function pick(csv: string, rows: Listing[], location: string | undefined): Listing[] {
  if (rows.length === 1) return rows;
  if (location === undefined)
    throw new Error(
      `The Apple Business Connect export has ${rows.length} locations. Add "location" to the apple entry in gaugeline.listings.json: the Location ID or the business name of the one to check.`,
    );
  const [head, ...body] = parseCsv(csv);
  const idAt = (head ?? [])
    .map(key)
    .findIndex((c) => (HEADERS.id as readonly string[]).includes(c));
  const wanted = location.trim().toLowerCase();
  const byId =
    idAt >= 0
      ? body.flatMap((r, i) => ((r[idAt] ?? "").trim().toLowerCase() === wanted ? [i] : []))
      : [];
  const chosen =
    byId.length > 0
      ? byId
      : rows.flatMap((l, i) =>
          l.name !== undefined &&
          normaliseName(l.name) === normaliseName(location) &&
          namesAgree(l.name, location)
            ? [i]
            : [],
        );
  if (chosen.length !== 1)
    throw new Error(
      `${chosen.length === 0 ? "No" : "More than one"} row of the Apple Business Connect export matches the location "${location}".`,
    );
  return [rows[chosen[0] as number] as Listing];
}

/** Apple Business Connect through the owner's CSV export, already read from its file. */
export function appleConnector(csv: string, location?: string): Connector<Listing> {
  return {
    id: "apple",
    envVars: [],
    configured: () => true,
    read: () => Promise.resolve(pick(csv, listingsFromAppleCsv(csv), location)),
  };
}
