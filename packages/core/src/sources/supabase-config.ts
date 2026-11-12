import * as z from "zod";

/**
 * The two facts about a Supabase read that the command line and the checks need without loading the
 * read itself (adapters/supabase-mcp-read.ts is reached only by a dynamic import: the loader rule).
 */

/** The environment variable that holds the personal access token. It is read from the environment only. */
export const SUPABASE_ACCESS_TOKEN = "SUPABASE_ACCESS_TOKEN";
/** A Supabase project ref as the dashboard shows it: 20 lower-case letters and digits (uncited). */
export const PROJECT_REF = /^[a-z0-9]{20}$/;

/**
 * gaugeline.platforms.json: which platforms to read and the project id. The token stays in the
 * environment; a key in the file is refused (strict), not ignored.
 */
export const platformsConfigSchema = z.strictObject({
  supabase: z.strictObject({
    projectRef: z
      .string()
      .regex(PROJECT_REF, "must be the 20-character project ref from the dashboard"),
  }),
});
export type PlatformsConfig = z.infer<typeof platformsConfigSchema>;
