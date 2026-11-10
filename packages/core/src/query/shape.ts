import { parse } from "groq-js";

/** Where a query starts: the file (relative to the folder that was read, with `/`) and the 1-based line. */
export interface SourceRef {
  file: string;
  line: number;
}

/**
 * One field a query reads, as a path from the document: "slug.current", "topic->title",
 * "body[].children". `deref` is true when the path crosses a reference (`->`).
 */
export interface FieldUse {
  path: string;
  deref: boolean;
  source: SourceRef;
}

/** What one query asks of one document type. A query that filters on two types gives two of these. */
export interface QueryShape {
  type: string;
  fields: FieldUse[];
  /** True when the filter itself leaves drafts out (`!(_id in path("drafts.**"))`). */
  excludesDrafts: boolean;
  /** The `$names` the query takes, sorted, without the `$`. */
  params: string[];
  source: SourceRef;
}

/** A query that was found and not read. Never skipped silently, never guessed. */
export interface Unreadable {
  /**
   * concatenated: built from a template with a `${...}`, a `+`, or anything that is not one literal.
   * parse-error: a file that does not parse as TypeScript, or a string that is not valid GROQ.
   * no-type-filter: it parsed, but nothing in it filters on `_type`, so there is no type to attribute.
   */
  reason: "concatenated" | "parse-error" | "no-type-filter";
  source: SourceRef;
}

/** The nodes groq-js returns, read by name. Only the properties this file touches are named. */
interface Node {
  type: string;
  [key: string]: unknown;
}

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** The documents of one `*[...]` set, and the fields read from them. */
interface DocSet {
  /** null until a filter names one. */
  types: string[] | null;
  excludesDrafts: boolean;
  /** A Set keeps the order a path was first read and counts a field read twice once. */
  fields: Set<string>;
}

/** Where `this` is: inside the documents of `set`, at `path` (attribute names, "[]" and "->"). */
interface Place {
  set: DocSet;
  path: readonly string[];
}

interface Scope {
  here: Place | null;
  /** The scope `^` refers to. */
  up: Scope | null;
  /** True where a path that is read is a field the query returns (a projection value). */
  record: boolean;
}

/** Nodes that read a path from `this`: a field is recorded when one of these is a projection value. */
const CHAIN = new Set([
  "AccessAttribute",
  "AccessElement",
  "ArrayCoerce",
  "Deref",
  "Filter",
  "Group",
  "Parent",
  "PipeFuncCall",
  "Slice",
  "This",
]);

function renderPath(path: readonly string[]): string {
  let out = "";
  for (const seg of path) {
    if (seg === "[]" || seg === "->") out += seg;
    else out += out === "" || out.endsWith("->") ? seg : `.${seg}`;
  }
  // The array itself is the field: `body[]{...}` reads "body".
  while (out.endsWith("[]")) out = out.slice(0, -2);
  return out;
}

const unwrap = (n: unknown): unknown => {
  let cur = n;
  while (isNode(cur) && cur.type === "Group") cur = cur.base;
  return cur;
};

const isAttr = (n: unknown, name: string): boolean =>
  isNode(n) && n.type === "AccessAttribute" && n.base === undefined && n.name === name;

const stringValue = (n: unknown): string | null =>
  isNode(n) && n.type === "Value" && typeof n.value === "string" ? n.value : null;

/** The `_type` values a filter pins the documents to, or null when it does not pin them. */
function typesOf(expr: unknown): string[] | null {
  const n = unwrap(expr);
  if (!isNode(n)) return null;
  if (n.type === "OpCall" && n.op === "==") {
    const left = stringValue(n.left);
    const right = stringValue(n.right);
    if (isAttr(n.left, "_type") && right !== null) return [right];
    if (isAttr(n.right, "_type") && left !== null) return [left];
    return null;
  }
  if (n.type === "OpCall" && n.op === "in" && isAttr(n.left, "_type")) {
    const list = unwrap(n.right);
    if (!isNode(list) || list.type !== "Array" || !Array.isArray(list.elements)) return null;
    const out: string[] = [];
    for (const el of list.elements as unknown[]) {
      const v = isNode(el) && el.isSplat !== true ? stringValue(el.value) : null;
      if (v === null) return null;
      out.push(v);
    }
    return out;
  }
  if (n.type === "And") {
    const l = typesOf(n.left);
    const r = typesOf(n.right);
    if (l && r) return l.filter((t) => r.includes(t));
    return l ?? r;
  }
  if (n.type === "Or") {
    const l = typesOf(n.left);
    const r = typesOf(n.right);
    return l && r ? [...l, ...r.filter((t) => !l.includes(t))] : null;
  }
  return null;
}

/** `!(_id in path("drafts.**"))` and `!(_id match "drafts.**")`. */
function isDraftExclusion(n: Node): boolean {
  if (n.type !== "Not") return false;
  const inner = unwrap(n.base);
  if (!isNode(inner) || inner.type !== "OpCall" || !isAttr(inner.left, "_id")) return false;
  const right = unwrap(inner.right);
  if (inner.op === "match") return stringValue(right)?.startsWith("drafts.") === true;
  if (inner.op === "in" && isNode(right) && right.type === "FuncCall" && right.name === "path") {
    const arg = Array.isArray(right.args) ? (right.args as unknown[])[0] : undefined;
    return stringValue(arg)?.startsWith("drafts.") === true;
  }
  return false;
}

/** True when some condition that must hold for every document (an `&&` chain) leaves drafts out. */
function excludesDraftsIn(expr: unknown): boolean {
  const n = unwrap(expr);
  if (!isNode(n)) return false;
  if (n.type === "And") return excludesDraftsIn(n.left) || excludesDraftsIn(n.right);
  return isDraftExclusion(n);
}

class Reader {
  readonly sets: DocSet[] = [];
  readonly params = new Set<string>();
  private readonly made = new Map<Node, DocSet>();
  private readonly filtered = new Set<Node>();

  /** What `node` is, as a place inside a set of documents; null when it is not one. */
  origin(node: unknown, scope: Scope): Place | null {
    if (!isNode(node)) return null;
    switch (node.type) {
      case "Everything": {
        let set = this.made.get(node);
        if (!set) {
          set = { types: null, excludesDrafts: false, fields: new Set() };
          this.made.set(node, set);
          this.sets.push(set);
        }
        return { set, path: [] };
      }
      case "Filter": {
        const base = this.origin(node.base, scope);
        // A filter on the documents themselves pins their type or their draft state; a filter on
        // an array field (`items[price > 1]`) leaves the path as it is.
        if (base && base.path.length === 0 && !this.filtered.has(node)) {
          this.filtered.add(node);
          const types = typesOf(node.expr);
          if (types) {
            if (base.set.types === null) base.set.types = types;
            else {
              const have = base.set.types;
              base.set.types = have.filter((t) => types.includes(t));
            }
          }
          if (excludesDraftsIn(node.expr)) base.set.excludesDrafts = true;
        }
        // `items[price > 1].label` reads label of each element, like `items[].label`.
        if (base && base.path.length > 0 && base.path[base.path.length - 1] !== "[]")
          return { set: base.set, path: [...base.path, "[]"] };
        return base;
      }
      case "AccessElement":
      case "Slice":
      case "PipeFuncCall":
      case "Group":
        return this.origin(node.base, scope);
      case "ArrayCoerce": {
        const base = this.origin(node.base, scope);
        return base && base.path.length > 0 ? { set: base.set, path: [...base.path, "[]"] } : base;
      }
      case "AccessAttribute": {
        const base = node.base === undefined ? scope.here : this.origin(node.base, scope);
        return base && typeof node.name === "string"
          ? { set: base.set, path: [...base.path, node.name] }
          : null;
      }
      case "Deref": {
        const base = this.origin(node.base, scope);
        return base && base.path.length > 0 ? { set: base.set, path: [...base.path, "->"] } : null;
      }
      case "This":
        return scope.here;
      case "Parent": {
        let s: Scope | null = scope;
        for (let i = 0; i < (typeof node.n === "number" ? node.n : 1); i++) s = s?.up ?? null;
        return s?.here ?? null;
      }
      default:
        return null;
    }
  }

  private record(place: Place): void {
    const path = renderPath(place.path);
    if (path !== "") place.set.fields.add(path);
  }

  visit(node: unknown, scope: Scope): void {
    if (!isNode(node)) return;
    const quiet: Scope = { ...scope, record: false };
    if (CHAIN.has(node.type) && scope.record) {
      const place = this.origin(node, scope);
      if (place) this.record(place);
    }
    switch (node.type) {
      case "Parameter":
        if (typeof node.name === "string") this.params.add(node.name);
        return;
      case "Everything":
        this.origin(node, scope);
        return;
      case "Filter": {
        this.origin(node, scope);
        this.visit(node.base, quiet);
        this.visit(node.expr, { here: this.origin(node.base, scope), up: scope, record: false });
        return;
      }
      case "Map":
      case "FlatMap":
        this.visit(node.base, quiet);
        this.visit(node.expr, { here: this.origin(node.base, scope), up: scope, record: true });
        return;
      case "Projection": {
        this.visit(node.base, quiet);
        // `{...}` right after `*[...]` or `field[]` projects the element the Map is already on,
        // so `^` inside it still means the scope outside the Map.
        const sameElement = isNode(node.base) && node.base.type === "This";
        this.visit(node.expr, {
          here: this.origin(node.base, scope),
          up: sameElement ? scope.up : scope,
          record: true,
        });
        return;
      }
      default: {
        // Everything else: its children, in the same scope. A path being read stops being a field
        // of its own below the node that was recorded.
        const inner = CHAIN.has(node.type) ? quiet : scope;
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) for (const v of value) this.visit(v, inner);
          else this.visit(value, inner);
        }
      }
    }
  }
}

/**
 * Read one GROQ query into the shapes it asks for. Parses it with groq-js and walks the tree: the
 * `_type` filter, every field the projections read (through renames, references and nested
 * objects), whether the filter leaves drafts out, and the `$parameters`. Makes no request.
 * Returns `unreadable` instead of a shape when the string is not GROQ, or has no `_type` filter.
 */
export function readGroq(
  query: string,
  source: SourceRef,
): { shapes: QueryShape[]; unreadable: Unreadable[] } {
  let tree: unknown;
  try {
    tree = parse(query);
  } catch {
    // groq-js throws a syntax error for bad text and a query error for a projection it cannot
    // name (`{ a.b }`); either way the string is not a query that can be read.
    return { shapes: [], unreadable: [{ reason: "parse-error", source: { ...source } }] };
  }
  const reader = new Reader();
  reader.visit(tree, { here: null, up: null, record: true });
  const params = [...reader.params].sort();
  const shapes: QueryShape[] = [];
  let untyped = reader.sets.length === 0;
  for (const set of reader.sets) {
    if (set.types === null || set.types.length === 0) {
      untyped = true;
      continue;
    }
    for (const type of set.types) {
      shapes.push({
        type,
        fields: [...set.fields].map((path) => ({
          path,
          deref: path.includes("->"),
          source: { ...source },
        })),
        excludesDrafts: set.excludesDrafts,
        params: [...params],
        source: { ...source },
      });
    }
  }
  return {
    shapes,
    unreadable: untyped ? [{ reason: "no-type-filter", source: { ...source } }] : [],
  };
}
