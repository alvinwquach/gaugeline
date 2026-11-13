/**
 * Unified diffs of one file's text, and applying one back (X70). Pure functions on strings: no file is
 * read or written here. A fixer changes one place in one file, so the diff is one hunk found by trimming
 * the lines both versions share at the start and the end; that is exact for that case, needs no library
 * and gives the same bytes every time. Lines keep their own line endings, so a Windows file's carriage
 * returns survive a round trip.
 */

const CONTEXT = 3;
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
