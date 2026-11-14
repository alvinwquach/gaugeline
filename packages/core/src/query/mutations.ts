import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as TS from "typescript";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { ConfigError } from "../errors.js";
import type { Finding } from "../model.js";
import type { SourceRef } from "./shape.js";
import {
  SCRIPT_KINDS,
  firstSyntaxError,
  importTypeScript,
  loadCompiler,
  sourceRoot,
  walk,
  withoutBom,
  type TypeScript,
} from "./source.js";

/**
 * Mutations, read from source and never sent. This module reads files and compares what they say
 * with a schema file; it has no way to make a request. It must not import the fetcher, the Sanity
 * reader or any HTTP client, directly or through another module, and a test fails the build if it
 * does (packages/core/src/query/__tests__/mutations.test.ts).
 */
export type MutationKind =
  "patch" | "create" | "createOrReplace" | "createIfNotExists" | "delete" | "transaction";

/** What a written value is: a plain string, an object with `_ref`, or anything else. */
export type ValueKind = "string" | "ref" | "other";

export interface MutationShape {
  kind: MutationKind;
  /** The `_type` a create names. A patch names no type; see checkMutations for how it is attributed. */
  type?: string;
  /**
   * The fields that are written, as the code spells them ("status", "author._ref", "tags[0]"),
   * each with the kind of its value. `set`, `setIfMissing`, `unset`, `inc`, `dec`, `append`,
   * `prepend` and `insert` all write. A create's `_type` is `type`, not a field.
   */
  sets: Map<string, ValueKind>;
  /** The id (or `_id`) is a draft id: it starts `drafts.` or comes from something named like a draft helper. */
  touchesDrafts: boolean;
  /** The route handler this is in ("/api/orders"), or the file when it is not a route. */
  route: string;
  /** Where it starts: the line of the call (`.patch`, `.create`, `.transaction`, `.mutate`). */
  source: SourceRef;
  /** True when part of the payload could not be read (a spread, a computed key, a variable): the visible keys are all that is known. */
  partial: boolean;
  /** A transaction, or a raw mutations array: the operations in it, in order. */
  ops?: MutationShape[];
}

/** A write that was found and not fully read. Never skipped silently, never guessed. */
export interface MutationUnreadable {
  /**
   * variable-key: a field name that comes from a variable or an expression.
   * variable-payload: a payload that is a variable (or a call) the file does not settle.
   * parse-error: a file that does not parse, so none of it was read.
   */
  reason: "variable-key" | "variable-payload" | "parse-error";
  source: SourceRef;
}

export interface MutationExtraction {
  shapes: MutationShape[];
  unreadable: MutationUnreadable[];
}

export interface MutationExtractOptions {
  /** Tests: how the TypeScript compiler is loaded. */
  loadTypeScript?: () => Promise<TypeScript>;
}

/** One field a document type declares. */
export interface SchemaField {
  required: boolean;
  /** An object with `_ref`: it is written as `{ _type: "reference", _ref: id }`, never as a plain string. */
  reference: boolean;
}

/** What a schema extract holds: the document types, and the named type declarations (slug, shared objects) they refer to. */
export interface SchemaFile {
  documents: SchemaShape;
  /** Type declaration name to its type node, as the extract wrote it. */
  declarations: Map<string, unknown>;
  /** Document type to each field's type node, as the extract wrote it: what `--suggest` reads the kinds from. */
  nodes: Map<string, Map<string, unknown>>;
}

/** Document type to the fields it declares (system fields such as `_id` are left out). */
export type SchemaShape = Map<string, Map<string, SchemaField>>;

export const MUTATION_TITLES = {
  undeclared: "A write sets a field no document type declares",
  missing: "A create leaves out a field the schema requires",
  refAsString: "A reference is written as a plain string",
  noDrafts: "A write edits published content directly",
  shared: "Two routes write the same field",
} as const;

// ---------------------------------------------------------------------------------------------
// Reading the schema file
// ---------------------------------------------------------------------------------------------

const SCHEMA_HINT =
  "Write it with `npx sanity schema extract` (it makes schema.json), or point --schema at the file.";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A value node of the extracted schema is a reference: an object that dereferences, or whose _type is "reference". */
function isReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "union" && Array.isArray(value.of)) return value.of.some(isReference);
  if (value.type !== "object") return false;
  if (typeof value.dereferencesTo === "string") return true;
  const attrs = value.attributes;
  const t = isRecord(attrs) && isRecord(attrs._type) ? attrs._type : undefined;
  return isRecord(t?.value) && t.value.value === "reference";
}

/**
 * Read the text of a `sanity schema extract` file (schema.json): an array of documents, each with
 * its attributes. An attribute is required unless it says `optional: true`, which is how the
 * extract (and groq-js's schema type) writes it; a reference is an object that dereferences. Type
 * declarations (shared object types) are skipped: only documents are written to.
 */
export function readSchema(text: string, where = "schema.json"): SchemaShape {
  return parseSchemaExtract(text, where).documents;
}

/** The same read as readSchema, and the named type declarations too. */
export function parseSchemaExtract(text: string, where = "schema.json"): SchemaFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`${where} is not valid JSON, so --schema cannot read it.`, {
      hint: SCHEMA_HINT,
      cause,
    });
  }
  const bad = (): never => {
    throw new ConfigError(
      `${where} does not look like a schema extract, so --schema cannot read it.`,
      { hint: SCHEMA_HINT },
    );
  };
  if (!Array.isArray(parsed)) return bad();
  const schema: SchemaShape = new Map();
  const declarations = new Map<string, unknown>();
  const nodes = new Map<string, Map<string, unknown>>();
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.type !== "string") return bad();
    if (item.type === "type" && typeof item.name === "string")
      declarations.set(item.name, item.value);
    if (item.type !== "document") continue;
    if (typeof item.name !== "string" || !isRecord(item.attributes)) return bad();
    const fields = new Map<string, SchemaField>();
    const values = new Map<string, unknown>();
    for (const [name, attr] of Object.entries(item.attributes)) {
      if (name.startsWith("_") || !isRecord(attr)) continue;
      fields.set(name, { required: attr.optional !== true, reference: isReference(attr.value) });
      values.set(name, attr.value);
    }
    schema.set(item.name, fields);
    nodes.set(item.name, values);
  }
  return { documents: schema, declarations, nodes };
}

/** The schema file at `path`, with its type declarations. `what` names what needs it, in the message. */
export async function readSchemaFileFull(
  path: string,
  what = "Checking mutations",
): Promise<SchemaFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`The schema file ${path} could not be read. Point --schema at it.`, {
      hint: `${what} needs the schema. ${SCHEMA_HINT} Gaugeline makes no request to fetch it.`,
      cause,
    });
  }
  return parseSchemaExtract(withoutBom(text), path);
}

/** The schema file at `path`. A file that is not there is a ConfigError that names --schema. */
export async function readSchemaFile(path: string): Promise<SchemaShape> {
  return (await readSchemaFileFull(path)).documents;
}

// ---------------------------------------------------------------------------------------------
// Reading mutations from source
// ---------------------------------------------------------------------------------------------

/** The route a file serves, or the file itself when it is not a route handler. */
function routeOf(file: string): string {
  const parts = file.split("/");
  const base = parts[parts.length - 1] ?? "";
  const dirs = parts.slice(0, -1);
  const stem = base.replace(/\.[^.]+$/, "");
  if (stem === "route") {
    const app = dirs.lastIndexOf("app");
    const rest = (app >= 0 ? dirs.slice(app + 1) : dirs).filter((d) => !/^\(.*\)$/.test(d));
    return `/${rest.join("/")}`;
  }
  const pages = dirs.lastIndexOf("pages");
  if (pages >= 0 && dirs[pages + 1] === "api")
    return `/${[...dirs.slice(pages + 1), ...(stem === "index" ? [] : [stem])].join("/")}`;
  return file;
}

const WRITE_CALLS = new Set(["create", "createOrReplace", "createIfNotExists", "delete", "patch"]);
const STARTERS = new Set([...WRITE_CALLS, "transaction", "mutate"]);
const CREATES = new Set<MutationKind>(["create", "createOrReplace", "createIfNotExists"]);

/** Receivers that are called `client`, `sanity` and the like, and not the clients of other services. */
const CLIENT_NAME = /client|sanity/i;
const NOT_SANITY =
  /^(http|https|api|axios|got|ky|redis|prisma|stripe|supabase|resend|mail|smtp|db|pg|sql|grpc|graphql|s3|aws|rest|fetch|apollo|trpc)/i;
const DRAFT_NAME = /draft/i;

const isClientName = (name: string): boolean => CLIENT_NAME.test(name) && !NOT_SANITY.test(name);

interface Link {
  name: string;
  args: readonly TS.Expression[];
  call: TS.CallExpression;
  nameNode: TS.Identifier | TS.PrivateIdentifier;
}

/** The mutations in one file. */
function readFileMutations(ts: TypeScript, file: string, source: string): MutationExtraction {
  const text = withoutBom(source);
  const out: MutationExtraction = { shapes: [], unreadable: [] };
  const bad = firstSyntaxError(ts, file, text);
  if (bad !== null) {
    out.unreadable.push({ reason: "parse-error", source: { file, line: bad } });
    return out;
  }
  const kind =
    SCRIPT_KINDS(ts)[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const route = routeOf(file);
  const lineOf = (node: TS.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const at = (node: TS.Node): SourceRef => ({ file, line: lineOf(node) });

  // What each name stands for, when the file settles it: a name declared once, with const.
  const declared = new Map<string, { count: number; init?: TS.Expression }>();
  const note = (name: string, init?: TS.Expression): void => {
    const d = declared.get(name) ?? { count: 0 };
    d.count += 1;
    if (init) d.init = init;
    declared.set(name, d);
  };
  const noteBinding = (name: TS.BindingName): void => {
    if (ts.isIdentifier(name)) note(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) noteBinding(el.name);
  };
  const collect = (node: TS.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0;
      if (ts.isIdentifier(node.name)) note(node.name.text, isConst ? node.initializer : undefined);
      else noteBinding(node.name);
    } else if (ts.isParameter(node)) noteBinding(node.name);
    else if (ts.isFunctionDeclaration(node) && node.name) note(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const unwrap = (e: TS.Expression): TS.Expression => {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isAwaitExpression(cur)
    )
      cur = cur.expression;
    return cur;
  };
  /** The expression a name stands for, followed up to five times; the name itself when the file does not settle it. */
  const resolve = (e: TS.Expression, depth = 0): TS.Expression => {
    const cur = unwrap(e);
    if (ts.isIdentifier(cur) && depth < 5) {
      const d = declared.get(cur.text);
      if (d?.count === 1 && d.init) return resolve(d.init, depth + 1);
    }
    return cur;
  };
  const stringOf = (e: TS.Expression): string | null => {
    const r = resolve(e);
    return ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r) ? r.text : null;
  };
  const kindOf = (e: TS.Expression): ValueKind => {
    const r = resolve(e);
    if (
      ts.isStringLiteral(r) ||
      ts.isNoSubstitutionTemplateLiteral(r) ||
      ts.isTemplateExpression(r)
    )
      return "string";
    if (ts.isObjectLiteralExpression(r) && r.properties.some((p) => propName(p) === "_ref"))
      return "ref";
    return "other";
  };
  const propName = (p: TS.ObjectLiteralElementLike): string | null => {
    if (ts.isSpreadAssignment(p)) return null;
    const n = p.name;
    if (!n) return null;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isComputedPropertyName(n)) return stringOf(n.expression);
    return null;
  };
  const calleeName = (e: TS.CallExpression): string =>
    ts.isIdentifier(e.expression)
      ? e.expression.text
      : ts.isPropertyAccessExpression(e.expression)
        ? e.expression.name.text
        : "";

  /** Does an id (or a document, or a query) name a draft? */
  const draftish = (e: TS.Expression, inObject = false, depth = 0): boolean => {
    const r = resolve(e);
    if (depth > 4) return false;
    if (ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r))
      return r.text.startsWith("drafts.") || (inObject && r.text.includes("drafts."));
    if (ts.isTemplateExpression(r))
      return r.head.text.startsWith("drafts.") || (inObject && r.head.text.includes("drafts."));
    if (ts.isBinaryExpression(r) && r.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return draftish(r.left, inObject, depth + 1);
    if (ts.isConditionalExpression(r))
      return (
        draftish(r.whenTrue, inObject, depth + 1) || draftish(r.whenFalse, inObject, depth + 1)
      );
    if (ts.isArrayLiteralExpression(r))
      return r.elements.some((x) => draftish(x, inObject, depth + 1));
    if (ts.isObjectLiteralExpression(r))
      return r.properties.some(
        (p) => ts.isPropertyAssignment(p) && draftish(p.initializer, true, depth + 1),
      );
    if (ts.isCallExpression(r)) return DRAFT_NAME.test(calleeName(r));
    if (ts.isIdentifier(r)) return DRAFT_NAME.test(r.text);
    if (ts.isPropertyAccessExpression(r)) return DRAFT_NAME.test(r.name.text);
    return false;
  };

  interface State {
    partial: boolean;
  }
  const unreadable = (reason: MutationUnreadable["reason"], node: TS.Node): void => {
    out.unreadable.push({ reason, source: at(node) });
  };

  /** The keys of an object literal (or a const that holds one) into `into`, each with the kind of its value. */
  const readKeys = (
    e: TS.Expression,
    into: Map<string, ValueKind>,
    st: State,
    force?: ValueKind,
    depth = 0,
  ): void => {
    const r = resolve(e);
    if (!ts.isObjectLiteralExpression(r) || depth > 4) {
      st.partial = true;
      unreadable("variable-payload", e);
      return;
    }
    for (const p of r.properties) {
      if (ts.isSpreadAssignment(p)) {
        const inner = resolve(p.expression);
        if (ts.isObjectLiteralExpression(inner) && depth < 4)
          readKeys(inner, into, st, force, depth + 1);
        else st.partial = true;
        continue;
      }
      const name = propName(p);
      if (name === null) {
        st.partial = true;
        unreadable("variable-key", p);
        continue;
      }
      if (!into.has(name))
        into.set(name, force ?? (ts.isPropertyAssignment(p) ? kindOf(p.initializer) : "other"));
    }
  };
  /** Field names listed as strings: `unset(["a", "b"])`. */
  const readNames = (e: TS.Expression, into: Map<string, ValueKind>, st: State): void => {
    const r = resolve(e);
    if (!ts.isArrayLiteralExpression(r)) {
      st.partial = true;
      unreadable("variable-payload", e);
      return;
    }
    for (const el of r.elements) {
      const s = ts.isSpreadElement(el) ? null : stringOf(el);
      if (s === null) {
        st.partial = true;
        unreadable("variable-key", el);
      } else if (!into.has(s)) into.set(s, "other");
    }
  };
  /** A selector such as "tags[-1]" writes the field before the first bracket. */
  const readSelector = (e: TS.Expression, into: Map<string, ValueKind>, st: State): void => {
    const s = stringOf(e);
    if (s === null) {
      st.partial = true;
      unreadable("variable-key", e);
    } else if (!into.has(s)) into.set(s, "other");
  };

  /** One patch operation (`set`, `unset`, ...) and its arguments. */
  const applyPatchOp = (
    name: string,
    args: readonly TS.Expression[],
    into: Map<string, ValueKind>,
    st: State,
  ): void => {
    const first = args[0];
    if (first === undefined) return;
    switch (name) {
      case "set":
      case "setIfMissing":
        readKeys(first, into, st);
        break;
      case "inc":
      case "dec":
      case "diffMatchPatch":
        readKeys(first, into, st, "other");
        break;
      case "unset":
        readNames(first, into, st);
        break;
      case "append":
      case "prepend":
        if (stringOf(first) !== null) readSelector(first, into, st);
        else readKeys(first, into, st, "other");
        break;
      case "insert":
        if (args[1]) readSelector(args[1], into, st);
        break;
      default:
        break;
    }
  };
  /** The object form of a patch: `{ set: {...}, unset: [...] }`. */
  const applyPatchObject = (e: TS.Expression, into: Map<string, ValueKind>, st: State): void => {
    const r = resolve(e);
    if (!ts.isObjectLiteralExpression(r)) {
      st.partial = true;
      unreadable("variable-payload", e);
      return;
    }
    for (const p of r.properties) {
      if (ts.isSpreadAssignment(p)) {
        st.partial = true;
        continue;
      }
      const name = propName(p);
      if (name === null || !ts.isPropertyAssignment(p)) continue;
      if (name === "insert") {
        const ins = resolve(p.initializer);
        if (ts.isObjectLiteralExpression(ins))
          for (const q of ins.properties)
            if (
              ts.isPropertyAssignment(q) &&
              ["before", "after", "replace"].includes(propName(q) ?? "")
            )
              readSelector(q.initializer, into, st);
      } else applyPatchOp(name, [p.initializer], into, st);
    }
  };

  const blank = (kind: MutationKind, node: TS.Node): MutationShape => ({
    kind,
    sets: new Map(),
    touchesDrafts: false,
    route,
    source: at(node),
    partial: false,
  });

  /** A create, createOrReplace or createIfNotExists from its document argument. */
  const createShape = (kind: MutationKind, doc: TS.Expression | undefined, node: TS.Node) => {
    const shape = blank(kind, node);
    if (doc === undefined) return shape;
    const st: State = { partial: false };
    readKeys(doc, shape.sets, st);
    const r = resolve(doc);
    if (ts.isObjectLiteralExpression(r)) {
      for (const p of r.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const name = propName(p);
        if (name === "_type") {
          const t = stringOf(p.initializer);
          if (t !== null) shape.type = t;
        } else if (name === "_id") shape.touchesDrafts = draftish(p.initializer);
      }
    }
    shape.sets.delete("_type");
    shape.partial = st.partial;
    return shape;
  };

  /** A patch from its id and the operations applied to it. */
  const patchShape = (
    id: TS.Expression | undefined,
    ops: readonly { name: string; args: readonly TS.Expression[] }[],
    objectForm: TS.Expression | undefined,
    node: TS.Node,
  ): MutationShape => {
    const shape = blank("patch", node);
    const st: State = { partial: false };
    if (id !== undefined) shape.touchesDrafts = draftish(id);
    if (objectForm) applyPatchObject(objectForm, shape.sets, st);
    for (const op of ops) applyPatchOp(op.name, op.args, shape.sets, st);
    shape.partial = st.partial;
    return shape;
  };

  /** The chain of calls on an expression, innermost first, and what it started from. */
  const unchain = (e: TS.Expression): { root: TS.Expression; links: Link[] } => {
    const links: Link[] = [];
    let cur = unwrap(e);
    while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      links.unshift({
        name: cur.expression.name.text,
        args: cur.arguments,
        call: cur,
        nameNode: cur.expression.name,
      });
      cur = unwrap(cur.expression.expression);
    }
    return { root: cur, links };
  };
  const rootName = (root: TS.Expression): string | null => {
    if (ts.isIdentifier(root)) return root.text;
    if (ts.isPropertyAccessExpression(root)) return root.name.text;
    if (ts.isCallExpression(root) && ts.isIdentifier(root.expression)) return root.expression.text;
    return null;
  };

  /** The function form of a patch inside a transaction: `(p) => p.set({...}).inc({...})`. */
  const builderOps = (
    fn: TS.Expression,
  ): { name: string; args: readonly TS.Expression[] }[] | null => {
    const r = resolve(fn);
    if (!ts.isArrowFunction(r) && !ts.isFunctionExpression(r)) return null;
    let body: TS.Expression | undefined;
    if (ts.isArrowFunction(r) && !ts.isBlock(r.body)) body = r.body;
    else {
      const block = r.body as TS.Block;
      const ret = block.statements.find(ts.isReturnStatement);
      body = ret?.expression;
    }
    if (!body) return null;
    return unchain(body).links.map((l) => ({ name: l.name, args: l.args }));
  };

  /** One operation of a transaction, from a method call on it. */
  const opShape = (link: Link): MutationShape | null => {
    if (!WRITE_CALLS.has(link.name)) return null;
    const node = link.nameNode;
    if (link.name === "delete") {
      const shape = blank("delete", node);
      if (link.args[0]) shape.touchesDrafts = draftish(link.args[0], true);
      return shape;
    }
    if (link.name === "patch") {
      const second = link.args[1];
      const builder = second ? builderOps(second) : null;
      const shape = patchShape(
        link.args[0],
        builder ?? [],
        second && !builder ? second : undefined,
        node,
      );
      return shape;
    }
    return createShape(link.name as MutationKind, link.args[0], node);
  };

  /** The operations of a raw mutations array: `[{ create: {...} }, { patch: { id, set: {...} } }]`. */
  const rawOps = (array: TS.ArrayLiteralExpression, st: State): MutationShape[] => {
    const ops: MutationShape[] = [];
    for (const el of array.elements) {
      const r = ts.isSpreadElement(el) ? el : resolve(el);
      if (!ts.isObjectLiteralExpression(r)) {
        st.partial = true;
        if (!ts.isSpreadElement(el)) unreadable("variable-payload", el);
        continue;
      }
      const entry = r.properties.find(
        (p): p is TS.PropertyAssignment =>
          ts.isPropertyAssignment(p) && WRITE_CALLS.has(propName(p) ?? ""),
      );
      if (!entry) {
        st.partial = true;
        continue;
      }
      const name = propName(entry) as string;
      if (name === "delete") {
        const shape = blank("delete", r);
        shape.touchesDrafts = draftish(entry.initializer, true);
        ops.push(shape);
      } else if (name === "patch") {
        const body = resolve(entry.initializer);
        const shape = blank("patch", r);
        const pst: State = { partial: false };
        if (ts.isObjectLiteralExpression(body)) {
          shape.touchesDrafts = body.properties.some(
            (p) =>
              ts.isPropertyAssignment(p) &&
              ["id", "ids", "query"].includes(propName(p) ?? "") &&
              draftish(p.initializer, true),
          );
          applyPatchObject(body, shape.sets, pst);
        } else {
          pst.partial = true;
          unreadable("variable-payload", entry.initializer);
        }
        shape.partial = pst.partial;
        ops.push(shape);
      } else {
        ops.push(createShape(name as MutationKind, entry.initializer, r));
      }
    }
    return ops;
  };

  /** A transaction's own sets, drafts flag and partial flag, from the operations in it. */
  const fold = (tx: MutationShape, partial: boolean): MutationShape => {
    const ops = tx.ops ?? [];
    tx.sets = new Map();
    tx.touchesDrafts = false;
    tx.partial = partial || ops.some((o) => o.partial);
    for (const o of ops) {
      for (const [k, v] of o.sets) if (!tx.sets.has(k)) tx.sets.set(k, v);
      if (o.touchesDrafts) tx.touchesDrafts = true;
    }
    return tx;
  };
  const transactionOf = (node: TS.Node, ops: MutationShape[], partial: boolean): MutationShape => {
    const tx = blank("transaction", node);
    tx.ops = ops;
    return fold(tx, partial);
  };

  const processedArrays = new Set<TS.Node>();
  /** A raw mutations array as a transaction; null when the argument is not one the file settles. */
  const rawTransaction = (arg: TS.Expression, node: TS.Node): MutationShape | null => {
    const r = resolve(arg);
    if (!ts.isArrayLiteralExpression(r)) return null;
    if (processedArrays.has(r)) return null;
    processedArrays.add(r);
    const st: State = { partial: false };
    const ops = rawOps(r, st);
    return transactionOf(node, ops, st.partial);
  };

  const handled = new Set<TS.Node>();
  const txVars = new Map<string, MutationShape>();
  /** Transactions kept in a variable that were started from a payload the file does not settle. */
  const txPartial = new Set<MutationShape>();

  /** A call that nothing else is chained on: the end of a chain. */
  const isOutermost = (call: TS.CallExpression): boolean => {
    let parent = call.parent;
    while (
      ts.isParenthesizedExpression(parent) ||
      ts.isAwaitExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent)
    )
      parent = parent.parent;
    return !(
      ts.isPropertyAccessExpression(parent) &&
      parent.parent !== undefined &&
      ts.isCallExpression(parent.parent)
    );
  };

  const visitCall = (call: TS.CallExpression): void => {
    const { root, links } = unchain(call);
    const first = links[0];
    if (!first) return;
    const name = rootName(root);
    // A call on a transaction kept in a variable adds its operations to it.
    if (ts.isIdentifier(root) && txVars.has(root.text)) {
      const tx = txVars.get(root.text) as MutationShape;
      for (const link of links) {
        const op = opShape(link);
        if (op) tx.ops?.push(op);
      }
      fold(tx, txPartial.has(tx));
      return;
    }
    if (name === null || !isClientName(name) || !STARTERS.has(first.name)) return;
    const rest = links.slice(1);
    const node = first.nameNode;
    switch (first.name) {
      case "patch": {
        const second = first.args[1];
        const shape = patchShape(first.args[0], rest, second, node);
        // `const p = client.patch(id);` and the operations are added somewhere the walk cannot follow.
        if (rest.length === 0 && second === undefined && ts.isVariableDeclaration(call.parent)) {
          shape.partial = true;
          unreadable("variable-payload", node);
        }
        out.shapes.push(shape);
        break;
      }
      case "create":
      case "createOrReplace":
      case "createIfNotExists":
        out.shapes.push(createShape(first.name, first.args[0], node));
        break;
      case "delete": {
        const shape = blank("delete", node);
        if (first.args[0]) shape.touchesDrafts = draftish(first.args[0], true);
        out.shapes.push(shape);
        break;
      }
      case "transaction": {
        const arg = first.args[0];
        let ops: MutationShape[] = [];
        let partial = false;
        if (arg) {
          const raw = rawTransaction(arg, node);
          if (raw) ops = raw.ops ?? [];
          else {
            partial = true;
            unreadable("variable-payload", arg);
          }
        }
        for (const link of rest) {
          const op = opShape(link);
          if (op) ops.push(op);
        }
        out.shapes.push(transactionOf(node, ops, partial));
        break;
      }
      case "mutate": {
        const arg = first.args[0];
        if (!arg) break;
        const r = resolve(arg);
        if (ts.isArrayLiteralExpression(r)) {
          const tx = rawTransaction(r, node);
          if (tx) out.shapes.push(tx);
        } else {
          unreadable("variable-payload", arg);
          out.shapes.push(transactionOf(node, [], true));
        }
        break;
      }
      default:
        break;
    }
  };

  const visit = (node: TS.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const { root, links } = unchain(node.initializer);
      const rn = rootName(root);
      if (
        links.length === 1 &&
        links[0]?.name === "transaction" &&
        rn !== null &&
        isClientName(rn)
      ) {
        const link = links[0];
        const ops: MutationShape[] = [];
        let partial = false;
        const arg = link.args[0];
        if (arg) {
          const raw = rawTransaction(arg, link.nameNode);
          if (raw) ops.push(...(raw.ops ?? []));
          else partial = true;
        }
        const tx = transactionOf(link.nameNode, ops, partial);
        if (partial) txPartial.add(tx);
        txVars.set(node.name.text, tx);
        out.shapes.push(tx);
        handled.add(node.initializer);
        handled.add(unwrap(node.initializer));
      }
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      propName(node) === "mutations"
    ) {
      const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      const r = resolve(value);
      if (
        ts.isArrayLiteralExpression(r) &&
        !processedArrays.has(r) &&
        r.elements.some((el) => {
          const o = ts.isSpreadElement(el) ? null : resolve(el);
          return (
            o !== null &&
            ts.isObjectLiteralExpression(o) &&
            o.properties.some(
              (p) => ts.isPropertyAssignment(p) && WRITE_CALLS.has(propName(p) ?? ""),
            )
          );
        })
      ) {
        const tx = rawTransaction(r, node);
        if (tx) out.shapes.push(tx);
      }
    }
    if (ts.isCallExpression(node) && !handled.has(node) && isOutermost(node)) visitCall(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Find the writes in the files under `dir`: client.patch(...).set(...), create, createOrReplace,
 * createIfNotExists, delete, client.transaction() chains (also kept in a variable), raw mutations
 * arrays (client.mutate([...]) or a `mutations` key in a request body), in route handlers and
 * everywhere else, by reading the code with the TypeScript compiler. The code is never run and
 * nothing is sent. A field name or payload the file does not settle comes back in `unreadable`.
 */
export async function readMutations(
  dir: string,
  options: MutationExtractOptions = {},
): Promise<MutationExtraction> {
  const root = await sourceRoot(dir);
  const ts = await loadCompiler(options.loadTypeScript ?? importTypeScript);
  const result: MutationExtraction = { shapes: [], unreadable: [] };
  for (const file of await walk(root)) {
    const found = readFileMutations(ts, file, await readFile(join(root, file), "utf8"));
    result.shapes.push(...found.shapes);
    result.unreadable.push(...found.unreadable);
  }
  return result;
}

/** The mutations under `dir`, as shapes. */
export async function extractMutations(
  dir: string,
  options: MutationExtractOptions = {},
): Promise<MutationShape[]> {
  return (await readMutations(dir, options)).shapes;
}

// ---------------------------------------------------------------------------------------------
// Checking mutations against the schema
// ---------------------------------------------------------------------------------------------

/** The operations of every shape, a transaction replaced by what is in it. */
function leaves(shapes: readonly MutationShape[]): MutationShape[] {
  return shapes.flatMap((s) => (s.kind === "transaction" ? leaves(s.ops ?? []) : [s]));
}

/** "status.x" and "tags[0]" are the field "status" and "tags". */
const topField = (key: string): string => key.split(/[.[]/)[0] ?? "";

const esc = (text: string, max = 80): string => escapeInvisible(text, max);
const where = (s: MutationShape): string => `${esc(s.source.file, 200)}:${s.source.line}`;

/**
 * Five findings, each with the file and line of the write. A patch names no type, so a field it
 * writes is looked up in every type: it is undeclared when no type declares it, and it is a
 * reference written as a string only when every type that declares it says reference. A field
 * that one type declares has that type for the shared-field rule; a field several types declare
 * cannot be attributed, so a patch of it is not compared. A create names its type and is checked
 * against it. A write with a part that could not be read (`partial`) is checked on the keys that
 * are visible, and is never reported as missing a field the unread part may carry.
 */
export function checkMutations(shapes: readonly MutationShape[], schema: SchemaShape): Finding[] {
  const out: Finding[] = [];
  const declaring = (name: string): string[] =>
    [...schema].filter(([, fields]) => fields.has(name)).map(([type]) => type);
  const shared = new Map<
    string,
    { type: string; field: string; routes: Map<string, MutationShape> }
  >();

  for (const s of leaves(shapes)) {
    const source = { file: s.source.file, line: s.source.line };
    const writes = s.kind === "patch" || CREATES.has(s.kind);
    const typed = s.type !== undefined && schema.has(s.type) ? s.type : undefined;
    const label = s.type !== undefined ? esc(s.type, 60) : undefined;
    const url = `sanity:${label ?? "mutation"}`;

    if (writes) {
      // A create that names an unknown type, or none, has nothing to be checked against.
      const checkable = s.kind === "patch" || typed !== undefined;
      for (const [key, value] of s.sets) {
        const name = topField(key);
        if (name === "" || name.startsWith("_") || !checkable) continue;
        const types = (typed !== undefined ? [typed] : declaring(name)).filter((t) =>
          schema.get(t)?.has(name),
        );
        if (types.length === 0) {
          out.push({
            checkId: "mutation-undeclared-field",
            severity: "high",
            title: MUTATION_TITLES.undeclared,
            evidence: `${where(s)}  This ${s.kind} writes ${esc(key)}, and ${
              typed !== undefined
                ? `the ${esc(typed, 60)} type does not declare it`
                : "no document type in the schema declares it"
            }. Sanity stores it anyway, but the Studio shows no field for it and nothing the schema validates will see it.`,
            url,
            source,
          });
          continue;
        }
        if (
          key === name &&
          value === "string" &&
          types.every((t) => schema.get(t)?.get(name)?.reference === true)
        )
          out.push({
            checkId: "mutation-ref-as-string",
            severity: "high",
            title: MUTATION_TITLES.refAsString,
            evidence: `${where(s)}  ${esc(name)} is a reference, and this ${s.kind} gives it a plain string. A reference is an object: { _type: "reference", _ref: "the document's id" }.`,
            url,
            source,
          });
      }
      // Missing required fields: a whole document, written in full, that the code can see.
      if (CREATES.has(s.kind) && typed !== undefined && !s.partial) {
        const have = new Set([...s.sets.keys()].map(topField));
        for (const [name, f] of schema.get(typed) ?? [])
          if (f.required && !name.startsWith("_") && !have.has(name))
            out.push({
              checkId: "mutation-missing-required",
              severity: "high",
              title: MUTATION_TITLES.missing,
              evidence: `${where(s)}  This ${s.kind} of ${esc(typed, 60)} leaves out ${esc(name)}, which the schema marks required. The document is saved, and the Studio shows it as invalid.`,
              url,
              source,
            });
      }
    }

    if (
      (s.kind === "patch" || s.kind === "createOrReplace" || s.kind === "delete") &&
      !s.touchesDrafts
    )
      out.push({
        checkId: "mutation-no-drafts",
        severity: "medium",
        title: MUTATION_TITLES.noDrafts,
        evidence: `${where(s)}  This ${s.kind} has no drafts handling: its id is not a drafts. id, so it changes the published document directly and an editor's unpublished edits can be lost or published.`,
        url,
        source,
      });

    // A create makes a new document, so two routes that create one are not sharing a field.
    if (s.kind === "patch" || s.kind === "createOrReplace" || s.kind === "createIfNotExists") {
      for (const key of s.sets.keys()) {
        const name = topField(key);
        if (name === "" || name.startsWith("_")) continue;
        const type = typed ?? (s.type === undefined ? declaring(name) : [])[0];
        const unique = typed !== undefined || declaring(name).length === 1;
        if (type === undefined || !unique) continue;
        const id = `${type}.${name}`;
        const entry = shared.get(id) ?? { type, field: name, routes: new Map() };
        if (!entry.routes.has(s.route)) entry.routes.set(s.route, s);
        shared.set(id, entry);
      }
    }
  }

  for (const [id, e] of shared) {
    if (e.routes.size < 2) continue;
    const writers = [...e.routes.values()];
    const first = writers[0] as MutationShape;
    out.push({
      checkId: "mutation-shared-field",
      severity: "medium",
      title: MUTATION_TITLES.shared,
      evidence: `${esc(id, 140)} is written by ${e.routes.size} routes: ${writers.map(where).join(", ")}. If they disagree about its value the last write wins, which is where drift starts. Fine if they are meant to share it.`,
      url: `sanity:${esc(e.type, 60)}`,
      source: { file: first.source.file, line: first.source.line },
    });
  }
  return out;
}
