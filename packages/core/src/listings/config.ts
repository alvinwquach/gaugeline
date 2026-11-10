import * as z from "zod";
import { isTimeZone } from "../ics/time.js";
import { isSocialProfile } from "./sources/bio.js";

/**
 * Which listings to read, as gaugeline.listings.json holds it. Only identifiers live here (a
 * location, a place, a business, a file, an address): keys and tokens are environment variables and
 * are never in this file.
 */
export const listingsConfigSchema = z
  .strictObject({
    /** The venue's IANA time zone, for the dates special hours and closures fall on. */
    timeZone: z
      .string()
      .refine(isTimeZone, "must be an IANA time zone, like America/Chicago")
      .optional(),
    google: z
      .strictObject({
        /** The Business Profile location, "locations/<id>" (needs GOOGLE_BUSINESS_PROFILE_TOKEN). */
        location: z
          .string()
          .regex(/^locations\/\d{1,24}$/, 'must look like "locations/1234567890"')
          .optional(),
        /** The Google Maps place id (needs GOOGLE_PLACES_API_KEY). */
        placeId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{10,200}$/, "must be a Google place id")
          .optional(),
      })
      .optional(),
    yelp: z
      .strictObject({
        /** The business id or alias from its Yelp address (needs YELP_API_KEY). */
        businessId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_%-]{1,127}$/, "must be a Yelp business id"),
      })
      .optional(),
    apple: z
      .strictObject({
        /** The CSV exported from Apple Business Connect, relative to this file. */
        csv: z.string().min(1),
        /** Which row, when the export holds several: its Location ID or business name. */
        location: z.string().min(1).optional(),
      })
      .optional(),
    bios: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(40),
          url: z
            .url({ protocol: /^https?$/ })
            .refine(
              (u) => !isSocialProfile(u),
              "that is the social platform's own page, which Gaugeline never requests. Give the link-in-bio address the bio carries",
            ),
        }),
      )
      .max(6)
      .optional(),
  })
  .refine(
    (c) =>
      c.google?.location !== undefined ||
      c.google?.placeId !== undefined ||
      c.yelp !== undefined ||
      c.apple !== undefined ||
      (c.bios?.length ?? 0) > 0,
    "name at least one listing: google, yelp, apple or bios",
  );

export type ListingsConfig = z.infer<typeof listingsConfigSchema>;
