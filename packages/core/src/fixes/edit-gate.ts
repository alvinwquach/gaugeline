/**
 * The gate in front of every automatic image edit (PERF-04). Reading a file's comments, strings and code well
 * enough to know what an `<img` means is a guessing game that a hostile or merely unusual file keeps winning, so
 * the fixer does not play it: a diff is made only when the file is so plain that nothing needs guessing, and every
 * other case is a reason and no diff for a person to read. All of these must hold:
 *   (a) the file is .html, .htm, .tsx or .jsx;
 *   (b) `<img` (any case) occurs exactly once in the whole file;
 *   (c) it starts its line, with only spaces or tabs before it;
 *   (d) nothing before it holds a comment opener or closer, a template or code-string opener, a backtick, an
 *       element whose text is not markup (script, style, noscript, template, pre, code, xmp, title, textarea,
 *       svg, math, picture), a `//` outside a plain http(s) address, an odd number of `"` or of `'` on a line, or,
 *       in .tsx and .jsx, any backslash.
 * The tag's own attributes are checked separately (plain attributes only, see image-tags.ts).
 */
import { MAX_SCANNED } from "./image-tags.js";

export const REVIEW_BY_HAND =
  "This file has comments, code strings or markup around the image that make an automatic edit unsafe, so it is left to a person: review by hand.";

const EXTENSION = /\.(html?|[tj]sx)$/i;
const JSX_FILE = /\.[tj]sx$/i;
const OPENERS =
  /<!--|\/\*|\*\/|\{#|\{\{!|`|<(?:script|style|noscript|template|pre|code|xmp|title|textarea|svg|math|picture)/i;
const URL_RUN = /https?:\/\/[^\s"'<>)]*/gi;

/** The count of `ch` in `line`. */
function count(line: string, ch: string): number {
  let n = 0;
  for (let i = line.indexOf(ch); i >= 0; i = line.indexOf(ch, i + 1)) n++;
  return n;
}

/**
 * Why the tag at `index` of `text` (a file called `path`) may not be edited automatically, or undefined when it
 * may. Linear in the size of the text: one scan to count `<img`, one over the text before the tag.
 */
export function editGate(text: string, path: string, index: number): string | undefined {
  if (!EXTENSION.test(path))
    return `The file ${path} is not a plain .html, .htm, .tsx or .jsx file, so the change is left to a person: review by hand.`;
  if (text.length > MAX_SCANNED) return REVIEW_BY_HAND;
  // (b) exactly once, in the whole file: a second `<img` may be a copy in a noscript, a comment or a string.
  const lower = text.toLowerCase();
  const first = lower.indexOf("<img");
  if (first !== index || lower.indexOf("<img", first + 4) >= 0) return REVIEW_BY_HAND;
  // (c) it starts its line.
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  if (!/^[ \t]*$/.test(text.slice(lineStart, index))) return REVIEW_BY_HAND;
  // (d) nothing before it is a context that changes what `<img` means.
  const before = text.slice(0, lineStart);
  if (OPENERS.test(before)) return REVIEW_BY_HAND;
  if (before.replace(URL_RUN, "").includes("//")) return REVIEW_BY_HAND;
  if (JSX_FILE.test(path) && before.includes("\\")) return REVIEW_BY_HAND;
  for (const line of before.split("\n"))
    if (count(line, '"') % 2 === 1 || count(line, "'") % 2 === 1) return REVIEW_BY_HAND;
  return undefined;
}
