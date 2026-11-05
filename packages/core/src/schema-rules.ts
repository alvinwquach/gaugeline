import * as z from "zod";

/**
 * A team's schema guide, as data: the fixed Organization and WebSite @id values, the types each
 * page template must carry, and the breadcrumb rules. Read from gaugeline.schema.json until the
 * config file (G29) lands.
 */
export const schemaRulesSchema = z.strictObject({
  organizationId: z.string().min(1).optional(),
  websiteId: z.string().min(1).optional(),
  templates: z
    .array(z.strictObject({ match: z.string().min(1), require: z.array(z.string().min(1)).min(1) }))
    .optional(),
  breadcrumbs: z
    .strictObject({ firstName: z.string().min(1), firstUrl: z.string().min(1) })
    .optional(),
});

export type SchemaRules = z.infer<typeof schemaRulesSchema>;

/** "/blog/*" matches one path segment per *, "**" any depth; the match is on the whole path. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}/?$`);
}

/** How specific a pattern is: more literal characters, then fewer wildcards, wins. */
function specificity(glob: string): [number, number] {
  return [glob.replace(/\*/g, "").length, -(glob.match(/\*/g)?.length ?? 0)];
}

/** The most specific template whose pattern matches the path, or undefined. */
export function matchTemplate<T extends { match: string }>(
  path: string,
  templates: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const t of templates) {
    if (!globToRegex(t.match).test(path)) continue;
    if (!best) {
      best = t;
      continue;
    }
    const [a1, a2] = specificity(t.match);
    const [b1, b2] = specificity(best.match);
    if (a1 > b1 || (a1 === b1 && a2 > b2)) best = t;
  }
  return best;
}

/** An @id compared after normalisation: resolved against the page, host lowercased, no trailing slash. */
export function normaliseId(raw: string, base: string): string {
  try {
    const u = new URL(raw.trim(), base);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}${u.hash}`;
  } catch {
    return raw.trim();
  }
}

/** One JSON-LD node. */
export interface SchemaNode {
  id?: string;
  rawId?: string;
  types: string[];
  /** Properties other than @id, @type and @context. */
  props: string[];
  value: Record<string, unknown>;
}

/** Everything one page's JSON-LD says, flattened. */
export interface FlatSchema {
  /** Nodes with an @id, by normalised @id. A node defined twice keeps both property sets merged. */
  byId: Map<string, SchemaNode>;
  unnamed: SchemaNode[];
  /** {"@id": ...} references (objects with nothing but an @id), with the raw value. */
  refs: { id: string; raw: string }[];
  types: Set<string>;
}

function typesOf(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.replace(/^https?:\/\/(?:www\.)?schema\.org\//i, "").replace(/^schema:/i, ""));
}

/**
 * Flatten parsed JSON-LD (single objects, arrays, @graph, nested nodes with their own @id) into a
 * Map keyed by @id plus the nodes without one, with an explicit stack (untrusted input).
 */
export function flattenSchema(jsonLd: unknown, base: string): FlatSchema {
  const flat: FlatSchema = { byId: new Map(), unnamed: [], refs: [], types: new Set() };
  const stack: unknown[] = [jsonLd];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== "@context");
    const rawId = typeof obj["@id"] === "string" ? obj["@id"] : undefined;
    if (rawId !== undefined && keys.length === 1) {
      flat.refs.push({ id: normaliseId(rawId, base), raw: rawId });
      continue;
    }
    const types = typesOf(obj["@type"]);
    const props = keys.filter((k) => k !== "@id" && k !== "@type" && k !== "@graph");
    if (types.length > 0 || rawId !== undefined) {
      for (const t of types) flat.types.add(t);
      const node: SchemaNode = {
        types,
        props,
        value: obj,
        ...(rawId ? { id: normaliseId(rawId, base), rawId } : {}),
      };
      if (node.id) {
        const prev = flat.byId.get(node.id);
        flat.byId.set(
          node.id,
          prev
            ? {
                ...prev,
                types: [...new Set([...prev.types, ...types])],
                props: [...new Set([...prev.props, ...props])],
              }
            : node,
        );
      } else flat.unnamed.push(node);
    }
    for (const [k, x] of Object.entries(obj)) if (k !== "@context") stack.push(x);
  }
  return flat;
}
