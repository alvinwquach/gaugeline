import * as z from "zod";
import { SEVERITIES, SIZES } from "../model.js";

/**
 * The work order as data (G28a): what `buildBrief` returns and `renderBriefMarkdown` reads. It is its
 * own document with its own version, independent of the `--json` result's and of the saved requests
 * file's, and its own published schema (schema/brief.v<N>.json). Bump BRIEF_SCHEMA_VERSION only
 * together with a new schema file; never edit a published one.
 *
 * It holds names, kinds, counts and the evidence lines the report already shows: never a key, a
 * header or a response body. Text that came from a page is plain text here (invisible characters
 * shown as escapes, cut at 300 characters); it is escaped for Markdown only when it is rendered.
 */
export const BRIEF_SCHEMA_VERSION = 1 as const;

/** What a check found and where, kept apart so the Markdown can escape each part on its own. */
export const evidencePartSchema = z
  .object({
    /** What was found, as the report says it. Empty when only the address is known. */
    what: z.string(),
    /** The address the evidence is about, without its query string. Empty when `what` names it. */
    where: z.string(),
  })
  .strict();

export const briefItemSchema = z
  .object({
    checkId: z.string().min(1),
    /** The check's plain-English title. */
    title: z.string(),
    /** The most severe level among the check's findings. */
    severity: z.enum(SEVERITIES),
    size: z.enum(SIZES),
    /** S is 1 point, M 3, L 8. */
    points: z.number().int().positive(),
    /** What is wrong, in the check's words. */
    wrong: z.string(),
    why: z.string(),
    /** What "done" looks like. */
    done: z.string(),
    /** One line per place to look, as an app would show it: "what (address)". */
    evidence: z.array(z.string()),
    /**
     * The same lines split into `what` and `where`. The Markdown escapes each part on its own, so
     * the text is the same as in G28. Optional: without it, or when it no longer matches `evidence`
     * (an edited line), each `evidence` line is escaped whole.
     */
    evidenceParts: z.array(evidencePartSchema).optional(),
    estimateChanges: z.string(),
  })
  .strict();

/** Findings from a check this version does not have: listed, never sized, never in the total. */
export const briefNotSizedSchema = z
  .object({
    checkId: z.string(),
    title: z.string(),
    evidence: z.array(z.string()),
    evidenceParts: z.array(evidencePartSchema).optional(),
  })
  .strict();

export const briefSchema = z
  .object({
    schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
    /** The name the person gave, as typed. Absent: the heading names `host`. */
    business: z.string().optional(),
    /** The checked address without its query string or fragment. */
    url: z.string(),
    host: z.string(),
    /** When the check started, UTC. */
    checkedAt: z.iso.datetime({ offset: true }),
    /** Most severe first, then the smallest fix first. */
    items: z.array(briefItemSchema),
    /** The sum of the items' points. */
    points: z.number().int().nonnegative(),
    /** Whole hours, always two ends. Present only with `hoursPerPoint` and at least one item. */
    hours: z
      .object({ low: z.number().int().positive(), high: z.number().int().positive() })
      .strict()
      .optional(),
    /** The same range in money, in whole minor units. Present only with a rate. */
    cost: z
      .object({
        lowMinor: z.number().int().nonnegative(),
        highMinor: z.number().int().nonnegative(),
        currency: z.string(),
      })
      .strict()
      .optional(),
    /** What a point was taken to cost in hours (two decimals). Present when `hours` is. */
    hoursPerPoint: z.number().positive().optional(),
    /** What an hour was taken to cost, in minor units. Present when `cost` is. */
    rateMinor: z.number().int().positive().optional(),
    /** How many checks could not read part of the site, so the work order may be missing items. */
    couldNotCheck: z.number().int().nonnegative(),
    notSized: z.array(briefNotSizedSchema),
  })
  .strict();

export type BriefEvidencePart = z.infer<typeof evidencePartSchema>;
export type BriefItem = z.infer<typeof briefItemSchema>;
export type BriefNotSized = z.infer<typeof briefNotSizedSchema>;
export type Brief = z.infer<typeof briefSchema>;

/** Read a work order that came from outside (a file, an assistant, a tool call). Throws on a wrong shape. */
export function parseBrief(value: unknown): Brief {
  return briefSchema.parse(value);
}
