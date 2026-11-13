import { sourcePaths } from "../../local-source/read.js";
import type { LocalSourceInput } from "../../local-source/run.js";

/**
 * What the static checks share (batch FF): a small scanner over the text of a code file, and the
 * way they find the files that matter. It is not a parser. It blanks comments and string text so a
 * rule can look at the shape of the code (a call, a condition, a comparison) without being fooled
 * by a sentence in a comment or a word in a string, and it reads nothing but text: no file is run,
 * imported or evaluated. The same text gives the same answer (rule 7).
 */

/** A code file the checks read: JavaScript or TypeScript, not a test and not a type declaration. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const NOT_SOURCE =
  /(?:^|\/)(?:__tests__|__mocks__|e2e|tests?)\/|\.(?:test|spec)\.[^/]+$|\.d\.[cm]?ts$/i;

export function codePaths(input: LocalSourceInput): string[] {
  return sourcePaths(input.tree, (p) => CODE_FILE.test(p) && !NOT_SOURCE.test(p));
}

/**
 * A code file's text in two forms of the same length, so a position in one is the same position in
 * the other and a line number can be taken from either:
 * - `code`: comments blanked (newlines kept); string text kept, for reading an import path or a header name;
 * - `bare`: comments and the text of strings blanked (the quotes stay), and the `${...}` parts of a
 *   template string kept, so a word inside a string is never mistaken for code.
 */
export interface Scanned {
  code: string;
  bare: string;
}

type Mode = "code" | "sq" | "dq" | "tpl";
interface Frame {
  mode: Mode;
  /** In a `${ }` inside a template: how many braces are open in it. */
  depth: number;
}

export function scanSource(text: string): Scanned {
  const code: string[] = [];
  const bare: string[] = [];
  const blank = (c: string): string => (c === "\n" || c === "\r" ? c : " ");
  const stack: Frame[] = [{ mode: "code", depth: 0 }];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const n = text[i + 1] ?? "";
    const top = stack[stack.length - 1] as Frame;
    if (top.mode === "code") {
      if (c === "/" && n === "/") {
        while (i < text.length && text[i] !== "\n") {
          code.push(" ");
          bare.push(" ");
          i++;
        }
        i--;
        continue;
      }
      if (c === "/" && n === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end < 0 ? text.length : end + 2;
        for (; i < stop; i++) {
          const b = blank(text[i] ?? "");
          code.push(b);
          bare.push(b);
        }
        i--;
        continue;
      }
      if (c === "'" || c === '"') {
        stack.push({ mode: c === "'" ? "sq" : "dq", depth: 0 });
      } else if (c === "`") {
        stack.push({ mode: "tpl", depth: 0 });
      } else if (c === "{") {
        top.depth++;
      } else if (c === "}" && top.depth === 0 && stack.length > 1) {
        stack.pop(); // the end of a ${ } inside a template string
      } else if (c === "}") {
        top.depth--;
      }
      code.push(c);
      bare.push(c);
      continue;
    }
    // Inside a string.
    if (c === "\\") {
      code.push(c, n);
      bare.push(" ", blank(n));
      i++;
      continue;
    }
    const quote = top.mode === "sq" ? "'" : top.mode === "dq" ? '"' : "`";
    if (c === quote) {
      stack.pop();
      code.push(c);
      bare.push(c);
      continue;
    }
    if (top.mode === "tpl" && c === "$" && n === "{") {
      stack.push({ mode: "code", depth: 0 });
      code.push("$", "{");
      bare.push("$", "{");
      i++;
      continue;
    }
    if (top.mode !== "tpl" && c === "\n") {
      stack.pop(); // an unclosed quote ends at the line, so one stray quote cannot swallow the file
      code.push(c);
      bare.push(c);
      continue;
    }
    code.push(c);
    bare.push(blank(c));
  }
  return { code: code.join(""), bare: bare.join("") };
}

/** The 1-based line of a position. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

const CLOSERS: Readonly<Record<string, string>> = { "(": ")", "{": "}", "[": "]" };

/** The index of the bracket that closes the one at `open` (in `bare`), or -1 when it never closes. */
export function closeOf(bare: string, open: number): number {
  const want = CLOSERS[bare[open] ?? ""];
  if (want === undefined) return -1;
  const kind = bare[open] as string;
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    const c = bare[i];
    if (c === kind) depth++;
    else if (c === want && --depth === 0) return i;
  }
  return -1;
}

/**
 * The statement a condition guards: the `{ }` block after it, or the one statement that follows (up to
 * its `;`, or the end of its line). `after` is the index just past the condition's closing `)`.
 */
export function guarded(bare: string, after: number): string {
  let i = after;
  while (i < bare.length && /\s/.test(bare[i] ?? "")) i++;
  if (bare[i] === "{") {
    const end = closeOf(bare, i);
    return bare.slice(i, end < 0 ? bare.length : end + 1);
  }
  let end = i;
  while (end < bare.length && bare[end] !== ";" && bare[end] !== "\n") end++;
  return bare.slice(i, end);
}

/** Every `if (...)` in `bare`: its condition text, where it starts, and the statement it guards. */
export function conditions(
  bare: string,
): { cond: string; index: number; body: string; bodyIndex: number }[] {
  const out: { cond: string; index: number; body: string; bodyIndex: number }[] = [];
  const re = /\bif\s*\(/g;
  for (let m = re.exec(bare); m !== null; m = re.exec(bare)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(bare, open);
    if (close < 0) continue;
    const body = guarded(bare, close + 1);
    out.push({
      cond: bare.slice(open + 1, close),
      index: m.index,
      body,
      bodyIndex: bare.indexOf(body, close + 1),
    });
  }
  return out;
}

/** A file a check may call a webhook receiver, with its text in both forms. */
export interface HandlerFile {
  path: string;
  scanned: Scanned;
}

/** Where a Sanity webhook is read: the helper packages, the header Sanity signs with, or a route that revalidates behind a secret. */
const SANITY_HELPER = /["'](?:@sanity\/webhook|next-sanity\/webhook)["']/;
const SANITY_SIGNATURE_HEADER = /["']sanity-webhook-signature["']/i;
const ROUTE_FILE = /(?:^|\/)(?:route\.[cm]?[jt]s|pages\/api\/.+\.[cm]?[jt]sx?)$/;
const REVALIDATES = /\b(?:revalidateTag|revalidatePath|updateTag)\s*\(/;

/**
 * The files that look like a receiver of a Sanity publish webhook: they import the official helper
 * (`@sanity/webhook`, `next-sanity/webhook`), read the `sanity-webhook-signature` header, or are a
 * route that revalidates the cache and reads a secret. Sorted by path, so the findings are in a
 * stable order.
 */
export function webhookHandlers(input: LocalSourceInput): HandlerFile[] {
  const out: HandlerFile[] = [];
  for (const path of codePaths(input)) {
    const text = input.tree.files.get(path) ?? "";
    const scanned = scanSource(text);
    const { code, bare } = scanned;
    const marked = SANITY_HELPER.test(code) || SANITY_SIGNATURE_HEADER.test(code);
    const route = ROUTE_FILE.test(path) && REVALIDATES.test(bare) && /secret|signature/i.test(bare);
    if (marked || route) out.push({ path, scanned });
  }
  return out;
}

/** Code files the reader left out for a reason that hides code (too large, unreadable, a link, binary). */
export function unreadCode(input: LocalSourceInput): string[] {
  const out: string[] = [];
  for (const [path, reason] of input.tree.skipped)
    if (CODE_FILE.test(path) && reason !== "secret-looking") out.push(path);
  return out.sort();
}

/**
 * Why a check that found nothing still cannot say it passed: a code file the reader left out may hold
 * the very pattern it looks for. Undefined when every code file was read.
 */
export function unreadReason(input: LocalSourceInput): string | undefined {
  const first = unreadCode(input)[0];
  return first === undefined
    ? undefined
    : `${first} was not read (${input.tree.skipped.get(first)}), so Gaugeline cannot say nothing is wrong in it.`;
}

/** The address a finding carries, as the foundation's runner builds it. */
export const sourceUrl = (input: LocalSourceInput): string => `source:${input.tree.label}`;
