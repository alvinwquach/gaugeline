/**
 * The words of a pull request, made safe for where they land (ADR-0010 part 8, N17). A draft's title and
 * body are prose an agent wrote and a person approved; they may quote a checked page, and a page can say
 * anything. Before they reach GitHub each line goes through core's `forMarkdown` (control and invisible
 * characters shown, `< > & [ ] ( ) # * _` and the other Markdown marks backslash-escaped, so there is no
 * raw HTML, no HTML comment, no link, no image, no heading), then three more rules:
 *
 * - an @-mention, a user's or a team's (`@name`, `@org/team`), becomes a code span, so nobody is notified;
 * - an issue or pull request reference (`#12`, `GH-12`, `owner/repo#12`), and an address after a closing
 *   keyword (`closes`, `fixes`, `resolves` and their forms), becomes a code span, so nothing is linked or
 *   closed by the merge;
 * - a `javascript:`, `vbscript:`, `data:` or `file:` address becomes a code span, so it is never a link.
 *
 * Every rule works on whole space-separated words of the escaped line, so there is one place to read.
 * A title is one line. The file contents of the pull request are not touched: they are the change itself.
 */
import { forMarkdown } from "@gaugeline/core";

/** forMarkdown cuts at this many characters per line; the payload schema allows 200 and 20 000. */
const TITLE_MAX = 1_000;
const LINE_MAX = 20_000;

const CLOSING_KEYWORD = /^(close[sd]?|fix(e[sd])?|resolve[sd]?):?$/i;
const SCHEME = /(^|[^a-z0-9])(javascript|vbscript|data|file):/i;
const REFERENCE = /(\\#\d|^gh-\d)/i;

/** The text a code span shows: the backslashes forMarkdown added are removed, and a backtick cannot end the span. */
function unescaped(word: string): string {
  return word.replace(/\\([\\`*_[\]()<>#~|&])/gu, "$1").replace(/`/gu, "'");
}

/** One escaped word, in a code span if any rule above says so. `after` is the word before it. */
function neutralWord(word: string, after: string): string {
  const keywordUrl = CLOSING_KEYWORD.test(after) && /^https?:\/\//i.test(word);
  if (word.includes("@") || REFERENCE.test(word) || SCHEME.test(word) || keywordUrl) {
    return `\`${unescaped(word)}\``;
  }
  return word;
}

/** Escape and neutralise lines of text. `after` carries the last word across lines. */
function lines(text: string, max: number): string {
  let after = "";
  return text
    .split("\n")
    .map((raw) => {
      const escaped = forMarkdown(raw, max) as string;
      if (escaped === "") return "";
      return escaped
        .split(" ")
        .map((word) => {
          const out = neutralWord(word, after);
          after = word;
          return out;
        })
        .join(" ");
    })
    .join("\n");
}

/** A pull request title: one line. */
export function prTitle(title: string): string {
  return lines(title.replace(/\s+/gu, " "), TITLE_MAX);
}

/** A pull request body: lines kept, each one escaped. */
export function prBody(body: string): string {
  return lines(body.replace(/\r\n?/gu, "\n"), LINE_MAX);
}
