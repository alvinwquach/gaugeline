import * as z from "zod";
import { classifyStatement } from "./classify.js";

/** Rows kept per query, at most. Larger results are cut here with a notice. */
export const MAX_ROWS = 5000;
/** How long a query may run before the database stops it. */
export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 60_000;

export const DEFAULT_POSTGRES_ENV = "GAUGELINE_POSTGRES_URL";
export const DEFAULT_SUPABASE_ENV = "GAUGELINE_SUPABASE_DB_URL";
export const DEFAULT_SUPABASE_KEY_ENV = "GAUGELINE_SUPABASE_KEY";

const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "must be the NAME of an environment variable, in capitals");
const column = z.string().min(1).max(63);
const mustAppearOn = z.array(z.string().regex(/^\//, 'must be a path like "/menu"')).max(20);

/** How the rows of a query become facts in the X23 model that other checks read. */
export const factMappingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("price"),
    /** The column that names the item, as the page writes it. */
    item: column,
    /** The column that holds the price. */
    value: column,
    /** "minor" when the column is whole cents (1250), "major" when it is dollars (12.50). */
    unit: z.enum(["minor", "major"]).default("minor"),
    currency: z.string().min(1).max(3).default("$"),
    mustAppearOn: mustAppearOn.optional(),
  }),
  z.strictObject({
    kind: z.literal("text"),
    /** The column whose text is the fact (an item that is 86'd, a sold-out show). */
    value: column,
    mustAppearOn: mustAppearOn.optional(),
  }),
]);

export type FactMapping = z.infer<typeof factMappingSchema>;

const sql = z.string().min(1).max(20_000);

const queryEntry = z.union([sql, z.strictObject({ sql, fact: factMappingSchema.optional() })]);

const functionName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*\*?$/, "must be a function name");

export const sourceSchema = z.strictObject({
  /** "postgres": any Postgres. "supabase": a Supabase project's database, with its key checked. */
  type: z.enum(["postgres", "supabase"]),
  /** The NAME of the variable that holds the connection string (never the string itself). */
  env: envName.optional(),
  /** supabase only: the NAME of the variable that holds the anon (or custom-role) key. */
  keyEnv: envName.optional(),
  timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional(),
  /** Lower than the 5,000 cap, never higher. */
  maxRows: z.number().int().min(1).max(MAX_ROWS).optional(),
  /** More functions to refuse, added to the built-in list. A trailing * means "starts with". */
  denyFunctions: z.array(functionName).max(50).optional(),
  /** Named queries. A source that only runs data assertions needs none. */
  queries: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "must be a plain name like eightySixed"),
      queryEntry,
    )
    .refine((q) => Object.keys(q).length <= 50, "at most 50 queries per source")
    .default({}),
});

const ASSERTION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The most evidence columns one assertion may list, and the most assertions one file may hold. */
export const MAX_EVIDENCE_COLUMNS = 10;
export const MAX_ASSERTIONS = 100;

/**
 * A data assertion: a SELECT that should return no rows. Any row is a problem, and `evidence` is the
 * allow-list of columns a finding may print: a column that is not named here never leaves the
 * database, so a finding cannot show an email or a phone number unless the file says so.
 */
export const assertionSchema = z.strictObject({
  id: z
    .string()
    .max(64)
    .regex(
      ASSERTION_ID,
      "must be lower-case words joined by hyphens, like no-overlapping-bookings",
    ),
  severity: z.enum(["high", "medium", "low"]),
  /** What is wrong, in a sentence for the person who owns the business. It is the finding's title. */
  title: z.string().trim().min(1).max(140),
  sql,
  /** The result columns a finding may show. The query names them with `as`. */
  evidence: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "must be a plain column name"))
    .min(1, "name at least one evidence column")
    .max(MAX_EVIDENCE_COLUMNS)
    .refine((c) => new Set(c).size === c.length, "list each evidence column once"),
  /** The source to run it on. Optional when the file has one source. */
  source: z.string().optional(),
});

export type Assertion = z.infer<typeof assertionSchema>;

/**
 * gaugeline.sources.json: where a site's truth lives besides the site. Only names and SQL live in
 * this file; connection strings and keys are environment variables, named here and never written.
 */
export const sourcesConfigSchema = z
  .strictObject({
    sources: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "must be a short lower-case name like db"),
        sourceSchema,
      )
      .refine((s) => Object.keys(s).length > 0, "name at least one source")
      .refine((s) => Object.keys(s).length <= 5, "at most 5 sources"),
    /** SELECTs that must return no rows (N10). Each runs through the same read-only layers as a query. */
    assertions: z.array(assertionSchema).max(MAX_ASSERTIONS).optional(),
  })
  .superRefine((config, ctx) => {
    const names = Object.keys(config.sources);
    const used = new Set<string>();
    const ids = new Set<string>();
    (config.assertions ?? []).forEach((a, i) => {
      if (ids.has(a.id))
        ctx.addIssue({
          code: "custom",
          path: ["assertions", i, "id"],
          message: `"${a.id}" is used by two assertions; each id must be different`,
        });
      ids.add(a.id);
      const name = a.source ?? (names.length === 1 ? names[0] : undefined);
      if (name === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", i, "source"],
          message: `assertion "${a.id}": more than one source is set up, so say which source it runs on`,
        });
        return;
      }
      const source = config.sources[name];
      if (source === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", i, "source"],
          message: `assertion "${a.id}" names the source "${name}", which is not in sources`,
        });
        return;
      }
      used.add(name);
      // The first read-only layer, at the door: an assertion that is not one plain read is a config
      // error that stops the run, and it is never sent to any database.
      const verdict = classifyStatement(a.sql, {
        ...(source.denyFunctions ? { denyFunctions: source.denyFunctions } : {}),
      });
      if (!verdict.ok)
        ctx.addIssue({
          code: "custom",
          path: ["assertions", i, "sql"],
          message: `assertion "${a.id}" is not a read and was not run. ${verdict.message}`,
        });
    });
    for (const [name, source] of Object.entries(config.sources))
      if (Object.keys(source.queries).length === 0 && !used.has(name))
        ctx.addIssue({
          code: "custom",
          path: ["sources", name, "queries"],
          message: "name at least one query or assertion",
        });
  });

export type SourceConfig = z.infer<typeof sourceSchema>;
export type SourcesConfig = z.infer<typeof sourcesConfigSchema>;

/** The name of the source an assertion runs on: its own `source`, else the file's only source. */
export function assertionSourceName(
  config: SourcesConfig,
  assertion: Assertion,
): string | undefined {
  if (assertion.source !== undefined) return assertion.source;
  const names = Object.keys(config.sources);
  return names.length === 1 ? names[0] : undefined;
}

/** The variable holding a source's connection string. */
export function connectionVar(source: SourceConfig): string {
  return source.env ?? (source.type === "supabase" ? DEFAULT_SUPABASE_ENV : DEFAULT_POSTGRES_ENV);
}

/** The variable holding a supabase source's key; undefined for any other type. */
export function keyVar(source: SourceConfig): string | undefined {
  return source.type === "supabase" ? (source.keyEnv ?? DEFAULT_SUPABASE_KEY_ENV) : undefined;
}

/** Every variable the configured sources may read: what the CLI hands to core for them. */
export function sourceEnvVars(config: SourcesConfig): string[] {
  const names = new Set<string>();
  for (const source of Object.values(config.sources)) {
    names.add(connectionVar(source));
    const key = keyVar(source);
    if (key !== undefined) names.add(key);
  }
  return [...names];
}

/** A query entry as its SQL and optional mapping, whichever way the config wrote it. */
export function queryParts(entry: z.infer<typeof queryEntry>): { sql: string; fact?: FactMapping } {
  return typeof entry === "string"
    ? { sql: entry }
    : entry.fact
      ? { sql: entry.sql, fact: entry.fact }
      : { sql: entry.sql };
}
