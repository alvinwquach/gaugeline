/**
 * gaugeline.rules.json (AG-17): a site's house rules as data, the smallest shape that holds the five kinds of
 * rule the compiler understands. It is a sibling of gaugeline.ai.json, gaugeline.facts.json and the other
 * topic files, not a key in gaugeline.config.json, whose strict shape every run reads.
 *
 * Safe by construction. There is no pattern, no regular expression and no path anywhere in it: a rule names a
 * heading style, characters from a closed list, plain words, one button label and a phone mask made of `#` and
 * punctuation. A reader matches words as text. A file that has a key this schema does not know, or a word that
 * is not plain, is refused by name, so a hand-edited file is held to the same rules as a compiled one.
 */
import * as z from "zod";
import { ConfigError } from "../errors.js";

/** The live file. The compiler never writes it: a person renames a reviewed draft to this. */
export const HOUSE_CONFIG_FILE = "gaugeline.rules.json";
/** What a draft file's name must end with, so a draft can never be the live file. */
export const HOUSE_DRAFT_SUFFIX = ".draft.json";
export const HOUSE_DRAFT_FILE = "gaugeline.rules.draft.json";

export const HEADING_CASES = ["sentence", "title"] as const;
export type HeadingCase = (typeof HEADING_CASES)[number];

/** A closed list of characters a rule can forbid, by name. The compiler writes the name, never the character. */
export const FORBIDDEN_CHAR_NAMES = ["em-dash", "en-dash", "exclamation", "ellipsis"] as const;
export type ForbiddenCharName = (typeof FORBIDDEN_CHAR_NAMES)[number];
/** The character each name stands for, for the check that reads the file. */
export const FORBIDDEN_CHARS: Readonly<Record<ForbiddenCharName, string>> = Object.freeze({
  "em-dash": "—",
  "en-dash": "–",
  exclamation: "!",
  ellipsis: "…",
});

/** Most banned words or phrases in one file, and most one line may name. */
export const MAX_TERMS = 50;
export const MAX_TERMS_PER_LINE = 20;

/** A plain word or short phrase: letters, digits, apostrophes, hyphens and single spaces, 1 to 40 characters. */
export const TERM_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}'’ -]{0,38}[\p{L}\p{N}])?$/u;
/** A button label: as a term, and it may hold & and !, ending in a letter, a digit or !. */
export const LABEL_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}'’&! -]{0,38}[\p{L}\p{N}!])?$/u;
/** A phone mask: `#` for a digit, and + ( ) . - and spaces as themselves. */
export const MASK_PATTERN = /^[#+() .-]{6,30}$/u;
export const MASK_MIN_DIGITS = 6;
export const MASK_MAX_DIGITS = 15;

const hashes = (mask: string): number => mask.split("#").length - 1;
const unique = (a: readonly unknown[]): boolean => new Set(a).size === a.length;

const term = z
  .string({ error: "must be a word" })
  .regex(
    TERM_PATTERN,
    "must be a plain word or phrase: letters, digits, spaces, apostrophes and hyphens, 1 to 40 characters",
  )
  .refine((t) => !t.includes("  "), "must use single spaces");

export const houseConfigSchema = z
  .object({
    version: z.literal(1, { error: "must be 1" }),
    headings: z
      .object({ case: z.enum(HEADING_CASES, { error: 'must be "sentence" or "title"' }) })
      .strict()
      .optional(),
    forbidChars: z
      .array(
        z.enum(FORBIDDEN_CHAR_NAMES, {
          error: `must be one of ${FORBIDDEN_CHAR_NAMES.join(", ")}`,
        }),
      )
      .max(FORBIDDEN_CHAR_NAMES.length)
      .refine(unique, "must not repeat an entry")
      .optional(),
    forbidTerms: z
      .array(term)
      .max(MAX_TERMS, `must hold at most ${MAX_TERMS} words`)
      .refine(unique, "must not repeat a word")
      .optional(),
    buttonLabel: z
      .string({ error: "must be a label" })
      .regex(
        LABEL_PATTERN,
        "must be plain text: letters, digits, spaces, apostrophes, & and !, up to 40 characters",
      )
      .optional(),
    phoneFormat: z
      .string({ error: "must be a mask" })
      .regex(MASK_PATTERN, "must be a mask of # and + ( ) . - and spaces")
      .refine(
        (m) => hashes(m) >= MASK_MIN_DIGITS && hashes(m) <= MASK_MAX_DIGITS,
        `must have ${MASK_MIN_DIGITS} to ${MASK_MAX_DIGITS} digits (#)`,
      )
      .optional(),
  })
  .strict();
export type HouseConfig = z.infer<typeof houseConfigSchema>;

const dotted = (path: readonly PropertyKey[]): string => path.map(String).join(".");

/**
 * Validate a parsed gaugeline.rules.json or draft. `source` is the file's name. Every problem names its key
 * (forbidTerms.0); the first three are listed. Throws ConfigError (exit 2 in the CLI).
 */
export function parseHouseConfig(raw: unknown, source: string): HouseConfig {
  const parsed = houseConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const problems: string[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys)
        problems.push(
          `${dotted([...issue.path, key])}: not a key this file has. It holds no pattern and no path`,
        );
    } else {
      const where = dotted(issue.path);
      const what = issue.message.startsWith("Invalid input: expected object")
        ? "must be an object"
        : issue.message;
      problems.push(`${where === "" ? "the file" : where}: ${what}`);
    }
  }
  throw new ConfigError(`${source}: ${problems.slice(0, 3).join("; ")}.`, {
    hint: `See docs/house-rules for the shape: { version, headings, forbidChars, forbidTerms, buttonLabel, phoneFormat }.`,
  });
}

/** The lines a draft can hold per list; the rest are counted. */
export const MAX_LISTED = 50;

export const RULE_KEYS = [
  "headings",
  "forbidChars",
  "forbidTerms",
  "buttonLabel",
  "phoneFormat",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

/** Why a line that looked like a rule was refused. */
export const REFUSAL_CODES = [
  "unsafe-pattern",
  "absolute-path",
  "not-plain-text",
  "too-many-terms",
  "hidden-characters",
  "too-long",
  "conflict",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

const count = z.number().int().min(0).max(100_000);
const lineId = z.string().regex(/^line-\d{1,4}$/);
/** The draft's whole shape. The eval harness parses an answer with the same schema. */
export const houseDraftSchema = z
  .object({
    config: houseConfigSchema,
    understood: z
      .array(
        z.object({ line: lineId, rule: z.enum(RULE_KEYS), says: z.string().max(900) }).strict(),
      )
      .max(MAX_LISTED),
    notUnderstood: z
      .array(
        z
          .object({ line: lineId, text: z.string().max(200), aimedAtAssistant: z.boolean() })
          .strict(),
      )
      .max(MAX_LISTED),
    refused: z
      .array(
        z.object({ line: lineId, code: z.enum(REFUSAL_CODES), text: z.string().max(200) }).strict(),
      )
      .max(MAX_LISTED),
    totals: z
      .object({ lines: count, understood: count, notUnderstood: count, refused: count })
      .strict(),
    omitted: z.object({ understood: count, notUnderstood: count, refused: count }).strict(),
    summary: z.string().max(300),
  })
  .strict();
export type HouseRulesDraft = z.infer<typeof houseDraftSchema>;
