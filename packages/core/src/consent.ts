import * as z from "zod";

/**
 * gaugeline.consent.json: the site's owner (or someone they gave permission) agreed that Gaugeline
 * may run its probing checks on this site (CLAUDE.md rule 14). The same as passing --owner-consent,
 * with a record of who agreed and when, so a shared repository says it once. A probing check asks a
 * route that should be protected for what it protects, with no credentials: run only on sites you
 * own or have permission to test.
 */
export const consentConfigSchema = z
  .object({
    ownerConsent: z
      .object({
        /** Who agreed: a name and role, such as "Maya Ortiz, owner of Tideline Coaching". */
        by: z.string().min(1, "must say who agreed"),
        /** The day they agreed (YYYY-MM-DD). */
        on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-11-10")
          .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "must be a real date"),
        note: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type ConsentConfig = z.infer<typeof consentConfigSchema>;
