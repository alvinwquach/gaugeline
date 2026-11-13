/**
 * Reading a page against a site's house rules (HOUSE-01). The rules are the five kinds gaugeline.rules.json can
 * hold (see schema.ts); the page is the text a run has already fetched. Plain code: no model, no request, no
 * clock, and the same page and rules always give the same answer.
 *
 * Safe by construction. Nothing from the file becomes a pattern: a heading style is a closed choice, a forbidden
 * character is one of four named characters, a banned word is compared as a list of words, a button label is
 * compared as words, and a phone mask is compared character by character. The only regular expressions here are
 * fixed, anchored or linear, and run on text cut to a known length. The page text is data: it is shown only as a
 * short, escaped snippet, and a phone number is shown as its shape (`### ### ####`), never its digits.
 *
 * A rule that cannot be judged (no text was read, the text was cut, a heading has no upper or lower case) is
 * listed in `notChecked`, never counted as a pass.
 */
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { BUTTONS_MAX, VISIBLE_TEXT_MAX, type PageButton } from "../snapshot.js";
import {
  FORBIDDEN_CHARS,
  HOUSE_CONFIG_FILE,
  parseHouseConfig,
  type ForbiddenCharName,
  type HeadingCase,
  type HouseConfig,
} from "./schema.js";

/** What the reader needs of a page: a PageSnapshot has all of it. */
export interface HousePage {
  title?: string;
  headings: { level: 1 | 2 | 3; text: string }[];
  /** Absent: the page's buttons were not read. */
  buttons?: Pick<PageButton, "kind" | "text">[];
  /** Absent: the page's text was not read. */
  visibleText?: string;
}

export interface HouseHit {
  /** Where: "title", "h2 heading", "button", "link" or "page text". */
  element: string;
  /** A short piece of the text, escaped. For a phone number, its shape. */
  snippet: string;
}
export interface HouseViolation {
  /** "headings.case", "forbidChars.em-dash", "forbidTerms.<word>", "buttonLabel" or "phoneFormat". */
  rule: string;
  /** The rule in words, built from the rule and never from the page. */
  says: string;
  hits: HouseHit[];
}
export interface HouseNotChecked {
  /** "headings.case", "forbidChars", "forbidTerms", "buttonLabel" or "phoneFormat". */
  rule: string;
  reason: string;
}
export interface HouseReading {
  violations: HouseViolation[];
  notChecked: HouseNotChecked[];
}

/** The most elements one rule shows, and the longest snippet (before the ellipses that mark a cut). */
export const MAX_HITS_PER_RULE = 3;
export const SNIPPET_CHARS = 48;
/** Most headings read, and most characters read of one heading, button or the title. */
export const MAX_HEADINGS_READ = 200;
export const MAX_SOURCE_CHARS = 2000;
/** The longest run of digits and separators that can be a phone number. */
const MAX_PHONE_CHARS = 32;
/** Sentence case is broken when this many words after the first are capitals and none is lower case. */
const MIN_TITLE_CAPS = 3;

interface Source {
  element: string;
  text: string;
}

const WORD = /[\p{L}\p{N}']+/gu;
const LETTER = /\p{L}/u;
const GAP_OK = /^[\s-]{1,40}$/u;
const edge = /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/gu;

/** The text made comparable: compatibility forms (full-width letters, the ellipsis character) become plain. */
const plain = (text: string): string => text.normalize("NFKC").replace(/’/gu, "'");
const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * A short, escaped piece of `text` round the match at `index`, cut with an ellipsis on a side that was cut. Digits are
 * shown as #: a snippet can sit next to a phone number, and says where it is, not what it is.
 */
function around(text: string, index: number, length: number): string {
  const room = Math.max(0, SNIPPET_CHARS - length);
  const start = Math.max(0, Math.min(index - Math.floor(room / 2), text.length - SNIPPET_CHARS));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const piece = text.slice(start, end).replace(edge, "").replace(/\d/gu, "#").trim();
  const shown = escapeInvisible(piece, 4 * SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${shown}${end < text.length ? "…" : ""}`;
}
/** The start of `text`, for a rule that is about the whole element. */
const opening = (text: string): string => around(collapse(text), 0, 0);

/** Hits for one rule: the first in each element, at most MAX_HITS_PER_RULE, in the order the elements come. */
class Hits {
  readonly list: HouseHit[] = [];
  private readonly elements = new Set<string>();
  add(element: string, snippet: () => string): void {
    if (this.list.length >= MAX_HITS_PER_RULE || this.elements.has(element)) return;
    this.elements.add(element);
    this.list.push({ element, snippet: snippet() });
  }
  get found(): boolean {
    return this.list.length > 0;
  }
}

// --- headings -------------------------------------------------------------------------------------------------

/** Words a title may leave in lower case. A closed list: it is the style most guides use, and it is a choice. */
const SMALL_WORDS: ReadonlySet<string> = new Set(
  "a an and as at but by for from in into nor of on onto or over per the to up via vs with".split(
    " ",
  ),
);
type Kind = "none" | "uncased" | "neutral" | "cap" | "lower";

/** One word: no letters; letters with no case; case that says nothing (an acronym, iPhone, I); a capital; lower case. */
function kindOf(word: string): Kind {
  let letters = 0;
  let upper = 0;
  let lower = 0;
  let upperAfterFirst = 0;
  let firstUpper = false;
  for (const ch of word) {
    if (!LETTER.test(ch)) continue;
    const isUpper = ch !== ch.toLowerCase();
    const isLower = ch !== ch.toUpperCase();
    if (letters === 0) firstUpper = isUpper;
    else if (isUpper) upperAfterFirst++;
    letters++;
    if (isUpper) upper++;
    if (isLower) lower++;
  }
  if (letters === 0) return "none";
  if (upper === 0 && lower === 0) return "uncased";
  if (letters >= 2 && lower === 0) return "neutral";
  if (upperAfterFirst > 0) return "neutral";
  if (/^I(?:'|$)/u.test(word.replace(/^[^\p{L}\p{N}']+/u, ""))) return "neutral";
  return firstUpper ? "cap" : "lower";
}
const core = (word: string): string => word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

/** "ok", "bad" (breaks the style), "unclear" (letters with no case) or "skip" (no letters). */
function judgeHeading(text: string, style: HeadingCase): "ok" | "bad" | "unclear" | "skip" {
  const words = text.split(/\s+/u).filter((w) => w !== "");
  const kinds = words.map(kindOf);
  if (kinds.every((k) => k === "none")) return "skip";
  if (kinds.every((k) => k === "none" || k === "uncased")) return "unclear";
  const first = kinds.findIndex((k) => k !== "none");
  if (kinds[first] === "lower") return "bad";
  let caps = 0;
  let lowers = 0;
  for (let i = first + 1; i < words.length; i++) {
    const word = words[i] ?? "";
    const kind = kinds[i];
    if (kind !== "cap" && kind !== "lower") continue;
    if (SMALL_WORDS.has(core(word).toLowerCase())) continue;
    // Sentence case: the word after a full stop, question or exclamation mark, or a colon, starts a sentence.
    if (style === "sentence" && /[.!?:]$/u.test(words[i - 1] ?? "")) continue;
    if (kind === "cap") caps++;
    else lowers++;
  }
  if (style === "title") return lowers > 0 ? "bad" : "ok";
  // A name looks like a capital in the middle of a sentence ("Wickham Lane Bakery"), so only a heading with every
  // other word in capitals, and at least three of them, is called title case.
  return caps >= MIN_TITLE_CAPS && lowers === 0 ? "bad" : "ok";
}

// --- characters, words, buttons, phone numbers ---------------------------------------------------------------

/** The text a forbidden character can show as, once the text is made plain (the ellipsis character becomes ...). */
const FORMS: Readonly<Record<ForbiddenCharName, readonly string[]>> = {
  "em-dash": [FORBIDDEN_CHARS["em-dash"]],
  "en-dash": [FORBIDDEN_CHARS["en-dash"]],
  exclamation: [FORBIDDEN_CHARS.exclamation],
  ellipsis: [FORBIDDEN_CHARS.ellipsis, "..."],
};

interface Tok {
  word: string;
  start: number;
  end: number;
}
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(WORD))
    out.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}
const wordsOf = (text: string): string[] => plain(text).toLowerCase().match(WORD) ?? [];

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isRunChar = (c: number): boolean =>
  isDigit(c) || c === 32 || c === 43 || c === 40 || c === 41 || c === 46 || c === 45;
const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const AFTER_MONEY = new Set(["£", "$", "€", "¥", "₹", "#"]);

function looksLikeDate(candidate: string): boolean {
  const parts = candidate.split(/[-.]/u);
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,4}$/u.test(p))) return false;
  const [a = 0, b = 0, c = 0] = parts.map((p) => p.length);
  return (a === 4 && b <= 2 && c <= 2) || (a <= 2 && b <= 2 && c === 4);
}

/** The shape of the first number in `text` that has the mask's digits in another shape, or undefined. */
function oddPhone(text: string, mask: string, digits: number): string | undefined {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isRunChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isRunChar(text.charCodeAt(j))) j++;
    let s = i;
    let e = j;
    const startsNumber = (k: number): boolean => {
      const c = text.charCodeAt(k);
      return isDigit(c) || ((c === 43 || c === 40) && k + 1 < e && isDigit(text.charCodeAt(k + 1)));
    };
    while (s < e && !startsNumber(s)) s++;
    while (e > s && !isDigit(text.charCodeAt(e - 1)) && text.charCodeAt(e - 1) !== 41) e--;
    const before = s > 0 ? text[s - 1] : undefined;
    const after = e < n ? text[e] : undefined;
    if (
      e - s > 0 &&
      e - s <= MAX_PHONE_CHARS &&
      !isWordChar(before) &&
      !(before !== undefined && AFTER_MONEY.has(before)) &&
      !isWordChar(after) &&
      after !== "%"
    ) {
      const candidate = text.slice(s, e);
      const shape = candidate.replace(/\d/gu, "#");
      if (shape.split("#").length - 1 === digits && !looksLikeDate(candidate) && shape !== mask)
        return shape;
    }
    i = j;
  }
  return undefined;
}

// --- the reader -----------------------------------------------------------------------------------------------

function sourcesOf(page: HousePage): Source[] {
  const cut = (t: string): string => t.slice(0, MAX_SOURCE_CHARS);
  const sources: Source[] = [];
  if (page.title) sources.push({ element: "title", text: plain(cut(page.title)) });
  for (const hd of page.headings.slice(0, MAX_HEADINGS_READ))
    sources.push({ element: `h${hd.level} heading`, text: plain(cut(hd.text)) });
  for (const b of (page.buttons ?? []).slice(0, BUTTONS_MAX))
    sources.push({ element: b.kind === "a" ? "link" : "button", text: plain(cut(b.text)) });
  if (page.visibleText !== undefined)
    sources.push({
      element: "page text",
      text: plain(page.visibleText.slice(0, VISIBLE_TEXT_MAX)),
    });
  return sources;
}

/** The first run of `needle` words inside `haystack` words, or false. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++)
    if (needle.every((w, k) => haystack[i + k] === w)) return true;
  return false;
}

/**
 * Reads `page` against `config`. The config is checked against the same schema the file is (a pattern, a path or
 * an unknown key throws a ConfigError), so no caller can hand this a pattern. Violations come in a fixed order:
 * headings, characters, words, button, phone, each in the order the file lists them.
 */
export function readHouseRules(config: HouseConfig, page: HousePage): HouseReading {
  const rules = parseHouseConfig(config, HOUSE_CONFIG_FILE);
  const violations: HouseViolation[] = [];
  const notChecked: HouseNotChecked[] = [];
  const sources = sourcesOf(page);
  const textCut = (page.visibleText?.length ?? 0) >= VISIBLE_TEXT_MAX;
  const buttonsCut = (page.buttons?.length ?? 0) >= BUTTONS_MAX;
  const nothingIn = (what: string): string =>
    `the page's ${what} was cut at ${(what === "text" ? VISIBLE_TEXT_MAX : BUTTONS_MAX).toLocaleString("en-US")}${what === "text" ? " characters" : ""}, and none of what was read broke the rule`;

  /** A family of rules that read the page's text: could not check when the text is missing or cut, and found nothing. */
  const textUnchecked = (rule: string, found: boolean): void => {
    if (found) return;
    if (page.visibleText === undefined)
      notChecked.push({ rule, reason: "the page's text was not read" });
    else if (textCut) notChecked.push({ rule, reason: nothingIn("text") });
  };

  if (rules.headings) {
    const style = rules.headings.case;
    const hits = new Hits();
    let unclear = 0;
    for (const hd of page.headings.slice(0, MAX_HEADINGS_READ)) {
      const text = collapse(hd.text.slice(0, MAX_SOURCE_CHARS));
      const verdict = judgeHeading(text, style);
      if (verdict === "bad") hits.add(`h${hd.level} heading`, () => opening(text));
      else if (verdict === "unclear") unclear++;
    }
    if (hits.found)
      violations.push({
        rule: "headings.case",
        says: `headings are in ${style} case`,
        hits: hits.list,
      });
    else if (unclear > 0)
      notChecked.push({
        rule: "headings.case",
        reason: `${unclear} ${unclear === 1 ? "heading has" : "headings have"} letters with no upper or lower case, so ${unclear === 1 ? "its" : "their"} case cannot be judged`,
      });
  }

  if (rules.forbidChars) {
    let any = false;
    for (const name of rules.forbidChars) {
      const hits = new Hits();
      for (const s of sources) {
        let at = -1;
        let len = 0;
        for (const form of FORMS[name]) {
          const i = s.text.indexOf(form);
          if (i >= 0 && (at < 0 || i < at)) {
            at = i;
            len = form.length;
          }
        }
        if (at >= 0) hits.add(s.element, () => around(s.text, at, len));
      }
      if (hits.found) {
        any = true;
        violations.push({
          rule: `forbidChars.${name}`,
          says: `no ${name.replace("-", " ")}`,
          hits: hits.list,
        });
      }
    }
    textUnchecked("forbidChars", any);
  }

  if (rules.forbidTerms) {
    // Each word becomes a list of lower-case words, and is found by its first word in a Map: no pattern is built.
    const byFirst = new Map<string, { index: number; rest: string[] }[]>();
    rules.forbidTerms.forEach((term, index) => {
      const [first, ...rest] = wordsOf(term);
      if (first === undefined) return;
      byFirst.set(first, [...(byFirst.get(first) ?? []), { index, rest }]);
    });
    const hits = rules.forbidTerms.map(() => new Hits());
    for (const s of sources) {
      const toks = tokens(s.text);
      toks.forEach((t, at) => {
        for (const cand of byFirst.get(t.word) ?? []) {
          const h = hits[cand.index];
          if (!h) continue;
          let last = t;
          const whole = cand.rest.every((w, k) => {
            const next = toks[at + 1 + k];
            if (next?.word !== w || !GAP_OK.test(s.text.slice(last.end, next.start))) return false;
            last = next;
            return true;
          });
          if (whole) h.add(s.element, () => around(s.text, t.start, last.end - t.start));
        }
      });
    }
    let any = false;
    rules.forbidTerms.forEach((term, index) => {
      const h = hits[index];
      if (!h?.found) return;
      any = true;
      violations.push({ rule: `forbidTerms.${term}`, says: `never use "${term}"`, hits: h.list });
    });
    textUnchecked("forbidTerms", any);
  }

  if (rules.buttonLabel !== undefined) {
    const label = rules.buttonLabel;
    const want = wordsOf(label);
    const hits = new Hits();
    for (const b of (page.buttons ?? []).slice(0, BUTTONS_MAX)) {
      const text = collapse(b.text.slice(0, MAX_SOURCE_CHARS));
      if (text === label) continue;
      const have = wordsOf(text).slice(0, 60);
      const same = have.length === want.length && want.every((w, i) => have[i] === w);
      // A link is only recognised as the label when it differs in capitals or punctuation: a menu link that
      // starts with the same words is not a button that should say the label.
      if (same || (b.kind !== "a" && want.length > 0 && containsRun(have, want)))
        hits.add(b.kind === "a" ? "link" : "button", () => opening(text));
    }
    if (hits.found)
      violations.push({
        rule: "buttonLabel",
        says: `buttons say "${label}"`,
        hits: hits.list,
      });
    else if (page.buttons === undefined)
      notChecked.push({ rule: "buttonLabel", reason: "the page's buttons were not read" });
    else if (buttonsCut) notChecked.push({ rule: "buttonLabel", reason: nothingIn("buttons") });
  }

  if (rules.phoneFormat !== undefined) {
    const mask = rules.phoneFormat;
    const digits = mask.split("#").length - 1;
    const hits = new Hits();
    for (const s of sources) {
      const shape = oddPhone(s.text, mask, digits);
      if (shape !== undefined) hits.add(s.element, () => shape);
    }
    if (hits.found)
      violations.push({
        rule: "phoneFormat",
        says: `phone numbers look like ${mask}`,
        hits: hits.list,
      });
    textUnchecked("phoneFormat", hits.found);
  }

  return { violations, notChecked };
}
