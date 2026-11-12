import * as z from "zod";

/** Days a run is kept in the local runs store when the settings say nothing. */
export const DEFAULT_RETENTION_DAYS = 90;

const PATH = /^\/[^\s?#*]*$/;

/**
 * gaugeline.changes.json: everything is optional. Keys are never in this file: the Sanity token is
 * SANITY_TOKEN, the deploy tokens are VERCEL_TOKEN and NETLIFY_TOKEN, all read from the environment.
 */
export const changesConfigSchema = z.strictObject({
  /** Days a run stays in .gaugeline/runs. 7 to 3650, default 90. */
  retentionDays: z.number().int().min(7).max(3650).optional(),
  /** Which document in the content system each page is made from: path -> document id. */
  documents: z
    .record(z.string().regex(PATH, 'a path such as "/events"'), z.string().min(1).max(200))
    .optional(),
  /** Where the site's deployments are listed (read only). */
  deploys: z
    .discriminatedUnion("provider", [
      z.strictObject({
        provider: z.literal("vercel"),
        projectId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a Vercel project id"),
        teamId: z
          .string()
          .regex(/^team_[A-Za-z0-9]{1,60}$/, "a Vercel team id such as team_abc123")
          .optional(),
      }),
      z.strictObject({
        provider: z.literal("netlify"),
        siteId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a Netlify site id"),
      }),
    ])
    .optional(),
  /** The warranty: the day it ends (YYYY-MM-DD) and what it covers, in the freelancer's words. */
  warranty: z
    .strictObject({
      ends: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-12-31"),
      covers: z.string().min(1).max(300).optional(),
    })
    .optional(),
});

export type ChangesConfig = z.infer<typeof changesConfigSchema>;
