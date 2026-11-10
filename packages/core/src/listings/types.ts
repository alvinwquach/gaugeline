import type { DayHours } from "./hours.js";

/** The connector ids, which are also the keys of a listing's source. */
export const LISTING_SOURCES = [
  "google-business",
  "google-places",
  "yelp",
  "apple",
  "bio-link",
] as const;
export type ListingSource = (typeof LISTING_SOURCES)[number];

/** What the listing says about whether the business is open. */
export type ListingStatus =
  | "open"
  | "closed-permanently"
  | "closed-temporarily"
  /** Not verified (Google) or not claimed (Yelp): the owner does not control it yet. */
  | "unverified";

/** A date the listing gives its own hours: closed, or open for the intervals. */
export interface SpecialDay {
  /** YYYY-MM-DD, in the venue's calendar. */
  date: string;
  closed: boolean;
}

/**
 * One business listing as a source states it. Every field but the source is optional: a source
 * only fills what it can read, and a field it cannot read is never compared (it is not "missing").
 */
export interface Listing {
  source: ListingSource;
  /** Plain words for the source: "Google Business Profile". */
  label: string;
  /** Where a person can see the listing, when the source gives it. */
  url?: string;
  status: ListingStatus;
  name?: string;
  phone?: string;
  /** The address as one line, as the source writes it. */
  address?: string;
  /** The link the listing carries to the business's website (or the link-in-bio address). */
  website?: string;
  /** The weekly hours. A day with no entry is closed. Absent when the source gave no hours. */
  hours?: DayHours;
  /** The dates the listing has special hours for. Absent when this source cannot say. */
  specialDays?: SpecialDay[];
}
