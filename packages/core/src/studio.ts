import * as z from "zod";

/**
 * The editor studio's route, named by the owner (gaugeline.studio.json). Gaugeline never picks an admin
 * path such as /studio itself (CLAUDE.md rule 14): the one check that asks it, studio-response-cacheable,
 * runs only with --owner-consent and only for a route written here.
 */
export const studioConfigSchema = z
  .object({
    studioRoutes: z
      .array(z.string().regex(/^\/[^\s*?#]*$/, "must be a path starting with /, with no * ? or #"))
      .min(1, "name at least one route")
      .max(4, "at most 4 routes"),
  })
  .strict();

export type StudioConfig = z.infer<typeof studioConfigSchema>;
