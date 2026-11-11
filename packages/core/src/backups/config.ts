import * as z from "zod";

/** The oldest a backup may be before it is a finding, in days, when the settings say nothing. */
export const DEFAULT_MAX_AGE_DAYS = 7;
/** The latest export is too small when it is under this percent of the one before it. */
export const DEFAULT_SHRINK_PERCENT = 50;

/** A Supabase project reference: twenty lower-case letters, as in the project's address. */
const SUPABASE_REF = /^[a-z]{20}$/;
const SANITY_PROJECT = /^[a-z0-9]{4,20}$/;
const SANITY_DATASET = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * gaugeline.backups.json, read from the working folder like the other settings files. Everything is
 * optional: with no file, nothing is read except a Sanity dataset the environment already names. Keys are
 * never in this file: they are read from SUPABASE_ACCESS_TOKEN and SANITY_TOKEN.
 */
export const backupsConfigSchema = z.strictObject({
  /** The oldest the latest backup may be, in days. Default 7. */
  maxAgeDays: z.number().int().min(1).max(365).optional(),
  /** The Supabase project whose backups are read. */
  supabase: z
    .strictObject({
      projectRef: z.string().regex(SUPABASE_REF, "a Supabase project reference (20 letters)"),
    })
    .optional(),
  /** The Sanity dataset whose backups are read; the project defaults to SANITY_PROJECT_ID and the dataset to SANITY_DATASET, then production. */
  sanity: z
    .strictObject({
      projectId: z
        .string()
        .regex(SANITY_PROJECT, "a Sanity project id (lower-case letters and digits)")
        .optional(),
      dataset: z.string().regex(SANITY_DATASET, "a Sanity dataset name").optional(),
    })
    .optional(),
  /**
   * Folders with dated export files, for anything else (a nightly database dump, a content export a
   * script writes). A folder on this computer or a synced bucket; its files are listed, never opened.
   */
  exports: z
    .array(
      z.strictObject({
        /** What the export is, for the report ("database", "uploads"). */
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/, "a short name such as database")
          .optional(),
        /** The folder, relative to where Gaugeline runs. */
        folder: z.string().min(1).max(300),
        /**
         * Which files are backups: a name with * for any run of characters ("dump-*.sql.gz"). Without it, the
         * files with a known dump extension (.sql, .gz, .dump, .zip, ...) count, and dotfiles never do.
         */
        pattern: z
          .string()
          .regex(
            /^[A-Za-z0-9 ._*-]{1,80}$/,
            "a file name with * for any text, such as dump-*.sql.gz",
          )
          .optional(),
        /** The latest export is flagged when it is under this percent of the one before it. 1 to 99, default 50. */
        shrinkPercent: z.number().int().min(1).max(99).optional(),
      }),
    )
    .max(5)
    .optional(),
});

export type BackupsConfig = z.infer<typeof backupsConfigSchema>;
