import { hashValue } from "../adapters/fingerprint.js";
import type { PageSnapshot } from "../snapshot.js";

/** At most this many pieces of a page's text are compared with a field. */
const CANDIDATE_CAP = 40;
/** A piece of text longer than this is not a title or a heading. */
const CANDIDATE_MAX_CHARS = 300;

const SEPARATORS = / [|\u2013\u2014\u00B7\u2022-] /;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const straight = (text: string): string =>
  text.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E]/g, '"');

/** Straight quotes as typographic ones, the way a page template that texturizes text writes them. */
const curly = (text: string): string =>
  text
    .replace(/(^|[\s([{])"/g, "$1\u201C")
    .replace(/"/g, "\u201D")
    .replace(/(^|[\s([{])'/g, "$1\u2018")
    .replace(/'/g, "\u2019");

const sentence = (text: string): string => {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const titleCase = (text: string): string =>
  text
    .toLowerCase()
    .replace(
      /(^|[\s(["'\u201C\u2018-])(\p{L})/gu,
      (_m, a: string, b: string) => `${a}${b.toUpperCase()}`,
    );

/**
 * The strings a CMS value could have been before a page showed `text`: the text itself, with its quotes
 * straightened or made typographic, in the case it has, lower, upper, as a sentence and as a title. A page
 * that shows a title in capitals (a template or a style rule) is still the same title. Entities need nothing
 * here: the page was parsed, so "&amp;" is already "&".
 */
export function variantsOf(text: string): string[] {
  const base = collapse(text);
  if (base === "") return [];
  const out = new Set<string>();
  for (const b of [base, straight(base), curly(straight(base))])
    for (const v of [b, b.toLowerCase(), b.toUpperCase(), sentence(b), titleCase(b)]) out.add(v);
  return [...out];
}

/** The pieces of a page that can show a field: the title and its parts around a site name, og:title and the headings. */
export function pageTexts(page: Pick<PageSnapshot, "title" | "og" | "headings">): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined): void => {
    const text = collapse(raw ?? "");
    if (text === "" || text.length > CANDIDATE_MAX_CHARS) return;
    out.add(text);
    for (const part of text.split(SEPARATORS)) {
      const t = collapse(part);
      if (t !== "") out.add(t);
    }
  };
  add(page.title);
  add(page.og["og:title"]);
  for (const h of page.headings) add(h.text);
  return [...out].slice(0, CANDIDATE_CAP);
}

/** The hashes a field's value could have if the page shows it: the same fingerprint the adapter made, over each variant. */
export function pageHashes(texts: readonly string[]): Set<string> {
  const hashes = new Set<string>();
  for (const t of texts)
    for (const v of variantsOf(t)) {
      const h = hashValue(v);
      if (h !== undefined) hashes.add(h);
    }
  return hashes;
}

/**
 * The configured fields whose fingerprint the page does not show. A field the item does not have is not
 * compared (the adapter leaves it out of `fieldHashes`). Names only: no text from the page or the CMS.
 */
export function differingFields(
  fieldHashes: Readonly<Record<string, string>>,
  fields: readonly string[],
  page: Pick<PageSnapshot, "title" | "og" | "headings">,
): string[] {
  const shown = pageHashes(pageTexts(page));
  return fields.filter((f) => {
    const wanted = fieldHashes[f];
    return wanted !== undefined && !shown.has(wanted);
  });
}
