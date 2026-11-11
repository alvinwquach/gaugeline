import * as z from "zod";

/** A path on the site: starts with a slash, no query or fragment. */
const PATH = /^\/[^\s?#*]*$/;
/** A path, or a folder with a trailing star ("/blog/*"). */
const STATIC_PATH = /^\/[^\s?#*]*\*?$/;

/** The least a shared cache may keep a page marked static, in seconds, when the settings say nothing. */
export const DEFAULT_MINIMUM_SECONDS = 60;
/** How many days before the latest one make a metric's trailing average. */
export const DEFAULT_WINDOW = 14;
/** A day is a jump when it is more than this many times the trailing average. */
export const DEFAULT_MULTIPLE = 2;
/** How long to wait between the two visits to a page, in milliseconds. */
export const DEFAULT_DELAY_MS = 3000;

/**
 * gaugeline.cost.json, read from the working folder like the other settings files. Everything is
 * optional: with no file, the page itself is compared across two visits and any usage token in the
 * environment is read. Keys are never in this file: they are read from GAUGELINE_VERCEL_TOKEN and SANITY_TOKEN.
 */
export const costConfigSchema = z.strictObject({
  /** Pages that should be served from a cache: a path, or a folder with a trailing star. never-cached and revalidate-too-often judge only these. */
  static: z
    .array(z.string().regex(STATIC_PATH, 'a path such as "/menu" or "/blog/*"'))
    .max(50)
    .optional(),
  /** Other pages to visit twice besides the one you gave: paths on the same site. At most ten. */
  pages: z.array(z.string().regex(PATH, 'a path such as "/specials"')).max(10).optional(),
  /** The shortest cache lifetime, in seconds, a page marked static may have. Default 60. */
  minimumSeconds: z.number().int().min(1).max(31_536_000).optional(),
  /** The Vercel team whose usage is read; leave out for the token's own account. */
  vercel: z
    .strictObject({
      teamId: z.string().regex(/^team_[A-Za-z0-9]{1,60}$/, "a Vercel team id such as team_abc123"),
    })
    .optional(),
  usage: z
    .strictObject({
      /** Days before the latest complete day that make the trailing average. 3 to 60, default 14. */
      window: z.number().int().min(3).max(60).optional(),
      /** A day more than this many times its trailing average is a jump. More than 1, at most 100, default 2. */
      multiple: z
        .number()
        .gt(1)
        .max(100)
        .refine((m) => Math.round(m * 100) === m * 100, "at most two decimals")
        .optional(),
    })
    .optional(),
});

export type CostConfig = z.infer<typeof costConfigSchema>;
