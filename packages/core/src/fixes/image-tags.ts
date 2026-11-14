/**
 * Finding an <img> tag in a project file, and reading it, without a regular expression over the file's text
 * (PERF-04, review). A tag is found by a single left-to-right pass that skips what is not markup (comments,
 * template literals, <script>, <style>, <pre>, <code>, markdown code) and reads each opening tag one
 * attribute at a time, tracking quotes, so an `>` inside `onLoad={() => go()}` or `alt="a > b"` is never taken for
 * the end of the tag. The pass is linear: no backtracking, and a tag is read for at most MAX_TAG characters.
 *
 * A tag is changed only if it is made of plain attributes: `name="value"`, `name='value'`, `name=value` or a bare
 * `name`. Anything else (a `{` expression, a `<` or `>` inside a value, a framework directive, a tag the pass
 * cannot read to its end) is not guessed at: the tag is reported with the reason, and no diff is made from it.
 */

/** The most characters of one tag that are read. A longer tag is not read at all. */
export const MAX_TAG = 4_000;
/** The most characters of a file that are read. */
export const MAX_SCANNED = 1_000_000;

export type ScanMode = "html" | "jsx" | "hybrid" | "markdown";

/** The way to read a file, from its name: markup, JSX, a mix (Astro, Vue, Svelte) or Markdown. */
export function modeOf(path: string): ScanMode {
  if (/\.[cm]?[jt]sx$/i.test(path)) return "jsx";
  if (/\.(astro|vue|svelte)$/i.test(path)) return "hybrid";
  if (/\.mdx?$/i.test(path)) return "markdown";
  return "html";
}

export interface Attribute {
  /** As written. Compare with toLowerCase(): HTML names do not depend on case. */
  name: string;
  /** The text between the quotes, or the bare value; null for an attribute with no value. */
  value: string | null;
  /** Where the name starts and where the attribute ends, in the tag's own text. */
  start: number;
  end: number;
}
export interface ReadTag {
  /** One past the `>` of the tag, in the text it was read from. */
  end: number;
  selfClosing: boolean;
  attributes: Attribute[];
  /** Where the tag name ends (just after `<img`). */
  nameEnd: number;
}
export type TagRead = { ok: true; tag: ReadTag } | { ok: false; reason: string };

const CODE = {
  tab: 9,
  lf: 10,
  ff: 12,
  cr: 13,
  space: 32,
} as const;
const isSpace = (c: number): boolean =>
  c === CODE.space || c === CODE.tab || c === CODE.lf || c === CODE.cr || c === CODE.ff;

const REASON = {
  expression:
    "The image tag holds a { } expression or template code, not only plain attributes, so what it loads and how is not certain.",
  angle:
    "The image tag has a < or > inside it (in an attribute value, say), so where the tag ends is not certain.",
  framework:
    "The image tag has an attribute written in a framework's own syntax (a binding or a directive), not plain HTML.",
  unreadable: "The image tag could not be read to its end with certainty.",
  long: `The image tag is longer than ${MAX_TAG} characters, so it is not read.`,
} as const;

/** Attribute names that are code in some framework, not plain attributes. */
const FRAMEWORK_NAME = /^(?:v-|x-|ng-|wire:|hx-|@|:|#|\*|\[|\()/;
/** A plain attribute name: letters, digits and the few punctuation marks HTML names use, starting with a letter. */
const PLAIN_NAME = /^[A-Za-z_][-A-Za-z0-9_.:]*$/;

/**
 * Read the opening tag that starts at `text[at]` (which is `<`, followed by `img`). Reads at most MAX_TAG
 * characters. Returns the attributes with their places, or the reason the tag is not read.
 */
export function readTag(text: string, at: number): TagRead {
  const limit = Math.min(text.length, at + MAX_TAG);
  const bad = (reason: string): TagRead => ({ ok: false, reason });
  // Running out of text at the cap is "too long"; running out of the file's own text is "not read to its end".
  const atEnd = (): TagRead => bad(at + MAX_TAG < text.length ? REASON.long : REASON.unreadable);
  let j = at + 4;
  const attributes: Attribute[] = [];
  for (;;) {
    while (j < limit && isSpace(text.charCodeAt(j))) j++;
    if (j >= limit) return atEnd();
    const c = text[j];
    if (c === ">")
      return { ok: true, tag: { end: j + 1, selfClosing: false, attributes, nameEnd: at + 4 } };
    if (c === "/") {
      if (text[j + 1] === ">")
        return { ok: true, tag: { end: j + 2, selfClosing: true, attributes, nameEnd: at + 4 } };
      return bad(REASON.unreadable);
    }
    if (c === "{" || c === "}") return bad(REASON.expression);
    if (c === "<") return bad(REASON.angle);
    // The name runs to a space, "=", ">", "/" or a quote.
    const nameStart = j;
    while (j < limit) {
      const d = text.charCodeAt(j);
      if (isSpace(d) || d === 61 /* = */ || d === 62 /* > */ || d === 47 /* / */) break;
      if (d === 34 || d === 39 || d === 96 || d === 123 || d === 125 || d === 60) break;
      j++;
    }
    const name = text.slice(nameStart, j);
    if (name === "") return bad(REASON.unreadable);
    if (FRAMEWORK_NAME.test(name)) return bad(REASON.framework);
    if (!PLAIN_NAME.test(name)) return bad(REASON.unreadable);
    let k = j;
    while (k < limit && isSpace(text.charCodeAt(k))) k++;
    if (text[k] !== "=") {
      attributes.push({ name, value: null, start: nameStart - at, end: j - at });
      continue;
    }
    k++;
    while (k < limit && isSpace(text.charCodeAt(k))) k++;
    const q = text[k];
    if (k >= limit) return atEnd();
    if (q === '"' || q === "'") {
      let m = k + 1;
      while (m < limit && text[m] !== q) m++;
      if (m >= limit) return atEnd();
      const value = text.slice(k + 1, m);
      if (value.includes("{") || value.includes("}")) return bad(REASON.expression);
      if (value.includes(">") || value.includes("<")) return bad(REASON.angle);
      attributes.push({ name, value, start: nameStart - at, end: m + 1 - at });
      j = m + 1;
      continue;
    }
    if (q === "{") return bad(REASON.expression);
    let m = k;
    while (m < limit && !isSpace(text.charCodeAt(m)) && text[m] !== ">") m++;
    const value = text.slice(k, m);
    if (value === "") return bad(REASON.unreadable);
    if (/["'=<`{}]/.test(value)) return bad(/[{}]/.test(value) ? REASON.expression : REASON.angle);
    // `src=/a.jpg/>` could mean a value that ends in a slash or a self-closing tag: not guessed.
    if (value.endsWith("/") && text[m] === ">") return bad(REASON.unreadable);
    attributes.push({ name, value, start: nameStart - at, end: m - at });
    j = m;
  }
}

/** What one `<img` in a file turned out to be. */
export interface FoundTag {
  index: number;
  /** The tag's text when it was read; otherwise the start of it, for display only. */
  text: string;
  read: TagRead;
}

const BODIES = ["script", "style", "pre", "code", "textarea"] as const;
const lower = (c: number): number => c | 0x20;

/** Does the name (ASCII, lower case) start at text[at], in any case, and end at a space, "/" or ">"? */
function nameAt(text: string, at: number, name: string): boolean {
  for (let n = 0; n < name.length; n++) {
    const c = text.charCodeAt(at + n);
    if (Number.isNaN(c) || lower(c) !== name.charCodeAt(n)) return false;
  }
  const after = text.charCodeAt(at + name.length);
  return Number.isNaN(after) || isSpace(after) || after === 47 || after === 62;
}

/** The index of `</name` (any case) at or after `from`, or -1. Linear: each `</` is looked at once. */
function closeOf(text: string, from: number, name: string): number {
  let i = text.indexOf("</", from);
  while (i >= 0) {
    if (nameAt(text, i + 2, name)) return i;
    i = text.indexOf("</", i + 2);
  }
  return -1;
}

/** One past the end of the template literal that starts at the backtick `text[at]`; the end of the text if it never ends. */
function skipTemplate(text: string, at: number): number {
  // Frames: a template (-1) or a ${ } expression (its open-brace depth). A template can hold an expression that
  // holds a template, so the stack is what says which one a backtick or a brace belongs to.
  const stack: number[] = [-1];
  let j = at + 1;
  while (j < text.length) {
    const top = stack[stack.length - 1]!;
    const c = text[j];
    if (top === -1) {
      if (c === "\\") j += 2;
      else if (c === "`") {
        stack.pop();
        j++;
        if (stack.length === 0) return j;
      } else if (c === "$" && text[j + 1] === "{") {
        stack.push(1);
        j += 2;
      } else j++;
    } else {
      if (c === "{") stack[stack.length - 1] = top + 1;
      else if (c === "}") {
        if (top === 1) stack.pop();
        else stack[stack.length - 1] = top - 1;
      } else if (c === "`") stack.push(-1);
      j++;
    }
  }
  return text.length;
}

/**
 * The <img> tags of `text`, each read or refused with its reason. Skips comments, template literals, the bodies
 * of <script>, <style>, <pre>, <code> and <textarea>, and markdown code, so a tag that is only shown or only
 * commented out is never taken for one the page uses. A tag whose name continues (`<img-zoom`) is not an <img>.
 */
export function scanImageTags(source: string, mode: ScanMode): FoundTag[] {
  const text = source.length > MAX_SCANNED ? source.slice(0, MAX_SCANNED) : source;
  const n = text.length;
  const code = mode === "jsx" || mode === "hybrid";
  const out: FoundTag[] = [];
  // The quote the current line is inside, in code: a tag inside a string is a string, not a tag.
  let quote = "";
  let nextNewline = -1;
  let i = 0;
  if (mode === "markdown") {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(0, 16));
    if (f) i = skipFence(text, 0, f[1]!);
  }
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      quote = "";
      i++;
      if (mode === "markdown") {
        const f = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, i + 16));
        if (f) i = skipFence(text, i, f[1]!);
      }
      continue;
    }
    if (c === 60 /* < */) {
      if (text.startsWith("<!--", i)) {
        const e = text.indexOf("-->", i + 4);
        i = e < 0 ? n : e + 3;
        continue;
      }
      let skipped = false;
      for (const b of BODIES)
        if (nameAt(text, i + 1, b)) {
          const e = closeOf(text, i + 1 + b.length, b);
          i = e < 0 ? n : e;
          skipped = true;
          break;
        }
      if (skipped) continue;
      const isImg =
        mode === "jsx"
          ? text.startsWith("<img", i) && /[\s/>]/.test(text[i + 4] ?? "x")
          : nameAt(text, i + 1, "img");
      if (isImg && quote === "") {
        const read = readTag(text, i);
        out.push({ index: i, text: text.slice(i, read.ok ? read.tag.end : i + 120), read });
        i = read.ok ? read.tag.end : i + 4;
        continue;
      }
      i++;
      continue;
    }
    if (code) {
      if (c === 47 /* / */ && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (c === 47 && text[i + 1] === "/" && (i === 0 || isSpace(text.charCodeAt(i - 1)))) {
        const e = text.indexOf("\n", i);
        i = e < 0 ? n : e;
        continue;
      }
      if (c === 96 /* ` */) {
        i = skipTemplate(text, i);
        continue;
      }
      if (c === 34 || c === 39) {
        const ch = text[i]!;
        if (quote === "") quote = ch;
        else if (quote === ch && text[i - 1] !== "\\") quote = "";
      }
    }
    if (mode === "markdown" && c === 96) {
      const e = text.indexOf("`", i + 1);
      // The next end of line, found once and kept until the scan passes it (a search per backtick would be quadratic).
      if (nextNewline <= i)
        nextNewline = text.indexOf("\n", i + 1) < 0 ? n : text.indexOf("\n", i + 1);
      if (e >= 0 && e < nextNewline) {
        i = e + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** One past the closing fence of the code block whose opening fence is on the line starting at `at`. */
function skipFence(text: string, at: number, fence: string): number {
  const mark = fence[0]!;
  let i = text.indexOf("\n", at);
  while (i >= 0 && i < text.length) {
    const line = i + 1;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(line, line + 16));
    if (f && f[1]![0] === mark && f[1]!.length >= fence.length) {
      const e = text.indexOf("\n", line);
      return e < 0 ? text.length : e;
    }
    i = text.indexOf("\n", line);
  }
  return text.length;
}
