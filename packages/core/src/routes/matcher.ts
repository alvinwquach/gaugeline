import { findSessionHelper, scanSource } from "./scan.js";

/**
 * What a Next.js middleware file covers and whether it looks like a gate. Pure text reading: the
 * file is scanned, never run. The matcher syntax is the one in Next.js's middleware reference
 * (path-to-regexp: `/account/:path*`, `/dashboard/:id`, `/((?!api|_next).*)`), read from the
 * literal in `export const config = { matcher: ... }`.
 */

export type MatcherRead =
  /** No `config`, or no `matcher` in it: the middleware runs on every path, so which it guards is decided in code. */
  | { kind: "all" }
  /** The matcher's sources, as written. */
  | { kind: "list"; sources: string[] }
  /** There is a matcher and it is not a list of strings (a variable, a spread, a call). */
  | { kind: "unreadable"; why: string };

type Lit = string | number | boolean | null | Lit[] | { [key: string]: Lit } | typeof UNREADABLE;
const UNREADABLE = Symbol("unreadable");

class Reader {
  i: number;
  constructor(
    readonly s: string,
    start: number,
  ) {
    this.i = start;
  }
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? "")) this.i += 1;
  }
  /** Skip an expression this reader does not understand: to the next comma or closer at depth 0. */
  skip(): void {
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i] ?? "";
      if (c === '"' || c === "'" || c === "`") {
        this.i += 1;
        while (this.i < this.s.length && this.s[this.i] !== c)
          this.i += this.s[this.i] === "\\" ? 2 : 1;
        this.i += 1;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return;
        depth -= 1;
      } else if (c === "," && depth === 0) return;
      this.i += 1;
    }
  }
  value(): Lit {
    this.ws();
    const c = this.s[this.i] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      const start = this.i;
      this.i += 1;
      let out = "";
      while (this.i < this.s.length && this.s[this.i] !== c) {
        if (this.s[this.i] === "\\") {
          out += this.s[this.i + 1] ?? "";
          this.i += 2;
        } else {
          out += this.s[this.i];
          this.i += 1;
        }
      }
      this.i += 1;
      // A template with a placeholder is not a literal.
      if (c === "`" && this.s.slice(start, this.i).includes("${")) {
        this.afterValue();
        return UNREADABLE;
      }
      return this.afterValue(out);
    }
    if (c === "[") {
      this.i += 1;
      const items: Lit[] = [];
      for (;;) {
        this.ws();
        if (this.i >= this.s.length) return UNREADABLE;
        if (this.s[this.i] === "]") {
          this.i += 1;
          break;
        }
        if (this.s.startsWith("...", this.i)) {
          this.skip();
          items.push(UNREADABLE);
        } else items.push(this.value());
        this.ws();
        if (this.s[this.i] === ",") this.i += 1;
      }
      return this.afterValue(items);
    }
    if (c === "{") {
      this.i += 1;
      const obj: { [key: string]: Lit } = {};
      for (;;) {
        this.ws();
        if (this.i >= this.s.length) return UNREADABLE;
        if (this.s[this.i] === "}") {
          this.i += 1;
          break;
        }
        const key = this.key();
        this.ws();
        if (key !== undefined && this.s[this.i] === ":") {
          this.i += 1;
          obj[key] = this.value();
        } else {
          // A shorthand property, a spread or a method: not a literal.
          this.skip();
          if (key !== undefined) obj[key] = UNREADABLE;
        }
        this.ws();
        if (this.s[this.i] === ",") this.i += 1;
      }
      return this.afterValue(obj);
    }
    const word = /^-?[\w$.]+/.exec(this.s.slice(this.i))?.[0];
    if (word === "true" || word === "false") {
      this.i += word.length;
      return this.afterValue(word === "true");
    }
    if (word === "null") {
      this.i += 4;
      return this.afterValue(null);
    }
    this.skip();
    return UNREADABLE;
  }
  /** `as const` and `satisfies T` after a value are types, not part of it. */
  afterValue<T extends Lit>(v?: T): T | typeof UNREADABLE {
    this.ws();
    const rest = this.s.slice(this.i);
    const m = /^(?:as\s+const|as\s+[\w.<>[\]]+|satisfies\s+[\w.<>[\]]+)/.exec(rest);
    if (m) this.i += m[0].length;
    return v as T;
  }
  key(): string | undefined {
    const c = this.s[this.i] ?? "";
    if (c === '"' || c === "'") {
      const end = this.s.indexOf(c, this.i + 1);
      if (end === -1) return undefined;
      const k = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return k;
    }
    const m = /^[\w$]+/.exec(this.s.slice(this.i));
    if (!m) return undefined;
    this.i += m[0].length;
    return m[0];
  }
}

/** What the middleware's `config.matcher` says, from the file's text. */
export function readMatcher(source: string): MatcherRead {
  const text = scanSource(source).uncommented;
  const found = /export\s+const\s+config\b[^=]*=\s*/.exec(text);
  if (!found) return { kind: "all" };
  const reader = new Reader(text, found.index + found[0].length);
  const config = reader.value();
  if (
    config === UNREADABLE ||
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config)
  )
    return { kind: "unreadable", why: "the config is not an object written out in the file" };
  if (!("matcher" in config)) return { kind: "all" };
  const matcher = config.matcher;
  const entries = Array.isArray(matcher) ? matcher : [matcher];
  const sources: string[] = [];
  for (const e of entries) {
    if (typeof e === "string") sources.push(e);
    else if (
      typeof e === "object" &&
      e !== null &&
      !Array.isArray(e) &&
      typeof (e as { source?: unknown }).source === "string"
    )
      sources.push((e as { source: string }).source);
    else
      return {
        kind: "unreadable",
        why: "the matcher is not a list of strings written out in the file",
      };
  }
  return { kind: "list", sources };
}

interface Token {
  text?: string;
  prefix?: string;
  pattern?: string;
  modifier?: string;
}

/**
 * A matcher source as a regular expression, the way path-to-regexp reads it: `:name` is one
 * segment, `:name*` any number (none included), `:name+` one or more, `:name?` none or one, and a
 * group in parentheses is a regular expression. Undefined when it cannot be read.
 */
export function matcherToRegExp(source: string): RegExp | undefined {
  const tokens: Token[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text !== "") tokens.push({ text });
    text = "";
  };
  const takePrefix = (): string => {
    const last = text.at(-1);
    if (last === "/" || last === ".") {
      text = text.slice(0, -1);
      return last;
    }
    return "";
  };
  const group = (): string | undefined => {
    let depth = 0;
    const start = i;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") i += 1;
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          return source.slice(start + 1, i - 1);
        }
      }
    }
    return undefined;
  };
  while (i < source.length) {
    const c = source[i] ?? "";
    if (c === "\\") {
      text += source[i + 1] ?? "";
      i += 2;
    } else if (c === ":" && /[A-Za-z_]/.test(source[i + 1] ?? "")) {
      const name = /^[A-Za-z_]\w*/.exec(source.slice(i + 1))?.[0] ?? "";
      i += 1 + name.length;
      let pattern = "[^/#?]+?";
      if (source[i] === "(") {
        const g = group();
        if (g === undefined) return undefined;
        pattern = g;
      }
      const prefix = takePrefix();
      flush();
      const modifier = /^[*+?]/.test(source[i] ?? "") ? (source[i] ?? "") : "";
      if (modifier) i += 1;
      tokens.push({ prefix, pattern, modifier });
    } else if (c === "(") {
      const g = group();
      if (g === undefined) return undefined;
      const prefix = takePrefix();
      flush();
      const modifier = /^[*+?]/.test(source[i] ?? "") ? (source[i] ?? "") : "";
      if (modifier) i += 1;
      tokens.push({ prefix, pattern: g, modifier });
    } else {
      text += c;
      i += 1;
    }
  }
  flush();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let out = "";
  for (const t of tokens) {
    if (t.text !== undefined) out += escape(t.text);
    else {
      const body = `(?:${escape(t.prefix ?? "")}(?:${t.pattern ?? ""}))`;
      out += `${body}${t.modifier ?? ""}`;
    }
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return undefined;
  }
}

/**
 * A path Next.js would serve for a route written with dynamic segments: `[id]` becomes `sample`,
 * `[...rest]` two segments, and an optional catch-all `[[...rest]]` nothing.
 */
export function samplePath(routePath: string): string {
  const parts = routePath
    .split("/")
    .filter((p) => p !== "")
    .flatMap((p) => {
      if (/^\[\[\.\.\..+\]\]$/.test(p)) return [];
      if (/^\[\.\.\..+\]$/.test(p)) return ["sample", "more"];
      if (p.includes("[")) return ["sample"];
      return [p];
    });
  return `/${parts.join("/")}`;
}

/**
 * Does a middleware that looks like a gate cover this route? A matcher entry that covers the home
 * page is too broad to be a list of signed-in routes (an internationalisation middleware matches
 * nearly everything), so it is not read as one. Reported as `broad` so the notes can say so.
 */
export function matcherCovers(
  matcher: MatcherRead,
  routePath: string,
): { covered: boolean; by?: string } {
  if (matcher.kind !== "list") return { covered: false };
  const sample = samplePath(routePath);
  for (const source of matcher.sources) {
    const re = matcherToRegExp(source);
    if (!re || re.test("/")) continue;
    if (re.test(sample)) return { covered: true, by: source };
  }
  return { covered: false };
}

/** The matcher entries that are too broad to read as a list of guarded routes, or cannot be read. */
export function matcherProblems(matcher: MatcherRead): { broad: string[]; unreadable: string[] } {
  const out = { broad: [] as string[], unreadable: [] as string[] };
  if (matcher.kind !== "list") return out;
  for (const source of matcher.sources) {
    const re = matcherToRegExp(source);
    if (!re) out.unreadable.push(source);
    else if (re.test("/")) out.broad.push(source);
  }
  return out;
}

const SIGN_IN_WORD = /log-?in|sign-?in|sign_in|log_in|\/auth\b|unauthori[sz]ed/i;

/**
 * Why this middleware looks like a gate, or undefined when it does not. A middleware that never
 * touches a session, a sign-in address, an authorisation header or a 401 or 403 (it sets a
 * language, adds a header) is not taken for a gate, so it does not make every route signed-in.
 */
export function gateHint(source: string): string | undefined {
  const scanned = scanSource(source);
  const helper = findSessionHelper(scanned.code);
  if (helper) return `calls ${helper}()`;
  const word = /\b(withAuth|authMiddleware|clerkMiddleware|NextAuth|getToken)\b/.exec(
    scanned.code,
  )?.[1];
  if (word) return `uses ${word}`;
  if (/\bcookies\s*\.\s*(?:get|has)\s*\(/.test(scanned.code)) return "reads a cookie";
  if (/\bstatus\s*:\s*40[13]\b/.test(scanned.code)) return "answers 401 or 403";
  if (scanned.strings.some((s) => /^authorization$/i.test(s)))
    return "reads the Authorization header";
  if (scanned.strings.some((s) => SIGN_IN_WORD.test(s))) return "redirects to a sign-in address";
  return undefined;
}
