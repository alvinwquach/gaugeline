/**
 * A reader for GraphQL documents: the executable ones (queries, mutations, subscriptions and
 * fragments) and the type system ones (the SDL a schema file holds). It reads the text and
 * nothing else: no request, no file, no schema. What it keeps is what `gaugeline query --graphql`
 * needs: the field names in each selection set with their line, the fragment spreads, the type
 * conditions, and for a schema the fields of each object, interface and union.
 *
 * Arguments, variables, directives and values are read past, never kept. The grammar followed is
 * the lexical and syntactic grammar of the GraphQL specification (October 2021 edition) [docs].
 */

/** A field in a selection set. `selections` is absent for a field that has none (a value). */
export interface GqlField {
  kind: "field";
  /** The field's own name; an alias is read past. */
  name: string;
  line: number;
  selections?: GqlSelection[];
}

export interface GqlSpread {
  kind: "spread";
  name: string;
  line: number;
}

export interface GqlInline {
  kind: "inline";
  typeCondition?: string;
  selections: GqlSelection[];
  line: number;
}

export type GqlSelection = GqlField | GqlSpread | GqlInline;

export type GqlOperationKind = "query" | "mutation" | "subscription";

export interface GqlOperation {
  kind: "operation";
  operation: GqlOperationKind;
  name?: string;
  selections: GqlSelection[];
  line: number;
}

export interface GqlFragment {
  kind: "fragment";
  name: string;
  typeCondition: string;
  selections: GqlSelection[];
  line: number;
}

/** A field of an object or interface type in a schema: the type it returns, and whether that is a list. */
export interface GqlFieldDef {
  name: string;
  type: string;
  list: boolean;
}

/** An object, interface or union in a schema file. Enums, inputs and scalars are read past. */
export interface GqlTypeDef {
  kind: "type";
  flavor: "object" | "interface" | "union";
  name: string;
  implements: string[];
  fields: GqlFieldDef[];
  /** The members of a union. */
  members: string[];
  /** `extend type X`: its fields are added to X. */
  extension: boolean;
  line: number;
}

/** `schema { query: RootQuery }`. */
export interface GqlSchemaDef {
  kind: "schema";
  query?: string;
  mutation?: string;
  subscription?: string;
  line: number;
}

/** A definition this module reads past: an enum, an input, a scalar, a directive. */
export interface GqlOther {
  kind: "other";
  line: number;
}

export type GqlDefinition = GqlOperation | GqlFragment | GqlTypeDef | GqlSchemaDef | GqlOther;

/** The text is not GraphQL. `line` is where the reader gave up, counting from the first line given. */
export class GqlSyntaxError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "GqlSyntaxError";
    this.line = line;
  }
}

type TokenKind = "punct" | "name" | "number" | "string" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  /** A comma came between the previous token and this one (the old `implements A, B` form). */
  comma: boolean;
}

const PUNCT = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "|", "}"]);
const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

function lex(text: string, firstLine: number): Token[] {
  const out: Token[] = [];
  const n = text.length;
  let i = 0;
  let line = firstLine;
  let comma = false;
  const push = (kind: TokenKind, value: string, at: number): void => {
    out.push({ kind, value, line: at, comma });
    comma = false;
  };
  while (i < n) {
    const c = text[i] as string;
    if (c === "\uFEFF" || c === " " || c === "\t") {
      i++;
    } else if (c === "\n") {
      line++;
      i++;
    } else if (c === "\r") {
      line++;
      i += text[i + 1] === "\n" ? 2 : 1;
    } else if (c === ",") {
      comma = true;
      i++;
    } else if (c === "#") {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
    } else if (c === ".") {
      if (text.startsWith("...", i)) {
        push("punct", "...", line);
        i += 3;
      } else throw new GqlSyntaxError('Unexpected ".".', line);
    } else if (PUNCT.has(c)) {
      push("punct", c, line);
      i++;
    } else if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(text[j] as string)) j++;
      push("name", text.slice(i, j), line);
      i = j;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) throw new GqlSyntaxError("Unexpected number.", line);
      push("number", m[0], line);
      i += m[0].length;
    } else if (c === '"') {
      const start = line;
      if (text.startsWith('"""', i)) {
        // A block string ends at the next """ that is not written \""".
        let j = i + 3;
        for (;;) {
          if (j >= n) throw new GqlSyntaxError("A block string is never closed.", start);
          if (text.startsWith('\\"""', j)) j += 4;
          else if (text.startsWith('"""', j)) break;
          else {
            const ch = text[j] as string;
            if (ch === "\n") line++;
            else if (ch === "\r") {
              line++;
              if (text[j + 1] === "\n") j++;
            }
            j++;
          }
        }
        push("string", "", start);
        i = j + 3;
      } else {
        let j = i + 1;
        for (;;) {
          const ch = text[j];
          if (ch === undefined || ch === "\n" || ch === "\r")
            throw new GqlSyntaxError("A string is never closed.", line);
          if (ch === "\\") j += 2;
          else if (ch === '"') break;
          else j++;
        }
        push("string", "", start);
        i = j + 1;
      }
    } else {
      throw new GqlSyntaxError(`Unexpected character ${JSON.stringify(c)}.`, line);
    }
  }
  out.push({ kind: "eof", value: "", line, comma });
  return out;
}

class Reader {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(ahead = 0): Token {
    return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)] as Token;
  }
  next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }
  isPunct(value: string, ahead = 0): boolean {
    const t = this.peek(ahead);
    return t.kind === "punct" && t.value === value;
  }
  isName(value?: string, ahead = 0): boolean {
    const t = this.peek(ahead);
    return t.kind === "name" && (value === undefined || t.value === value);
  }
  describe(t: Token): string {
    return t.kind === "eof" ? "the end of the text" : `"${t.value === "" ? t.kind : t.value}"`;
  }
  fail(message: string): never {
    throw new GqlSyntaxError(message, this.peek().line);
  }
  punct(value: string): Token {
    if (!this.isPunct(value))
      this.fail(`Expected "${value}", found ${this.describe(this.peek())}.`);
    return this.next();
  }
  name(): Token {
    if (!this.isName()) this.fail(`Expected a name, found ${this.describe(this.peek())}.`);
    return this.next();
  }
  keyword(value: string): Token {
    if (!this.isName(value)) this.fail(`Expected "${value}", found ${this.describe(this.peek())}.`);
    return this.next();
  }
  /** Read past a balanced pair: `( ... )`, `{ ... }`. Strings are tokens, so a bracket inside one cannot confuse it. */
  skipBalanced(open: string, close: string): void {
    this.punct(open);
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === "eof") this.fail(`A "${open}" is never closed.`);
      if (t.kind === "punct" && t.value === open) depth++;
      else if (t.kind === "punct" && t.value === close) depth--;
    }
  }
  directives(): void {
    while (this.isPunct("@")) {
      this.next();
      this.name();
      if (this.isPunct("(")) this.skipBalanced("(", ")");
    }
  }
}

function selectionSet(r: Reader): GqlSelection[] {
  r.punct("{");
  const out: GqlSelection[] = [];
  while (!r.isPunct("}")) {
    if (r.peek().kind === "eof") r.fail('A "{" is never closed.');
    out.push(selection(r));
  }
  if (out.length === 0) r.fail("A selection set cannot be empty.");
  r.punct("}");
  return out;
}

function selection(r: Reader): GqlSelection {
  if (r.isPunct("...")) {
    const dots = r.next();
    if (r.isName() && !r.isName("on")) {
      const name = r.next();
      r.directives();
      return { kind: "spread", name: name.value, line: name.line };
    }
    let typeCondition: string | undefined;
    if (r.isName("on")) {
      r.next();
      typeCondition = r.name().value;
    }
    r.directives();
    return {
      kind: "inline",
      ...(typeCondition === undefined ? {} : { typeCondition }),
      selections: selectionSet(r),
      line: dots.line,
    };
  }
  let name = r.name();
  if (r.isPunct(":")) {
    r.next();
    name = r.name();
  }
  if (r.isPunct("(")) r.skipBalanced("(", ")");
  r.directives();
  const field: GqlField = { kind: "field", name: name.value, line: name.line };
  if (r.isPunct("{")) field.selections = selectionSet(r);
  return field;
}

function operation(r: Reader, kind: GqlOperationKind): GqlOperation {
  const keyword = r.next();
  let name: string | undefined;
  if (r.isName()) name = r.next().value;
  if (r.isPunct("(")) r.skipBalanced("(", ")");
  r.directives();
  return {
    kind: "operation",
    operation: kind,
    ...(name === undefined ? {} : { name }),
    selections: selectionSet(r),
    line: keyword.line,
  };
}

function fragment(r: Reader): GqlFragment {
  const keyword = r.next();
  const name = r.name();
  if (name.value === "on") r.fail('A fragment cannot be named "on".');
  r.keyword("on");
  const typeCondition = r.name().value;
  r.directives();
  return {
    kind: "fragment",
    name: name.value,
    typeCondition,
    selections: selectionSet(r),
    line: keyword.line,
  };
}

/** `Type`, `[Type]`, `Type!`, `[Type!]!`: the named type and whether a list is in the way. */
function typeRef(r: Reader): { name: string; list: boolean } {
  let out: { name: string; list: boolean };
  if (r.isPunct("[")) {
    r.next();
    out = { name: typeRef(r).name, list: true };
    r.punct("]");
  } else out = { name: r.name().value, list: false };
  if (r.isPunct("!")) r.next();
  return out;
}

function fieldDefs(r: Reader): GqlFieldDef[] {
  r.punct("{");
  const out: GqlFieldDef[] = [];
  while (!r.isPunct("}")) {
    if (r.peek().kind === "eof") r.fail('A "{" is never closed.');
    if (r.peek().kind === "string") r.next();
    const name = r.name();
    if (r.isPunct("(")) r.skipBalanced("(", ")");
    r.punct(":");
    const type = typeRef(r);
    r.directives();
    out.push({ name: name.value, type: type.name, list: type.list });
  }
  r.punct("}");
  return out;
}

function implementsList(r: Reader): string[] {
  const out: string[] = [];
  if (!r.isName("implements")) return out;
  r.next();
  if (r.isPunct("&")) r.next();
  out.push(r.name().value);
  for (;;) {
    if (r.isPunct("&")) {
      r.next();
      out.push(r.name().value);
    } else if (r.isName() && r.peek().comma) {
      // `implements A, B`: the old form, separated by commas.
      out.push(r.next().value);
    } else break;
  }
  return out;
}

function typeSystem(r: Reader, extension: boolean): GqlDefinition {
  const keyword = r.name();
  const line = keyword.line;
  switch (keyword.value) {
    case "schema": {
      r.directives();
      const def: GqlSchemaDef = { kind: "schema", line };
      if (r.isPunct("{")) {
        r.next();
        while (!r.isPunct("}")) {
          if (r.peek().kind === "eof") r.fail('A "{" is never closed.');
          const op = r.name().value;
          r.punct(":");
          const type = r.name().value;
          if (op === "query" || op === "mutation" || op === "subscription") def[op] = type;
        }
        r.punct("}");
      }
      return def;
    }
    case "type":
    case "interface": {
      const name = r.name().value;
      const impl = implementsList(r);
      r.directives();
      const fields = r.isPunct("{") ? fieldDefs(r) : [];
      return {
        kind: "type",
        flavor: keyword.value === "type" ? "object" : "interface",
        name,
        implements: impl,
        fields,
        members: [],
        extension,
        line,
      };
    }
    case "union": {
      const name = r.name().value;
      r.directives();
      const members: string[] = [];
      if (r.isPunct("=")) {
        r.next();
        if (r.isPunct("|")) r.next();
        members.push(r.name().value);
        while (r.isPunct("|")) {
          r.next();
          members.push(r.name().value);
        }
      }
      return {
        kind: "type",
        flavor: "union",
        name,
        implements: [],
        fields: [],
        members,
        extension,
        line,
      };
    }
    case "enum":
    case "input": {
      r.name();
      r.directives();
      if (r.isPunct("{")) r.skipBalanced("{", "}");
      return { kind: "other", line };
    }
    case "scalar": {
      r.name();
      r.directives();
      return { kind: "other", line };
    }
    case "directive": {
      r.punct("@");
      r.name();
      if (r.isPunct("(")) r.skipBalanced("(", ")");
      if (r.isName("repeatable")) r.next();
      r.keyword("on");
      if (r.isPunct("|")) r.next();
      r.name();
      while (r.isPunct("|")) {
        r.next();
        r.name();
      }
      return { kind: "other", line };
    }
    default:
      throw new GqlSyntaxError(`Unexpected "${keyword.value}".`, line);
  }
}

function definition(r: Reader): GqlDefinition {
  if (r.isPunct("{")) {
    // The shorthand for a query: `{ field }`.
    const line = r.peek().line;
    return { kind: "operation", operation: "query", selections: selectionSet(r), line };
  }
  if (r.peek().kind === "string") r.next();
  const t = r.peek();
  if (t.kind !== "name") r.fail(`Unexpected ${r.describe(t)}.`);
  switch (t.value) {
    case "query":
    case "mutation":
    case "subscription":
      return operation(r, t.value);
    case "fragment":
      return fragment(r);
    case "extend":
      r.next();
      return typeSystem(r, true);
    default:
      return typeSystem(r, false);
  }
}

/**
 * Read a GraphQL document. `firstLine` is the line the text starts on in its file (a template in a
 * .ts file starts after the first lines of the file), so every line that comes back is the file's.
 * Throws GqlSyntaxError, with the line, when the text is not GraphQL.
 */
export function parseGraphql(text: string, firstLine = 1): GqlDefinition[] {
  const r = new Reader(lex(text, firstLine));
  const out: GqlDefinition[] = [];
  while (r.peek().kind !== "eof") out.push(definition(r));
  return out;
}
