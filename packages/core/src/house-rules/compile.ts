/**
 * The house-rules compiler (AG-17): a site's written rules (a plain-text or Markdown style guide) in, a DRAFT
 * gaugeline.house.json out. Plain code, no model, no network, no clock: the same text gives the same draft.
 *
 * The rules text is untrusted data. A line is matched against a fixed grammar and nothing else: a line no
 * pattern fits is listed as "not understood" and never guessed; a line that fits but names a pattern, a path or
 * hidden characters is refused; a line that talks to an assistant is listed and flagged, never obeyed. The text,
 * the line count and what comes out are all bounded, and what is quoted back is cleaned and cut first.
 *
 * This module returns data. Writing the draft (never over the live file) is the CLI's job.
 */
import { findDirective } from "../ai-directives.js";
import { sanitise } from "../untrusted.js";
import { describeRule, recogniseLine, type Rule } from "./grammar.js";
import {
  MAX_LISTED,
  MAX_TERMS,
  houseConfigSchema,
  type HouseConfig,
  type HouseRulesDraft,
  type RefusalCode,
  type RuleKey,
} from "./schema.js";

/** Most characters in a rules file, most lines, most characters in one line the grammar will read. */
export const MAX_RULES_CHARS = 50_000;
export const MAX_RULES_LINES = 1000;
export const MAX_LINE_CHARS = 300;
/** What a listed line is cut to when it is quoted back. */
const SHOWN_CHARS = 120;

/** The input is not text, or is too long to read. Its message is fixed words: it never quotes the input. */
export class HouseRulesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HouseRulesInputError";
  }
}

export interface RulesLine {
  /** "line-N": N is the line's number in the file, counting from 1. */
  id: string;
  /** The line with its list marker removed. Still untrusted. */
  text: string;
  /** True inside a code fence: an example, not a rule. */
  fenced: boolean;
}

const HEADING = /^#{1,6}(?:\s|$)/u;
const RULE_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const FENCE = /^(?:```|~~~)/u;
const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])\s+/u;
const QUOTE = /^>+\s?/u;
const c = String.fromCharCode;
const SPACES = new RegExp(
  `[${c(0xa0)}${c(0x1680)}${c(0x2000)}-${c(0x200a)}${c(0x202f)}${c(0x205f)}${c(0x3000)}]`,
  "gu",
);

function checkedText(text: unknown): string {
  if (typeof text !== "string") throw new HouseRulesInputError("The rules must be text.");
  if (text.length > MAX_RULES_CHARS)
    throw new HouseRulesInputError(`The rules file is longer than ${MAX_RULES_CHARS} characters.`);
  if (text.includes("\u0000"))
    throw new HouseRulesInputError("The rules file is not text: it holds a null byte.");
  return text;
}

/**
 * The lines of a rules file that can hold a rule, numbered by their place in the file. Blank lines, Markdown
 * headings, horizontal rules and the fence markers themselves are skipped; a list marker or block quote is
 * removed. Throws HouseRulesInputError for text that is not text, or too long.
 */
export function houseRulesLines(text: string): RulesLine[] {
  const raw = checkedText(text)
    .replace(new RegExp(`^${c(0xfeff)}`), "")
    .split(/\r\n|\r|\n/u);
  if (raw.length > MAX_RULES_LINES)
    throw new HouseRulesInputError(`The rules file has more than ${MAX_RULES_LINES} lines.`);
  const out: RulesLine[] = [];
  let fenced = false;
  raw.forEach((line, i) => {
    let t = line.trim();
    if (FENCE.test(t)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) {
      while (QUOTE.test(t)) t = t.replace(QUOTE, "").trim();
      if (t === "" || HEADING.test(t) || RULE_LINE.test(t)) return;
      t = t.replace(LIST_MARKER, "").trim();
    }
    if (t === "") return;
    out.push({ id: `line-${i + 1}`, text: t, fenced });
  });
  return out;
}

const shown = (t: string): string => sanitise(t, SHOWN_CHARS).text;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What the draft says about itself, in one sentence whose every number is a count the compiler made. */
function headline(
  lines: number,
  understood: number,
  notUnderstood: number,
  refused: number,
): string {
  return lines === 0
    ? "The file holds no lines to read."
    : `${understood} of ${plural(lines, "line")} became rules; ${notUnderstood} not understood; ${refused} refused.`;
}

/** True when sanitise would change the line: hidden, tag, bidirectional or control characters. */
function hasHiddenCharacters(line: string): boolean {
  const s = sanitise(line, MAX_LINE_CHARS + 100);
  return s.strippedDirectives > 0 || s.text !== line;
}

function listed<T>(items: T[]): { kept: T[]; omitted: number } {
  return { kept: items.slice(0, MAX_LISTED), omitted: Math.max(0, items.length - MAX_LISTED) };
}

/**
 * Compiles a rules file into a draft. The draft's `config` is valid for gaugeline.house.json (the schema is
 * the same one the draft is checked with). Throws HouseRulesInputError only for input that is not text or is
 * over the caps; every other problem is a listed line.
 */
export function compileHouseRules(text: string): HouseRulesDraft {
  const lines = houseRulesLines(text);
  const understood: HouseRulesDraft["understood"] = [];
  const notUnderstood: HouseRulesDraft["notUnderstood"] = [];
  const refused: HouseRulesDraft["refused"] = [];

  // Maps and Sets keyed by value: a repeated word or character is kept once, in the order first met, and a
  // second headings, button or phone rule is found by its key without a search.
  const singles = new Map<"headings" | "buttonLabel" | "phoneFormat", string>();
  const chars = new Set<string>();
  const terms = new Set<string>();

  const refuse = (id: string, code: RefusalCode, t: string) =>
    refused.push({ line: id, code, text: shown(t) });

  for (const { id, text: raw, fenced } of lines) {
    if (fenced) {
      notUnderstood.push({ line: id, text: shown(raw), aimedAtAssistant: false });
      continue;
    }
    if (raw.length > MAX_LINE_CHARS) {
      refuse(id, "too-long", raw);
      continue;
    }
    const line = raw
      .replace(SPACES, " ")
      .replace(/[ \t]+/gu, " ")
      .trim();
    if (hasHiddenCharacters(line)) {
      refuse(id, "hidden-characters", line);
      continue;
    }
    if (findDirective(line) !== undefined) {
      notUnderstood.push({ line: id, text: shown(line), aimedAtAssistant: true });
      continue;
    }
    const verdict = recogniseLine(line.replace(/[.;\s]+$/u, ""));
    if (verdict === null) {
      notUnderstood.push({ line: id, text: shown(line), aimedAtAssistant: false });
      continue;
    }
    if (!verdict.ok) {
      refuse(id, verdict.code, line);
      continue;
    }
    const rule: Rule = verdict.rule;
    if (rule.key === "forbidTerms") {
      const fresh = rule.terms.filter((t) => !terms.has(t));
      if (terms.size + fresh.length > MAX_TERMS) {
        refuse(id, "too-many-terms", line);
        continue;
      }
      for (const t of fresh) terms.add(t);
    } else if (rule.key === "forbidChars") {
      for (const n of rule.names) chars.add(n);
    } else {
      const value =
        rule.key === "headings" ? rule.style : rule.key === "buttonLabel" ? rule.label : rule.mask;
      const earlier = singles.get(rule.key);
      if (earlier !== undefined && earlier !== value) {
        refuse(id, "conflict", line);
        continue;
      }
      singles.set(rule.key, value);
    }
    understood.push({ line: id, rule: rule.key as RuleKey, says: describeRule(rule) });
  }

  const style = singles.get("headings");
  const label = singles.get("buttonLabel");
  const mask = singles.get("phoneFormat");
  const config: HouseConfig = {
    version: 1,
    ...(style === "sentence" || style === "title" ? { headings: { case: style } } : {}),
    ...(chars.size > 0
      ? { forbidChars: [...chars] as NonNullable<HouseConfig["forbidChars"]> }
      : {}),
    ...(terms.size > 0 ? { forbidTerms: [...terms] } : {}),
    ...(label !== undefined ? { buttonLabel: label } : {}),
    ...(mask !== undefined ? { phoneFormat: mask } : {}),
  };

  const u = listed(understood);
  const n = listed(notUnderstood);
  const r = listed(refused);
  const totals = {
    lines: lines.length,
    understood: understood.length,
    notUnderstood: notUnderstood.length,
    refused: refused.length,
  };
  return {
    // The schema is the last word: whatever the grammar did, the config is one gaugeline.house.json can hold.
    config: houseConfigSchema.parse(config),
    understood: u.kept,
    notUnderstood: n.kept,
    refused: r.kept,
    totals,
    omitted: { understood: u.omitted, notUnderstood: n.omitted, refused: r.omitted },
    summary: headline(totals.lines, totals.understood, totals.notUnderstood, totals.refused),
  };
}
