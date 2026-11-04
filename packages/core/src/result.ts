import * as z from "zod";
import { SEVERITIES } from "./model.js";

/** Bump only together with a new schema/result.v<N>.json file. Never edit a published file. */
export const RESULT_SCHEMA_VERSION = 1 as const;

/** Placeholder host until the domain is confirmed. Kept in one constant. */
export const SCHEMA_ID_BASE = "https://gaugeline.dev/schema/";

export const severitySchema = z.enum(SEVERITIES);

export const findingSchema = z
  .object({
    checkId: z.string().min(1),
    severity: severitySchema,
    title: z.string(),
    evidence: z.string(),
    url: z.string(),
    source: z
      .object({ file: z.string(), line: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();

export const resultSchema = z
  .object({
    schema: z.literal(RESULT_SCHEMA_VERSION),
    url: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    findings: z.array(findingSchema),
    passed: z.array(z.string()),
    failed: z.array(z.string()),
  })
  .strict();

export type Result = z.infer<typeof resultSchema>;

export function parseResult(value: unknown): Result {
  return resultSchema.parse(value);
}

/** Assemble a Result from a run. startedAt is always written in UTC with a Z offset. */
export function buildResult(run: {
  url: string;
  startedAt: Date;
  findings: Result["findings"];
  passed: string[];
  failed: string[];
}): Result {
  return {
    schema: RESULT_SCHEMA_VERSION,
    url: run.url,
    startedAt: run.startedAt.toISOString(),
    findings: run.findings,
    passed: run.passed,
    failed: run.failed,
  };
}
