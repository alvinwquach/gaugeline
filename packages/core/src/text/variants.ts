/**
 * British and American spellings of one word, so a slug in one and a heading in the other is not
 * a misspelling. Hand-kept on purpose: every excused pair is a line someone chose. "credentialling"
 * is not here: the heading's "credentialing" is the spelling the plan uses.
 */
export const SPELLING_VARIANTS: readonly (readonly [string, string])[] = Object.freeze([
  ["analyse", "analyze"],
  ["behaviour", "behavior"],
  ["cancelled", "canceled"],
  ["cannibalisation", "cannibalization"],
  ["catalogue", "catalog"],
  ["centre", "center"],
  ["colour", "color"],
  ["defence", "defense"],
  ["favourite", "favorite"],
  ["labelling", "labeling"],
  ["licence", "license"],
  ["modelling", "modeling"],
  ["optimisation", "optimization"],
  ["optimise", "optimize"],
  ["organisation", "organization"],
  ["prioritise", "prioritize"],
  ["programme", "program"],
  ["specialise", "specialize"],
  ["travelling", "traveling"],
  ["utilise", "utilize"],
]);

const PAIRS = new Set(SPELLING_VARIANTS.flatMap(([a, b]) => [`${a} ${b}`, `${b} ${a}`]));

/** True when the two words are a listed British/American pair. */
export function isSpellingVariant(a: string, b: string): boolean {
  return PAIRS.has(`${a} ${b}`);
}
