import * as z from "zod";

/** gaugeline.stale-dates.json: `{ "staleDates": { "graceDays": 1, "ignore": [...], "historic": [...] } }`. */
export const staleDatesConfigSchema = z.strictObject({
  staleDates: z.strictObject({
    /** Days a date may be past before it is flagged. Default 1. */
    graceDays: z.number().int().min(0).max(366).optional(),
    /** A sentence containing any of these (case-insensitive) is never flagged. */
    ignore: z.array(z.string().min(1).max(200)).max(200).optional(),
    /** Path globs ("/news/*") of pages that are records of the past: never flagged. */
    historic: z
      .array(z.string().startsWith("/", "must be a path starting with /"))
      .max(200)
      .optional(),
  }),
});
export type StaleDatesConfig = z.infer<typeof staleDatesConfigSchema>["staleDates"];

export const DEFAULT_GRACE_DAYS = 1;
