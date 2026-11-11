import * as z from "zod";

/** A path on the site, or a folder with a trailing star ("/conditions/*"). No query or fragment. */
const SENSITIVE_PATH = /^\/[^\s?#*]*\*?$/;

/**
 * gaugeline.trackers.json, read from the working folder like the other settings files. Everything is
 * optional: with no file, a page counts when it has a form (or an embedded form service). Nothing in this
 * file is a key.
 */
export const trackersConfigSchema = z.strictObject({
  /**
   * Pages that count as sensitive whether or not they have a form: a path, or a folder with a trailing
   * star. For a clinic, the pages that name a condition or a treatment; for a coach, the booking and intake pages.
   */
  sensitivePaths: z
    .array(z.string().regex(SENSITIVE_PATH, 'a path such as "/intake" or "/conditions/*"'))
    .max(50)
    .optional(),
});

export type TrackersConfig = z.infer<typeof trackersConfigSchema>;

/** The file's name, for the words a finding uses. */
export const TRACKERS_CONFIG_FILE = "gaugeline.trackers.json";
