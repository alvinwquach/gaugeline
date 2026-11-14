import * as z from "zod";

/**
 * gaugeline.sites.json: the sites one person looks after, checked with one command. Keys are never
 * in the file, only the prefix that names them: a site with keyPrefix ACME reads
 * ACME_GAUGELINE_BASIC_AUTH from the environment as its GAUGELINE_BASIC_AUTH.
 */
export const siteEntrySchema = z
  .object({
    /** Lower case, digits and hyphens: it names the site's run folder (runs/<name>/). */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lower case letters, digits and hyphens"),
    address: z.string().min(1),
    /** The folder holding this site's gaugeline.*.json files, relative to the sites file. */
    config: z.string().min(1).optional(),
    /** Upper case, digits and underscores: ACME reads ACME_<VARIABLE>. */
    keyPrefix: z
      .string()
      .regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/, "upper case letters, digits and underscores")
      .optional(),
    tags: z.array(z.string().min(1)).optional(),
    /** Who agreed to the site being checked, and when. A site without it is refused. */
    permission: z
      .object({
        by: z.string().min(1),
        on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD"),
        note: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const sitesFileSchema = z.object({ sites: z.array(siteEntrySchema).min(1) }).strict();

export type SiteEntry = z.infer<typeof siteEntrySchema>;
export type SitesFile = z.infer<typeof sitesFileSchema>;

/** The variables that carry a preview's secret: never shared between sites, only given by prefix. */
export const ORIGIN_SECRETS = [
  "GAUGELINE_VERCEL_BYPASS",
  "GAUGELINE_BASIC_AUTH",
  "GAUGELINE_PREVIEW_HEADER",
] as const;

/**
 * One site's environment: the shared one without the preview secrets (they would reach every
 * site's origin), plus each <PREFIX>_<NAME> variable given as <NAME>. Values are never printed.
 */
export function siteEnv(
  env: Readonly<Record<string, string | undefined>>,
  prefix: string | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of ORIGIN_SECRETS) delete out[name];
  if (!prefix) return out;
  const p = `${prefix}_`;
  for (const [k, v] of Object.entries(env))
    if (k.startsWith(p) && k.length > p.length) out[k.slice(p.length)] = v;
  return out;
}
