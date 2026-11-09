import list from "./data/ai-directives.json";

/** One phrase that addresses an AI assistant, from packages/core/src/data/ai-directives.json. */
export interface AiDirective {
  /** The phrase as written in the data file. */
  text: string;
  /** "en" or "es" to start; the list grows without code changes. */
  lang: string;
}

export const AI_DIRECTIVES: readonly AiDirective[] = Object.freeze(
  (list.phrases as AiDirective[]).map((p) => Object.freeze({ ...p })),
);

/**
 * Characters a visitor cannot see: soft hyphen, Arabic letter mark, Mongolian vowel separator,
 * zero-width and directional marks, word joiner and invisible operators, the byte order mark and
 * the whole Unicode tag block.
 */
export const INVISIBLE =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
const TAG_BLOCK = /[\u{E0020}-\u{E007E}]/gu;

/** Tag characters stand for ASCII (U+E0000 plus the code): read them as the text they carry. */
export function decodeTags(text: string): string {
  return text.replace(TAG_BLOCK, (c) => String.fromCharCode((c.codePointAt(0) ?? 0) - 0xe0000));
}

/**
 * What the phrase list is matched against: tag characters decoded, the rest of the invisible
 * characters removed (attackers split phrases with them), full-width forms folded, accents
 * dropped, curly apostrophes straightened, lower case, whitespace collapsed to single spaces.
 */
export function normaliseForMatch(text: string): string {
  // A run of tag characters is read as its own words, so one glued to the text before it still matches.
  return text
    .replace(/[\u{E0000}-\u{E007F}]+/gu, (run) => ` ${decodeTags(run)} `)
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u02BC\u00B4`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const PHRASES: readonly { directive: AiDirective; needle: string }[] = AI_DIRECTIVES.map(
  (directive) => ({ directive, needle: normaliseForMatch(directive.text) }),
);

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * The first phrase in the list that the text contains as whole words, or undefined. "was an
 * assistant manager" does not contain "as an assistant".
 */
export function findDirective(text: string): AiDirective | undefined {
  const hay = normaliseForMatch(text);
  if (hay === "") return undefined;
  for (const { directive, needle } of PHRASES) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const before = hay[at - 1];
      const after = hay[at + needle.length];
      // A phrase ending in a symbol (": ") has no word edge to check on that side.
      const startsWord = isWordChar(needle[0]);
      const endsWord = isWordChar(needle.at(-1));
      if (!(startsWord && isWordChar(before)) && !(endsWord && isWordChar(after))) return directive;
      from = at + 1;
    }
  }
  return undefined;
}
