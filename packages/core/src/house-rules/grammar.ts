/**
 * The rule grammar (AG-17): the sentence patterns the compiler recognises, as plain code. One line in, one
 * verdict out: a rule, a refusal (the line has the shape of a rule but what it names is unsafe), or null (no
 * pattern fits, so the line is listed as not understood and nothing is guessed).
 *
 * Every pattern is anchored, made of fixed words and at most one `(.+)` at the end, with no nested
 * quantifier, and is only ever run on a line of at most 300 characters (the caller refuses longer ones first),
 * so none can backtrack without end. What a pattern captures is never turned into a pattern: it is checked
 * against a closed alphabet and stored as text.
 */
import {
  FORBIDDEN_CHAR_NAMES,
  LABEL_PATTERN,
  MASK_MAX_DIGITS,
  MASK_MIN_DIGITS,
  MASK_PATTERN,
  MAX_TERMS_PER_LINE,
  TERM_PATTERN,
  type ForbiddenCharName,
  type HeadingCase,
  type RefusalCode,
} from "./schema.js";

export type Rule =
  | { key: "headings"; style: HeadingCase }
  | { key: "forbidChars"; names: ForbiddenCharName[] }
  | { key: "forbidTerms"; terms: string[] }
  | { key: "buttonLabel"; label: string }
  | { key: "phoneFormat"; mask: string };

export type Verdict = { ok: true; rule: Rule } | { ok: false; code: RefusalCode } | null;

const HEADINGS_A =
  /^(?:all |our |the )?headings? (?:(?:are|use|uses|take|go|must be|must use|should be|should use|should go|must go)(?: in| as)? |in |as )?(sentence|title) case$/iu;
const HEADINGS_B =
  /^(?:use |write |set )?(sentence|title) case (?:for|in|on) (?:all |our |the )?(?:headings?|headlines?)$/iu;

const CHARS =
  /^(?:no|never use|never write|do not use|do not write|don['’]t use|don['’]t write|avoid) (.+)$/iu;
const CHAR_NAMES = new Map<string, ForbiddenCharName>([
  ["em dash", "em-dash"],
  ["em dashes", "em-dash"],
  ["em-dash", "em-dash"],
  ["em-dashes", "em-dash"],
  ["—", "em-dash"],
  ["en dash", "en-dash"],
  ["en dashes", "en-dash"],
  ["en-dash", "en-dash"],
  ["en-dashes", "en-dash"],
  ["–", "en-dash"],
  ["exclamation mark", "exclamation"],
  ["exclamation marks", "exclamation"],
  ["exclamation point", "exclamation"],
  ["exclamation points", "exclamation"],
  ["!", "exclamation"],
  ["ellipsis", "ellipsis"],
  ["ellipses", "ellipsis"],
  ["…", "ellipsis"],
]);

const TERMS_NEVER =
  /^(?:never|do not|don['’]t) (?:use|say|write) (?:the )?(?:words?|phrases?|terms?) (.+)$/iu;
const TERMS_AVOID = /^avoid (?:the )?(?:words?|phrases?|terms?) (.+)$/iu;

const BUTTON =
  /^(?:(?:all |our |the )?(?:(?:booking|main|primary|buy|call-to-action|cta) )?buttons?|calls? to action|ctas?) (?:say|says|read|reads|use|uses|should say|should read|should use|must say|must read|must use)(?: the (?:words?|text|label))? (.+)$/iu;

const PHONE =
  /^(?:phone|telephone|tel|mobile) numbers? (?:(?:are|must be|should be) )?(?:formatted|written|shown|displayed|set out|laid out) (?:like|as):? (.+)$/iu;

/** "a, b, or c", "a or b", "a and b": split on a comma, "or" or "and", each with its spaces. */
const LIST_SPLIT = /\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+/iu;

/** A path: a leading slash, a share, a drive letter, a home folder or a file address. */
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\/|\\\\|~|file:)/iu;
/** Any character a regular expression gives a meaning to (besides + ( ) . in a phone mask). */
const PATTERN_CHAR = /[\\^$.*+?()[\]{}|]/u;
const MASK_PATTERN_CHAR = /[\\^$*?[\]{}|]/u;

const stripQuotes = (s: string): string =>
  s
    .trim()
    .replace(/^["'`“‘«]+/u, "")
    .replace(/["'`”’»]+$/u, "")
    .trim();

type Checked = { ok: true; text: string } | { ok: false; code: RefusalCode };

/** A word or label from a rule: a path and a pattern are refused by name, anything else odd is not plain text. */
function plain(value: string, shape: RegExp, fold: boolean): Checked {
  if (value === "") return { ok: false, code: "not-plain-text" };
  if (ABSOLUTE_PATH.test(value)) return { ok: false, code: "absolute-path" };
  if (PATTERN_CHAR.test(value)) return { ok: false, code: "unsafe-pattern" };
  const text = fold ? value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ") : value;
  return shape.test(text) ? { ok: true, text } : { ok: false, code: "not-plain-text" };
}

function headings(line: string): Verdict {
  const m = HEADINGS_A.exec(line) ?? HEADINGS_B.exec(line);
  const style = m?.[1]?.toLowerCase();
  return style === "sentence" || style === "title"
    ? { ok: true, rule: { key: "headings", style } }
    : null;
}

function chars(line: string): Verdict {
  const list = CHARS.exec(line)?.[1];
  if (list === undefined) return null;
  const names: ForbiddenCharName[] = [];
  for (const part of list.split(LIST_SPLIT)) {
    const name = CHAR_NAMES.get(part.trim().toLowerCase());
    // One item that is not on the closed list leaves the whole line out: nothing is taken in part.
    if (name === undefined) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names.length > 0 && names.length <= FORBIDDEN_CHAR_NAMES.length
    ? { ok: true, rule: { key: "forbidChars", names } }
    : null;
}

function terms(line: string): Verdict {
  const list = (TERMS_NEVER.exec(line) ?? TERMS_AVOID.exec(line))?.[1];
  if (list === undefined) return null;
  const parts = list.split(LIST_SPLIT).map(stripQuotes);
  if (parts.length > MAX_TERMS_PER_LINE) return { ok: false, code: "too-many-terms" };
  const found: string[] = [];
  for (const part of parts) {
    const t = plain(part, TERM_PATTERN, true);
    if (!t.ok) return t;
    if (!found.includes(t.text)) found.push(t.text);
  }
  return { ok: true, rule: { key: "forbidTerms", terms: found } };
}

function button(line: string): Verdict {
  const value = BUTTON.exec(line)?.[1];
  if (value === undefined) return null;
  const label = plain(stripQuotes(value), LABEL_PATTERN, false);
  return label.ok ? { ok: true, rule: { key: "buttonLabel", label: label.text } } : label;
}

function phone(line: string): Verdict {
  const value = PHONE.exec(line)?.[1];
  if (value === undefined) return null;
  const example = stripQuotes(value);
  if (ABSOLUTE_PATH.test(example)) return { ok: false, code: "absolute-path" };
  if (MASK_PATTERN_CHAR.test(example)) return { ok: false, code: "unsafe-pattern" };
  // The example's digits become #: the mask keeps the shape and drops the number.
  const mask = example.replace(/\s+/gu, " ").replace(/\d/gu, "#");
  const digits = mask.split("#").length - 1;
  return MASK_PATTERN.test(mask) && digits >= MASK_MIN_DIGITS && digits <= MASK_MAX_DIGITS
    ? { ok: true, rule: { key: "phoneFormat", mask } }
    : { ok: false, code: "not-plain-text" };
}

const RECOGNISERS = [headings, chars, terms, button, phone] as const;

/** The first recogniser with an opinion decides. `line` is one cleaned line of at most 300 characters. */
export function recogniseLine(line: string): Verdict {
  for (const r of RECOGNISERS) {
    const v = r(line);
    if (v !== null) return v;
  }
  return null;
}

/** What a recognised rule says, in words a person reads in the review. Built from the rule, not the line. */
export function describeRule(rule: Rule): string {
  switch (rule.key) {
    case "headings":
      return `headings in ${rule.style} case`;
    case "forbidChars":
      return `no ${rule.names.map((n) => n.replace("-", " ")).join(", ")}`;
    case "forbidTerms":
      return `never use: ${rule.terms.join(", ")}`;
    case "buttonLabel":
      return `buttons say "${rule.label}"`;
    case "phoneFormat":
      return `phone numbers like ${rule.mask}`;
  }
}
