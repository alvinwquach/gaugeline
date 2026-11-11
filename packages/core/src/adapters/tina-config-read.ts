import { isPermalinkPattern } from "./shared/permalink.js";

/**
 * Reads `tina/config.ts` as TEXT. The file is never run, imported or evaluated: it is split into tokens
 * (strings, template literals, names, punctuation; comments dropped) and the one list that matters,
 * `collections: [ ... ]`, is read as a small tree. Anything the reader cannot be sure of (a collection
 * defined in another file, a path built from a variable, a `match` that is not a plain string) is
 * reported with a fixed reason and the collection is not read: absence of evidence is never a pass.
 * Nothing the file says is ever quoted in a reason: the file is data.
 */

export const TINA_CONFIG_LIMITS = {
  /** Bytes of config text read. A bigger file is not read. */
  bytes: 512 * 1024,
  tokens: 200_000,
  depth: 40,
  collections: 200,
  /** Folders deep in a collection's `path`, as in gaugeline.adapters.json. */
  dirParts: 12,
} as const;

/** One collection the config defines, read from its text. */
export interface TinaCollection {
  /** The collection's `name`: the content type in reports. */
  name: string;
  /** Its `path`: a folder inside the repository, no leading or trailing slash. */
  dir: string;
  /** Its `format`; "md" when the config gives none. */
  format: string;
  /** From `ui.router`, when it is a plain template; undefined when there is none or it cannot be read. */
  permalink?: string;
  /** Whether a file (its path inside the folder) belongs to the collection: `format` and `match`. */
  accepts: (pathInFolder: string) => boolean;
}

/** A thing the reader could not read, with a fixed reason. `name` is the collection's name when it has a plain one. */
export interface TinaNotRead {
  name: string;
  reason: string;
  /** "collection": not read at all. "address": read, but its items have no address. */
  kind: "collection" | "address" | "tinacloud";
}

export type TinaConfigRead =
  | {
      ok: true;
      collections: TinaCollection[];
      notRead: TinaNotRead[];
      /** The config has a `clientId`, so the site uses TinaCloud. */
      tinaCloud: boolean;
    }
  | { ok: false; reason: string };

type Tok =
  | { k: "str"; v: string }
  | { k: "tpl"; parts: Array<string | { expr: string }> }
  | { k: "id"; v: string }
  | { k: "num" }
  | { k: "p"; v: string };

class Unreadable extends Error {}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

/** The file as tokens. Throws Unreadable on text it cannot split (an unterminated string or comment). */
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;

  /** A quoted string starting at `i` (the quote): its value, with `i` moved past it. */
  const quoted = (quote: string): string => {
    let v = "";
    i++;
    while (i < n) {
      const c = text[i] ?? "";
      if (c === "\\") {
        const e = text[i + 1] ?? "";
        v += e === "n" ? "\n" : e === "t" ? "\t" : e;
        i += 2;
      } else if (c === quote) {
        i++;
        return v;
      } else if (c === "\n" && quote !== "`") {
        throw new Unreadable("an unterminated string");
      } else {
        v += c;
        i++;
      }
    }
    throw new Unreadable("an unterminated string");
  };

  /** Skips from just after `${` to its closing `}` and returns the text between, with strings and templates skipped whole. */
  const substitution = (): string => {
    const from = i;
    let depth = 1;
    while (i < n) {
      const c = text[i] ?? "";
      if (c === '"' || c === "'") {
        quoted(c);
        continue;
      }
      if (c === "`") {
        template();
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) {
          const expr = text.slice(from, i);
          i++;
          return expr;
        }
      }
      i++;
    }
    throw new Unreadable("an unterminated template");
  };

  const template = (): Array<string | { expr: string }> => {
    const parts: Array<string | { expr: string }> = [];
    let v = "";
    i++;
    while (i < n) {
      const c = text[i] ?? "";
      if (c === "\\") {
        const e = text[i + 1] ?? "";
        v += e === "n" ? "\n" : e === "t" ? "\t" : e;
        i += 2;
      } else if (c === "`") {
        i++;
        if (v !== "") parts.push(v);
        return parts;
      } else if (c === "$" && text[i + 1] === "{") {
        if (v !== "") parts.push(v);
        v = "";
        i += 2;
        parts.push({ expr: substitution() });
      } else {
        v += c;
        i++;
      }
    }
    throw new Unreadable("an unterminated template");
  };

  while (i < n) {
    if (out.length > TINA_CONFIG_LIMITS.tokens) throw new Unreadable("too many tokens");
    const c = text[i] ?? "";
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Unreadable("an unterminated comment");
      i = end + 2;
    } else if (c === '"' || c === "'") {
      out.push({ k: "str", v: quoted(c) });
    } else if (c === "`") {
      out.push({ k: "tpl", parts: template() });
    } else if (ID_START.test(c)) {
      const from = i;
      while (i < n && ID_PART.test(text[i] ?? "")) i++;
      out.push({ k: "id", v: text.slice(from, i) });
    } else if (/[0-9]/.test(c)) {
      while (i < n && /[0-9A-Za-z_.]/.test(text[i] ?? "")) i++;
      out.push({ k: "num" });
    } else if (c === "=" && text[i + 1] === ">") {
      out.push({ k: "p", v: "=>" });
      i += 2;
    } else if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      out.push({ k: "p", v: "..." });
      i += 3;
    } else {
      out.push({ k: "p", v: c });
      i++;
    }
  }
  return out;
}

type Value =
  | { t: "str"; v: string }
  | { t: "tpl"; parts: Array<string | { expr: string }> }
  | { t: "bool" | "num" }
  | { t: "obj"; props: Map<string, Value>; spread: boolean }
  | { t: "arr"; items: Value[] }
  | { t: "opaque"; toks: Tok[] };

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

class Parser {
  i = 0;
  constructor(readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private isP(v: string, at = this.i): boolean {
    const t = this.toks[at];
    return t?.k === "p" && t.v === v;
  }

  /** Tokens up to the next `,` or closing bracket at the same level, which is left unread. */
  private skipOpaque(): Tok[] {
    const from = this.i;
    let depth = 0;
    while (this.i < this.toks.length) {
      const t = this.toks[this.i];
      if (t?.k === "p") {
        if (OPEN.has(t.v)) depth++;
        else if (CLOSE.has(t.v)) {
          if (depth === 0) break;
          depth--;
        } else if (t.v === "," && depth === 0) break;
      }
      this.i++;
    }
    return this.toks.slice(from, this.i);
  }

  value(depth: number): Value {
    if (depth > TINA_CONFIG_LIMITS.depth) throw new Unreadable("nested too deeply");
    const t = this.peek();
    if (t === undefined) throw new Unreadable("ends early");
    const next = this.toks[this.i + 1];
    const endsHere = next === undefined || (next.k === "p" && [",", "}", "]"].includes(next.v));
    if (t.k === "str" && endsHere) {
      this.i++;
      return { t: "str", v: t.v };
    }
    if (t.k === "tpl" && endsHere) {
      this.i++;
      return { t: "tpl", parts: t.parts };
    }
    if (t.k === "id" && (t.v === "true" || t.v === "false") && endsHere) {
      this.i++;
      return { t: "bool" };
    }
    if (t.k === "num" && endsHere) {
      this.i++;
      return { t: "num" };
    }
    if (t.k === "p" && t.v === "{") return this.object(depth);
    if (t.k === "p" && t.v === "[") return this.array(depth);
    return { t: "opaque", toks: this.skipOpaque() };
  }

  private object(depth: number): Value {
    this.i++; // {
    const props = new Map<string, Value>();
    let spread = false;
    while (this.i < this.toks.length) {
      if (this.isP("}")) {
        this.i++;
        return { t: "obj", props, spread };
      }
      if (this.isP(",")) {
        this.i++;
        continue;
      }
      const key = this.peek();
      const before = this.i;
      if (this.isP("...")) {
        spread = true;
        this.i++;
        this.skipOpaque();
      } else if ((key?.k === "id" || key?.k === "str") && this.isP(":", this.i + 1)) {
        this.i += 2;
        // A repeated key keeps its first value, so a later one cannot hide what a reader would take first.
        const v = this.value(depth + 1);
        if (!props.has(key.v)) props.set(key.v, v);
      } else {
        // A shorthand property, a method or a computed key: not read.
        spread = true;
        this.skipOpaque();
      }
      if (this.i === before) throw new Unreadable("has a bracket that does not match");
    }
    throw new Unreadable("ends early");
  }

  private array(depth: number): Value {
    this.i++; // [
    const items: Value[] = [];
    while (this.i < this.toks.length) {
      if (this.isP("]")) {
        this.i++;
        return { t: "arr", items };
      }
      if (this.isP(",")) {
        this.i++;
        continue;
      }
      const before = this.i;
      items.push(this.value(depth + 1));
      if (this.i === before) throw new Unreadable("has a bracket that does not match");
    }
    throw new Unreadable("ends early");
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIR_PART = /^[A-Za-z0-9_@~+-][A-Za-z0-9_.@~+-]*$/;
const FORMATS: Readonly<Record<string, readonly string[]>> = {
  md: [".md"],
  markdown: [".markdown", ".md"],
  mdx: [".mdx"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  yml: [".yaml", ".yml"],
  toml: [".toml"],
};

/** The plain text of a string or a template with nothing substituted, or undefined. */
const plain = (v: Value | undefined): string | undefined =>
  v?.t === "str"
    ? v.v
    : v?.t === "tpl" && v.parts.every((p) => typeof p === "string")
      ? v.parts.join("")
      : undefined;

/**
 * A glob as Tina's `match` writes it, over a path without its extension: `*`, `**`, `?` and `{a,b}`.
 * Anything else (character classes, `!(..)` and the like) is refused rather than guessed at.
 */
function globOf(pattern: string): ((p: string) => boolean) | undefined {
  if (pattern === "" || pattern.length > 200 || /[[\]()!+@\\]/.test(pattern)) return undefined;
  let re = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}") {
      if (braces === 0) return undefined;
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.^$|\\/]/g, (m) => `\\${m}`);
  }
  if (braces !== 0) return undefined;
  try {
    const compiled = new RegExp(`^${re}$`);
    return (p) => compiled.test(p);
  } catch {
    return undefined;
  }
}

/** The pieces of a `ui.router` arrow function's template that Gaugeline understands, as a permalink pattern. */
const ROUTER_TOKENS: Readonly<Record<string, string>> = {
  "document._sys.filename": "{filename}",
  "document._sys.breadcrumbs.join('/')": "{path}",
  'document._sys.breadcrumbs.join("/")': "{path}",
  "document.slug": "{slug}",
};

/** The body of an arrow function `(..) => body` (or `{ return body }`) as one string or template, or undefined. */
function routerBody(toks: Tok[]): Tok | undefined {
  const arrow = toks.findIndex((t) => t.k === "p" && t.v === "=>");
  if (arrow < 0) return undefined;
  let body = toks.slice(arrow + 1);
  const isP = (t: Tok | undefined, v: string): boolean => t?.k === "p" && t.v === v;
  // { return X; }
  if (isP(body[0], "{") && isP(body.at(-1), "}")) {
    const inner = body.slice(1, -1);
    if (!(inner[0]?.k === "id" && inner[0].v === "return")) return undefined;
    body = inner.slice(1);
    if (isP(body.at(-1), ";")) body = body.slice(0, -1);
  }
  // ( X )
  while (isP(body[0], "(") && isP(body.at(-1), ")")) body = body.slice(1, -1);
  return body.length === 1 ? body[0] : undefined;
}

function permalinkOf(router: Value | undefined): string | undefined {
  if (router?.t !== "opaque") return undefined;
  const body = routerBody(router.toks);
  if (body === undefined) return undefined;
  let pattern: string;
  if (body.k === "str") pattern = body.v;
  else if (body.k === "tpl") {
    pattern = "";
    for (const part of body.parts) {
      if (typeof part === "string") pattern += part;
      else {
        const mapped = ROUTER_TOKENS[part.expr.replace(/\s+/g, "")];
        if (mapped === undefined) return undefined;
        pattern += mapped;
      }
    }
  } else return undefined;
  return isPermalinkPattern(pattern) ? pattern : undefined;
}

/** A `path`: a folder inside the repository, with "/" separators and no hidden or dependency part. */
function dirOf(value: string): string | undefined {
  const dir = value.replace(/^\.\//, "").replace(/\/+$/, "");
  if (dir === "" || dir.length > 300) return undefined;
  const parts = dir.split("/");
  return parts.length <= TINA_CONFIG_LIMITS.dirParts &&
    parts.every((p) => DIR_PART.test(p) && p !== "node_modules")
    ? dir
    : undefined;
}

function readCollection(
  v: Value,
  index: number,
): { collection: TinaCollection; address?: TinaNotRead } | TinaNotRead {
  const label = `collection ${index + 1}`;
  const refuse = (name: string, reason: string): TinaNotRead => ({
    name,
    reason,
    kind: "collection",
  });
  if (v.t !== "obj")
    return refuse(
      label,
      "is not written out in tina/config.ts (it is imported or comes from a variable), and the config is not run",
    );
  const name = plain(v.props.get("name"));
  if (name === undefined || !NAME.test(name))
    return refuse(
      label,
      "has a name that is not a plain string of letters, digits, hyphens or underscores",
    );
  if (v.spread)
    return refuse(
      name,
      "has properties that are spread in or computed, which cannot be read without running the config",
    );
  const rawPath = plain(v.props.get("path"));
  const dir = rawPath === undefined ? undefined : dirOf(rawPath);
  if (dir === undefined)
    return refuse(name, "has a path that is not a plain folder inside the repository");
  const formatValue = v.props.get("format");
  const format = formatValue === undefined ? "md" : plain(formatValue);
  const extensions = format === undefined ? undefined : FORMATS[format];
  if (format === undefined || extensions === undefined)
    return refuse(
      name,
      "has a format that is not one of md, markdown, mdx, json, yaml, yml or toml",
    );

  const matchValue = v.props.get("match");
  let include: ((p: string) => boolean) | undefined;
  let exclude: ((p: string) => boolean) | undefined;
  if (matchValue !== undefined) {
    if (matchValue.t !== "obj" || matchValue.spread)
      return refuse(name, "has a match that is not a plain object");
    for (const key of matchValue.props.keys())
      if (key !== "include" && key !== "exclude")
        return refuse(name, "has a match with a key other than include and exclude");
    for (const which of ["include", "exclude"] as const) {
      const raw = matchValue.props.get(which);
      if (raw === undefined) continue;
      const pattern = plain(raw);
      const glob = pattern === undefined ? undefined : globOf(pattern);
      if (glob === undefined)
        return refuse(
          name,
          `has a match.${which} that is not a plain pattern (* ** ? and {a,b} only)`,
        );
      if (which === "include") include = glob;
      else exclude = glob;
    }
  }

  const ui = v.props.get("ui");
  const router = ui?.t === "obj" ? ui.props.get("router") : undefined;
  const permalink = permalinkOf(router);
  const accepts = (pathInFolder: string): boolean => {
    const dot = pathInFolder.lastIndexOf(".");
    if (dot < 0 || !extensions.includes(pathInFolder.slice(dot).toLowerCase())) return false;
    const bare = pathInFolder.slice(0, dot);
    return (include === undefined || include(bare)) && (exclude === undefined || !exclude(bare));
  };
  const collection: TinaCollection = {
    name,
    dir,
    format,
    ...(permalink !== undefined ? { permalink } : {}),
    accepts,
  };
  const noAddress =
    router !== undefined && permalink === undefined
      ? ({
          name,
          kind: "address",
          reason:
            "has a ui.router that is more than a single template of document._sys.filename, document._sys.breadcrumbs.join('/') or document.slug, so its items have no address (name the address in gaugeline.adapters.json instead)",
        } satisfies TinaNotRead)
      : undefined;
  return { collection, ...(noAddress ? { address: noAddress } : {}) };
}

/** Does the config name a TinaCloud client: a `clientId` property whose value is not empty. */
function tinaCloudOf(toks: Tok[]): boolean {
  for (let i = 0; i + 2 < toks.length; i++) {
    const t = toks[i];
    const colon = toks[i + 1];
    const next = toks[i + 2];
    if (t?.k === "id" && t.v === "clientId" && colon?.k === "p" && colon.v === ":")
      return !(next?.k === "str" && next.v === "") && !(next?.k === "id" && next.v === "undefined");
  }
  return false;
}

/** Reads the collections out of the text of tina/config.ts. Never runs it. */
export function readTinaConfig(text: string): TinaConfigRead {
  if (Buffer.byteLength(text) > TINA_CONFIG_LIMITS.bytes)
    return {
      ok: false,
      reason: "tina/config.ts is larger than Gaugeline reads, so it was not read",
    };
  let toks: Tok[];
  try {
    toks = tokenize(text);
  } catch {
    return {
      ok: false,
      reason: "tina/config.ts could not be split into text and code, so it was not read",
    };
  }
  let list: Value | undefined;
  for (let i = 0; i + 2 < toks.length; i++) {
    const t = toks[i];
    const colon = toks[i + 1];
    const open = toks[i + 2];
    if (
      t?.k === "id" &&
      t.v === "collections" &&
      colon?.k === "p" &&
      colon.v === ":" &&
      open?.k === "p" &&
      open.v === "["
    ) {
      try {
        const parser = new Parser(toks);
        parser.i = i + 2;
        list = parser.value(0);
      } catch {
        return {
          ok: false,
          reason: "the collections list in tina/config.ts could not be read as plain text",
        };
      }
      break;
    }
  }
  if (list?.t !== "arr")
    return {
      ok: false,
      reason:
        "tina/config.ts has no `collections: [ ... ]` list written out in it (it may be built from a variable or another file), and the config is not run",
    };
  if (list.items.length > TINA_CONFIG_LIMITS.collections)
    return { ok: false, reason: "tina/config.ts has more collections than Gaugeline reads" };
  const collections = new Map<string, TinaCollection>();
  const notRead: TinaNotRead[] = [];
  list.items.forEach((item, index) => {
    const r = readCollection(item, index);
    if ("collection" in r) {
      if (collections.has(r.collection.name))
        notRead.push({
          name: r.collection.name,
          kind: "collection",
          reason: "is named twice in tina/config.ts; the first one is read",
        });
      else collections.set(r.collection.name, r.collection);
      if (r.address) notRead.push(r.address);
    } else notRead.push(r);
  });
  return {
    ok: true,
    collections: [...collections.values()],
    notRead,
    tinaCloud: tinaCloudOf(toks),
  };
}
