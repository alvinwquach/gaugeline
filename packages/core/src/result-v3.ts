import * as z from "zod";
import { redact } from "./redact.js";
import { buildResult, findingSchema, resultSchema, type Result } from "./result.js";

/**
 * Schema 3 of the `--json` result: schema 2 plus the findings and entries that a suppression or a
 * baseline hides. It is opt-in (`--json-schema 3`); the default stays schema 2, and a schema 2 result
 * never gains a field. Bump only together with a new schema/result.v<N>.json file.
 */
export const RESULT_SCHEMA_VERSION_3 = 3 as const;

/** The result schema numbers `--json-schema` can select. 2 is the default. */
export const SELECTABLE_RESULT_SCHEMAS = [2, 3] as const;
export type SelectableResultSchema = (typeof SELECTABLE_RESULT_SCHEMAS)[number];

/** One suppression entry, as the config or --suppress wrote it. `until` is the last day it applies (UTC). */
export const suppressionEntrySchema = z
  .object({
    id: z.string().min(1),
    url: z.string().optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string(),
  })
  .strict();

export const resultSchemaV3 = z
  .object({
    ...resultSchema.shape,
    schema: z.literal(RESULT_SCHEMA_VERSION_3),
    /** Findings an active suppression hid, each with the entry that did it. */
    suppressed: z.array(z.object({ finding: findingSchema, by: suppressionEntrySchema }).strict()),
    /** Entries past their `until` date: they no longer apply, whether or not the finding is still there. */
    expiredSuppressions: z.array(suppressionEntrySchema),
    /** Active entries that matched no finding in this run: a mistyped id, or a fixed problem. */
    unmatchedSuppressions: z.array(suppressionEntrySchema),
    /** Findings the baseline file already knew, left out of `findings`. */
    baselined: z.array(findingSchema),
  })
  .strict();

export type ResultV3 = z.infer<typeof resultSchemaV3>;
export type SuppressionEntry = z.infer<typeof suppressionEntrySchema>;

export function parseResultV3(value: unknown): ResultV3 {
  return resultSchemaV3.parse(value);
}

/** The reason is the user's own text; it goes through redact() like every other string that leaves a run. */
function cleanEntry(e: SuppressionEntry): SuppressionEntry {
  return {
    id: e.id,
    ...(e.url === undefined ? {} : { url: e.url }),
    until: e.until,
    reason: redact(e.reason),
  };
}

/** Assemble a schema 3 result: the schema 2 result of the run, with its number changed, and what was hidden. */
export function buildResultV3(
  run: Parameters<typeof buildResult>[0] & {
    suppressed?: readonly { finding: Result["findings"][number]; entry: SuppressionEntry }[];
    expired?: readonly SuppressionEntry[];
    unmatched?: readonly SuppressionEntry[];
    baselined?: readonly Result["findings"][number][];
  },
): ResultV3 {
  const { schema: _schema, ...base } = buildResult(run);
  return {
    schema: RESULT_SCHEMA_VERSION_3,
    ...base,
    suppressed: (run.suppressed ?? []).map((s) => ({
      finding: s.finding,
      by: cleanEntry(s.entry),
    })),
    expiredSuppressions: (run.expired ?? []).map(cleanEntry),
    unmatchedSuppressions: (run.unmatched ?? []).map(cleanEntry),
    baselined: [...(run.baselined ?? [])],
  };
}
