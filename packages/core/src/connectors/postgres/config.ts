import * as z from "zod";

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
  queries: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "must be a plain name like eightySixed"),
      queryEntry,
    )
    .refine((q) => Object.keys(q).length > 0, "name at least one query")
    .refine((q) => Object.keys(q).length <= 50, "at most 50 queries per source"),
});

/**
 * gaugeline.sources.json: where a site's truth lives besides the site. Only names and SQL live in
 * this file; connection strings and keys are environment variables, named here and never written.
 */
export const sourcesConfigSchema = z.strictObject({
  sources: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "must be a short lower-case name like db"),
      sourceSchema,
    )
    .refine((s) => Object.keys(s).length > 0, "name at least one source")
    .refine((s) => Object.keys(s).length <= 5, "at most 5 sources"),
});

export type SourceConfig = z.infer<typeof sourceSchema>;
export type SourcesConfig = z.infer<typeof sourcesConfigSchema>;

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
