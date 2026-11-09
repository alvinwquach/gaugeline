/** One line of the structured data tree: a key, what it holds if it is a value, and its fields. */
export interface Node {
  key: string;
  value?: string;
  children?: Node[];
}

/** Levels below this are not built: a block can be as deep as the page's author made it. */
export const MAX_DEPTH = 24;
/** Nodes beyond this many are counted, not built. */
export const MAX_NODES = 2000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An object's @type as text: "Product", or "Product, Thing" for a list. */
function typeOf(obj: Record<string, unknown>): string | undefined {
  const t = obj["@type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string"))
    return (t as string[]).join(", ");
  return undefined;
}

function scalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "null";
  return String(v);
}

/**
 * A structured data block as a list of nodes, depth first: the fields of an object, the items of
 * an array (keyed by place), @graph members like any other list. An object with an @type has it
 * as its value, so "offers: Offer" reads without braces. A string where an object was expected is
 * just a value. Plain data: the view draws it as text.
 */
export function toTree(block: unknown): Node[] {
  const budget = { nodes: 0, left: 0 };
  const build = (value: unknown, depth: number): Node[] | string => {
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      return entries(
        value.map((v, i) => [String(i), v] as const),
        depth,
      );
    }
    if (isObject(value)) {
      const keys = Object.entries(value);
      if (keys.length === 0) return "{}";
      return entries(keys, depth);
    }
    return scalar(value);
  };
  const entries = (list: readonly (readonly [string, unknown])[], depth: number): Node[] => {
    const out: Node[] = [];
    for (const [i, [key, v]] of list.entries()) {
      if (budget.nodes >= MAX_NODES) {
        budget.left += list.length - i;
        const left = budget.left;
        out.push({
          key: "\u2026",
          value: `${left} more field${left === 1 ? "" : "s"} ${left === 1 ? "is" : "are"} not shown.`,
        });
        return out;
      }
      budget.nodes += 1;
      if (
        key === "@type" &&
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => typeof x === "string")
      ) {
        out.push({ key, value: (v as string[]).join(", ") });
        continue;
      }
      if (isObject(v) || Array.isArray(v)) {
        if (depth >= MAX_DEPTH) {
          out.push({ key, value: "Deeper levels are not shown." });
          continue;
        }
        const inner = build(v, depth + 1);
        const type = isObject(v) ? typeOf(v) : undefined;
        out.push(
          typeof inner === "string"
            ? { key, value: inner }
            : { key, ...(type ? { value: type } : {}), children: inner },
        );
      } else out.push({ key, value: scalar(v) });
    }
    return out;
  };
  if (!isObject(block) && !Array.isArray(block)) return [{ key: "value", value: scalar(block) }];
  const top = build(block, 0);
  return typeof top === "string" ? [{ key: "value", value: top }] : top;
}

/** What a block is, in a few words: its type, the types in its @graph or list, or "No type given". */
export function blockTitle(block: unknown): string {
  const types: string[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (isObject(v)) {
      if (Array.isArray(v["@graph"])) visit(v["@graph"], depth + 1);
      else {
        const t = typeOf(v);
        if (t) types.push(t);
      }
    }
  };
  visit(block, 0);
  return types.length > 0 ? types.join(", ") : "No type given";
}
