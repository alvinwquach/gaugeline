/**
 * Unified diffs of one file's text, and applying one back (X70). Pure functions on strings: no file is
 * read or written here. A fixer changes one place in one file, so the diff is one hunk found by trimming
 * the lines both versions share at the start and the end; that is exact for that case, needs no library
 * and gives the same bytes every time. Lines keep their own line endings, so a Windows file's carriage
 * returns survive a round trip.
 */

const CONTEXT = 3;
/**
 * A character that must not be in a path: a control character, DEL, a Unicode line break (a newline would write
 * extra header lines), or one that is invisible or reorders what is shown (a name could display as another):
 * soft hyphen, the Mongolian vowel separator, zero-width and direction marks U+200B-200F, U+2060-2064, bidi embeddings and isolates U+202A-202E and
 * U+2066-2069, the byte order mark, and the tag characters U+E0000-E007F.
 */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0xad ||
      c === 0x180e ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2060 && c <= 0x2064) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff ||
      (c >= 0xe0000 && c <= 0xe007f)
    )
      return true;
  }
  return false;
}
const MAX_PATH = 300;

/**
 * Whether `path` can be written in a diff header and is a path inside a repository: relative, forward slashes,
 * no control character (a newline, tab, CR or NUL would add header lines or hide text), no leading "-", no "." or
 * ".." or empty segment, and not longer than 300 characters. A path that fails is refused, never quoted.
 */
export function isSafeDiffPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= MAX_PATH &&
    !path.startsWith("-") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !hasControl(path) &&
    path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
  );
}
const NO_EOL = "\\ No newline at end of file";

/** The lines of `text`, each with its own "\n"; the last has none when the text does not end with one. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** One diff line for `line`, with the marker when it has no end of line. */
function diffLine(sign: " " | "+" | "-", line: string): string {
  return line.endsWith("\n") ? `${sign}${line}` : `${sign}${line}\n${NO_EOL}\n`;
}

/** The diff from `before` to `after` for the file at `path`; "" when they are the same text. */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  if (!isSafeDiffPath(path))
    throw new Error(
      "A diff needs a safe path: relative, with no control character, no leading -, no .. and no backslash.",
    );
  const a = splitLines(before);
  const b = splitLines(after);
  const max = Math.min(a.length, b.length);
  let head = 0;
  while (head < max && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const start = Math.max(0, head - CONTEXT);
  const lead = a.slice(start, head);
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const trail = a.slice(a.length - tail, a.length - tail + Math.min(tail, CONTEXT));
  const oldCount = lead.length + removed.length + trail.length;
  const newCount = lead.length + added.length + trail.length;
  // An empty side starts at the line before the hunk (0 at the top of the file), as git writes it.
  const oldStart = oldCount === 0 ? 0 : start + 1;
  const newStart = newCount === 0 ? 0 : start + 1;
  return [
    `--- a/${path}\n+++ b/${path}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`,
    ...lead.map((l) => diffLine(" ", l)),
    ...removed.map((l) => diffLine("-", l)),
    ...added.map((l) => diffLine("+", l)),
    ...trail.map((l) => diffLine(" ", l)),
  ].join("");
}

/**
 * Apply a diff made by unifiedDiff (or git) to `before`. Every context and removed line must be in the
 * file exactly where the hunk says; otherwise undefined, so a diff is never applied to text it was not
 * made from. Applying the same diff twice therefore fails the second time.
 */
export function applyDiff(before: string, diff: string): string | undefined {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const source = splitLines(before);
  const out: string[] = [];
  let at = 0;
  let seen = 0;
  let i = 0;
  while (i < lines.length && !lines[i]?.startsWith("@@")) {
    if (!/^(---|\+\+\+) /.test(lines[i] ?? "")) return undefined;
    i++;
  }
  while (i < lines.length) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[i] ?? "");
    if (!head) return undefined;
    const oldCount = Number(head[2] ?? "1");
    const first = oldCount === 0 ? Number(head[1]) : Number(head[1]) - 1;
    if (first < at || first > source.length) return undefined;
    out.push(...source.slice(at, first));
    at = first;
    i++;
    let used = 0;
    while (i < lines.length && !lines[i]?.startsWith("@@")) {
      const line = lines[i] ?? "";
      const sign = line[0];
      if (sign !== " " && sign !== "+" && sign !== "-") return undefined;
      // A "\ No newline" line after this one says the line has no end of line.
      const noEol = lines[i + 1] === NO_EOL;
      const content = noEol ? line.slice(1) : `${line.slice(1)}\n`;
      i += noEol ? 2 : 1;
      if (sign !== "+") {
        if (source[at] !== content) return undefined;
        at++;
        used++;
      }
      if (sign !== "-") out.push(content);
    }
    seen++;
    if (used !== oldCount) return undefined;
  }
  if (seen === 0) return undefined;
  out.push(...source.slice(at));
  return out.join("");
}
