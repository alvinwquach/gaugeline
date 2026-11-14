/**
 * The expressions that recognise invisible characters in text: flag emoji and zero-width
 * characters inside words. They live here, with no import, so the module that cleans text for
 * output (untrusted.ts) can use them without loading the HTML parser the hidden-text scan needs.
 * The scan re-exports them; nothing about them changed when they moved.
 */

/** Subdivision flags (England, Scotland, Wales) are a black flag, tag letters and a cancel tag. */
export const FLAG_SEQUENCE = /\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}/gu;
const WORD = "\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Nd}";
/**
 * A zero-width character (or a run of them) between two letters or digits of the scripts that
 * write words with spaces. Joiners in emoji, non-joiners in Persian and zero-width spaces in Thai
 * have other characters beside them. Sanity's stega puts its run at the end of a text, not inside.
 */
export const ZERO_WIDTH_IN_WORD = new RegExp(
  `([${WORD}])([\\u200B-\\u200D\\u2060-\\u2064\\u180E\\uFEFF]+)(?=[${WORD}])`,
  "gu",
);
