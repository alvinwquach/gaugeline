import { parse } from "groq-js";
import type { GqlFragment, GqlOperation, GqlSelection } from "./graphql-parse.js";
import type { SourceRef } from "./shape.js";

/**
 * The fields a query returns, as the code that reads the result sees them: a tree with one node for
 * each field, named by its alias ("slug": slug.current is `slug`). This file builds the tree from a
 * GROQ string or a GraphQL operation and does nothing else: no file, no network, no environment.
 * The walk through the code (unused-flow.ts) marks nodes as read; unused.ts reports the rest.
 */

/** One query, and what is known about following its result. */
export interface QueryState {
  language: "groq" | "graphql";
  /** Where the query starts (a GraphQL operation: the line of its `query` keyword). */
  source: SourceRef;
  root: TreeNode;
  /** Set when the result escapes the analysis: the sentence that says how. The first reason is kept. */
  couldNot: string | null;
}

export interface TreeNode {
  /** Unique across a run, for the walk's visited set. */
  id: number;
  /** The name the code reads: the alias when there is one. "" for the root. */
  alias: string;
  /** The aliases from the root, joined with ".": "author.bio". */
  path: string;
  /**
   * Whether the value at this node is an array of its shape. GROQ knows ("body[]{...}" is a list);
   * GraphQL does not without the schema, so it says "maybe" and the walk accepts both.
   */
  list: boolean | "maybe";
  children: Map<string, TreeNode>;
  /** Where the field is written: the query, or the fragment that holds it. */
  source: SourceRef;
  /** The fragment the field came from, when it did. */
  via?: { name: string; source: SourceRef };
  /** True once the code reads it, or hands the object that holds it to code the walk cannot open. */
  used: boolean;
  query: QueryState;
}

let nextId = 1;

function node(
  query: QueryState,
  parent: TreeNode | null,
  alias: string,
  list: boolean | "maybe",
  source: SourceRef,
  via?: TreeNode["via"],
): TreeNode {
  return {
    id: nextId++,
    alias,
    path: parent === null || parent.path === "" ? alias : `${parent.path}.${alias}`,
    list,
    children: new Map(),
    source,
    ...(via ? { via } : {}),
    used: false,
    query,
  };
}

/** A query whose result has no fields to read (a count, a list of strings). */
export function emptyQuery(
  language: QueryState["language"],
  source: SourceRef,
  couldNot: string | null,
): QueryState {
  const q = { language, source, couldNot } as QueryState;
  q.root = node(q, null, "", false, source);
  return q;
}

// ---------------------------------------------------------------------------------------------
// GROQ

/** The nodes groq-js returns, read by name. */
interface GroqNode {
  type: string;
  [key: string]: unknown;
}

const isNode = (v: unknown): v is GroqNode =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

const unwrap = (n: unknown): unknown => {
  let cur = n;
  while (isNode(cur) && cur.type === "Group") cur = cur.base;
  return cur;
};

/** What a value is, when it is made of named fields: whether it is a list, and the attributes of its projection. */
interface Shape {
  list: boolean;
  attrs: unknown[];
}

/** A base that is an array before the projection is applied: `*[...]{...}` reads each element. */
const LIST_BASES = new Set(["Everything", "Filter", "ArrayCoerce", "Slice", "PipeFuncCall", "Map"]);

function shapeOf(expr: unknown): Shape | null {
  const n = unwrap(expr);
  if (!isNode(n)) return null;
  switch (n.type) {
    case "Map":
    case "FlatMap": {
      const element = shapeOf(n.expr);
      return element ? { list: true, attrs: element.attrs } : null;
    }
    case "Projection": {
      const body = unwrap(n.expr);
      if (!isNode(body) || body.type !== "Object" || !Array.isArray(body.attributes)) return null;
      const base = unwrap(n.base);
      return {
        list: isNode(base) && LIST_BASES.has(base.type),
        attrs: body.attributes as unknown[],
      };
    }
    case "Object":
      return Array.isArray(n.attributes) ? { list: false, attrs: n.attributes as unknown[] } : null;
    case "AccessElement": {
      const inner = shapeOf(n.base);
      return inner ? { list: false, attrs: inner.attrs } : null;
    }
    case "Slice":
    case "Filter":
    case "PipeFuncCall":
      return shapeOf(n.base);
    default:
      return null;
  }
}

function fill(query: QueryState, into: TreeNode, shape: Shape, source: SourceRef): void {
  for (const attr of shape.attrs) {
    // `...` and `...select()` add fields that are not named in the query: nothing to report there.
    if (!isNode(attr) || attr.type !== "ObjectAttributeValue" || typeof attr.name !== "string")
      continue;
    const inner = shapeOf(attr.value);
    const child = node(query, into, attr.name, inner?.list ?? false, source);
    if (inner) fill(query, child, inner, source);
    // A later attribute of the same name replaces the earlier one, as it does in the result.
    into.children.set(attr.name, child);
  }
}

/**
 * The fields a GROQ query returns, by alias, with whether each is a list. `null` when the string is
 * not GROQ. A query that returns no object (a count, `*[...].title`) comes back with a root that
 * has no children: there are no fields to report on it.
 */
export function groqTree(text: string, source: SourceRef): QueryState | null {
  let tree: unknown;
  try {
    tree = parse(text);
  } catch {
    return null;
  }
  const query = emptyQuery("groq", source, null);
  const shape = shapeOf(tree);
  if (shape) {
    query.root.list = shape.list;
    fill(query, query.root, shape, source);
  }
  return query;
}

// ---------------------------------------------------------------------------------------------
// GraphQL

export type FragmentMap = ReadonlyMap<string, GqlFragment & { file: string }>;

/**
 * The fields a GraphQL operation selects, by alias, with the fragments it spreads read in place:
 * a field selected in a fragment is a field of the query. `unknown` lists the fragment names that no
 * file defines (the operation cannot be followed with a part missing).
 */
export function gqlTree(
  op: GqlOperation,
  file: string,
  fragments: FragmentMap,
): { query: QueryState; unknown: string[] } {
  const at: SourceRef = { file, line: op.line };
  const query = emptyQuery("graphql", at, null);
  const unknown = new Set<string>();
  const add = (
    into: TreeNode,
    selections: readonly GqlSelection[],
    source: SourceRef,
    via: TreeNode["via"] | undefined,
    spreading: ReadonlySet<string>,
  ): void => {
    for (const sel of selections) {
      if (sel.kind === "field") {
        // __typename, __schema and __type are the server's own, in every schema.
        if (sel.name.startsWith("__")) continue;
        const key = sel.alias ?? sel.name;
        let child = into.children.get(key);
        if (!child) {
          child = node(query, into, key, "maybe", source, via);
          into.children.set(key, child);
        }
        if (sel.selections) add(child, sel.selections, source, via, spreading);
      } else if (sel.kind === "inline") {
        add(into, sel.selections, source, via, spreading);
      } else {
        const fragment = fragments.get(sel.name);
        if (!fragment) {
          unknown.add(sel.name);
          continue;
        }
        // A fragment that spreads itself is read once.
        if (spreading.has(fragment.name)) continue;
        const where: SourceRef = { file: fragment.file, line: fragment.line };
        add(
          into,
          fragment.selections,
          where,
          { name: fragment.name, source: where },
          new Set([...spreading, fragment.name]),
        );
      }
    }
  };
  add(query.root, op.selections, at, undefined, new Set());
  return { query, unknown: [...unknown].sort() };
}
