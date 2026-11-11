import * as z from "zod";

/**
 * The advisory answer as data: what `checkAdvisory` returns and `gaugeline advisory --json` prints. It is its
 * own document with its own version, independent of the `--json` result's (schemaVersion 2), and its own
 * published schema (schema/advisory.v<N>.json). Bump ADVISORY_SCHEMA_VERSION only together with a new schema
 * file; never edit a published one.
 *
 * Every string is plain text. Text that came from OSV or from a page has invisible characters shown as
 * escapes and is cut; it is escaped for Markdown only when the note is rendered. It holds no key, no header
 * value and no response body.
 */
export const ADVISORY_SCHEMA_VERSION = 1 as const;

export const VERDICTS = ["likely-affected", "likely-not-affected", "cannot-tell"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const advisoryResultSchema = z
  .object({
    schemaVersion: z.literal(ADVISORY_SCHEMA_VERSION),
    advisory: z
      .object({
        /** CVE-..., GHSA-..., or the package and range as typed. */
        id: z.string(),
        aliases: z.array(z.string()),
        summary: z.string().optional(),
        /** The date OSV marks the advisory withdrawn. */
        withdrawn: z.string().optional(),
        /** "osv": read from OSV. "given": the package and range were typed. */
        source: z.enum(["osv", "given"]),
        packages: z.array(
          z
            .object({
              ecosystem: z.string(),
              name: z.string(),
              /** The affected versions as a range, "" when the advisory gives none Gaugeline can read. */
              affectedVersions: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    site: z
      .object({
        address: z.string(),
        /** When the answer was made. */
        checkedAt: z.string(),
        hostnames: z.array(
          z
            .object({
              host: z.string(),
              reached: z.boolean(),
              /** Why it was not reached, or what limited what it showed. */
              note: z.string().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    verdict: z.enum(VERDICTS),
    /** One line: the verdict and what it rests on. */
    headline: z.string(),
    /** The lines that decided it, in plain words. */
    evidence: z.array(z.string()),
    /** One verdict for each package the advisory names. */
    components: z.array(
      z
        .object({
          ecosystem: z.string(),
          name: z.string(),
          verdict: z.enum(VERDICTS),
          evidence: z.array(z.string()),
          /** The version that ends the affected stretch the site's version is in. */
          fixedIn: z.string().optional(),
        })
        .strict(),
    ),
    /** What only the repository or the server can show, each starting with the place to look. */
    checkInside: z.array(z.string()),
    /** What Gaugeline could not read, and why. */
    couldNotCheck: z.array(z.string()),
  })
  .strict();

export type AdvisoryResult = z.infer<typeof advisoryResultSchema>;
