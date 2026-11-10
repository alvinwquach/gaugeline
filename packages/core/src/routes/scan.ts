/**
 * A source file read as plain text, with no compiler: comments taken out and the inside of every
 * string blanked, so a call is found in code and never in a comment or a sentence. Pure; it opens
 * nothing. TypeScript is an optional dependency of Gaugeline and this check does not need it.
 *
 * It is a scanner, not a parser. A regular expression literal that holds a quote, or an apostrophe
 * in JSX text, can end a string early; a quote ends at the end of its line, so one slip stays on
 * one line.
 */

export interface Scanned {
  /** The file with comments removed and the inside of strings and templates blanked. Quotes stay. */
  code: string;
  /** The file with only comments removed: strings keep their text. */
  uncommented: string;
  /** The text inside each quoted string (not templates), in order. */
  strings: string[];
}

export function scanSource(text: string): Scanned {
  let code = "";
  let uncommented = "";
  const strings: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      // Keep the line breaks so lines stay lines.
      const breaks = (text.slice(i, stop).match(/\n/g) ?? []).join("");
      code += breaks;
      uncommented += breaks;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let body = "";
      while (j < n && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\" && j + 1 < n && text[j + 1] !== "\n") {
          body += text[j + 1];
          j += 2;
        } else {
          body += text[j];
          j += 1;
        }
      }
      const closed = text[j] === c;
      strings.push(body);
      code += `${c}${closed ? c : ""}`;
      uncommented += text.slice(i, closed ? j + 1 : j);
      i = closed ? j + 1 : j;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, n);
      const breaks = (text.slice(i, stop).match(/\n/g) ?? []).join("");
      code += `\`\`${breaks}`;
      uncommented += text.slice(i, stop);
      i = stop;
      continue;
    }
    code += c;
    uncommented += c;
    i += 1;
  }
  return { code, uncommented, strings };
}

/**
 * The names of the calls that read who is signed in. A list, so a config file can extend it later:
 * a helper with another name is not found.
 */
export const SESSION_HELPERS: readonly string[] = Object.freeze([
  "auth",
  "getServerSession",
  "cookies",
  "currentUser",
]);

/**
 * The first session helper the code calls, as written (`auth`, `getServerSession`), or undefined.
 * A name after a dot is another object's method, and a declaration (`function auth(`) is not a call.
 */
export function findSessionHelper(code: string, helpers: readonly string[] = SESSION_HELPERS) {
  const names = helpers.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![\\w$.])(${names})\\s*(?:<[^<>()]*>)?\\s*\\(`, "g");
  for (const m of code.matchAll(re)) {
    const before = code.slice(0, m.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;
    return m[1];
  }
  return undefined;
}
