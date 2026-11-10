import { QueryTooLongError, TYPE_NAME, type SanityRead } from "../connectors/sanity.js";
import { ConfigError } from "../errors.js";
import type { SchemaFile } from "./mutations.js";

/** What a value is, as far as a query is concerned. */
export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "slug"
  | "reference"
  | "image"
  | "file"
  | "array"
  | "object"
  | "portable-text";

/**
 * One field of a document type, and how common it is. A tree: an object's or an array of objects'
 * fields are in `of`, each with its own count, because "optional" is a fact about each level.
 *
 * `present` counts the places the field is set: documents for a top-level field, the parent's
 * object values (or the objects inside the parent array) for a nested one. A nested field is
 * compared with `instances` of its parent, or with the parent's `present` when `instances` is unset.
 */
export interface FieldShape {
  name: string;
  kind: FieldKind;
  present: number;
  of?: FieldShape[];
  /** For an array: the kind of its items, when the schema gives them one kind. Unset for a mixed one. */
  item?: FieldKind;
  /** How many objects (documents' object values, or array items) `of` was counted over. */
  instances?: number;
  /** When the schema lets the field be more than one kind: every kind, in the order the schema lists them. */
  mixed?: FieldKind[];
  /** When the schema lets an array's items be more than one kind: every kind, in the order listed. */
  itemsMixed?: FieldKind[];
}

/** The fields of one document type: kinds from the schema, counts from the newest published documents. No value is kept. */
export interface ContentShape {
  type: string;
  /** How many documents the counts are over: the sample, or fewer when the type has fewer. */
  sampled: number;
  fields: FieldShape[];
  /** Schema fields left out because their names cannot be written into a query plainly. */
  skipped?: number;
}

/** The sample asked for when none is given. Proposed: see the PR's Sources. */
export const DEFAULT_SAMPLE = 50;
/** The most documents one sample may name. */
export const MAX_SAMPLE = 1000;
/** How many levels of objects are followed. A field below this is kept as a plain name. */
const MAX_DEPTH = 3;
/** How many of the schema's document types an error names. */
const TYPES_NAMED = 12;
/** How many fields one level keeps; the rest are counted as skipped. */
const MAX_FIELDS = 100;
/** Sanity's own rule for a field name, and the words GROQ reads as something else. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["true", "false", "null", "in", "match", "asc", "desc"]);
const writable = (name: string): boolean => PLAIN_NAME.test(name) && !RESERVED.has(name);
/** An image's or file's own bookkeeping and the alt text the printer writes itself. */
const OWN = new Set(["asset", "crop", "hotspot", "media", "alt"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Kinds, from the schema
// ---------------------------------------------------------------------------------------------

/** One thing a schema type node can be. A union has several. */
interface Variant {
  kind: FieldKind;
  /** The fields of an object, image or file, as type nodes. */
  attrs?: Record<string, unknown>;
  /** The variants an array's items can be. */
  elements?: Variant[];
  /** A Portable Text block, which only means something inside an array. */
  block?: boolean;
}

/** The `_type` an object always has, when the extract says so (`_type: { value: { type: "string", value: "slug" } }`). */
function literalType(node: Record<string, unknown>): string | undefined {
  const attrs = node.attributes;
  const t = isRecord(attrs) && isRecord(attrs._type) ? attrs._type : undefined;
  const v = isRecord(t?.value) ? t.value : undefined;
  return v?.type === "string" && typeof v.value === "string" ? v.value : undefined;
}

/** What the `asset` of an image or file dereferences to (`sanity.imageAsset`, `sanity.fileAsset`). */
function assetOf(node: Record<string, unknown>): string | undefined {
  const attrs = node.attributes;
  const a = isRecord(attrs) && isRecord(attrs.asset) ? attrs.asset : undefined;
  const v = isRecord(a?.value) ? a.value : undefined;
  return typeof v?.dereferencesTo === "string" ? v.dereferencesTo : undefined;
}

/** The type nodes of the attributes of an object, by name, without the attribute wrapper. */
function valuesOf(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const attrs = node.attributes;
  if (!isRecord(attrs)) return out;
  for (const [name, attr] of Object.entries(attrs))
    if (!name.startsWith("_") && isRecord(attr)) out[name] = attr.value;
  return out;
}

function classify(node: unknown, types: ReadonlyMap<string, unknown>, depth = 0): Variant[] {
  if (!isRecord(node) || depth > 8) return [{ kind: "object" }];
  switch (node.type) {
    case "string":
    case "number":
    case "boolean":
      return [{ kind: node.type }];
    case "null":
      return [];
    case "inline": {
      if (typeof node.name !== "string") return [{ kind: "object" }];
      const declared = types.get(node.name);
      if (declared !== undefined) return classify(declared, types, depth + 1);
      return node.name === "slug" ? [{ kind: "slug" }] : [{ kind: "object" }];
    }
    case "union":
      return Array.isArray(node.of) ? node.of.flatMap((m) => classify(m, types, depth + 1)) : [];
    case "array": {
      const elements = classify(node.of, types, depth + 1);
      if (elements.some((e) => e.block)) return [{ kind: "portable-text" }];
      return [{ kind: "array", elements }];
    }
    case "object": {
      const t = literalType(node);
      const asset = assetOf(node);
      if (t === "slug") return [{ kind: "slug" }];
      if (t === "block") return [{ kind: "object", block: true }];
      if (t === "reference" || typeof node.dereferencesTo === "string")
        return [{ kind: "reference" }];
      const kind: FieldKind =
        t === "image" || asset === "sanity.imageAsset"
          ? "image"
          : t === "file" || asset === "sanity.fileAsset"
            ? "file"
            : "object";
      return [{ kind, attrs: valuesOf(node) }];
    }
    default:
      return [{ kind: "object" }];
  }
}

const distinct = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** A field the schema declares, before it is counted. */
interface Decl {
  name: string;
  kind: FieldKind;
  mixed?: FieldKind[];
  item?: FieldKind;
  itemsMixed?: FieldKind[];
  children: Decl[];
  /** The request key of the count of documents (or parent values) that have it. */
  key?: string;
  /** For an array of objects: the request key of the count of its items. */
  itemKey?: string;
}

/** The fields of an object type node, merged over the variants that have fields (first declaration of a name wins). */
function mergedAttrs(
  variants: readonly (Variant | undefined)[],
  own: boolean,
): [string, unknown][] {
  const out = new Map<string, unknown>();
  for (const v of variants)
    for (const [name, node] of Object.entries(v?.attrs ?? {}))
      if (!out.has(name) && !(own && OWN.has(name))) out.set(name, node);
  return [...out];
}

function declare(
  fields: readonly [string, unknown][],
  types: ReadonlyMap<string, unknown>,
  depth: number,
  skipped: Set<string>,
): Decl[] {
  const out: Decl[] = [];
  for (const [name, node] of fields) {
    const variants = classify(node, types);
    if (variants.length === 0) continue;
    if (!writable(name) || out.length >= MAX_FIELDS) {
      skipped.add(name);
      continue;
    }
    const kinds = distinct(variants.map((v) => v.kind));
    const kind = kinds[0] as FieldKind;
    const decl: Decl = { name, kind, children: [] };
    if (kinds.length > 1) decl.mixed = kinds;
    else if (kind === "object" || kind === "image" || kind === "file") {
      if (depth < MAX_DEPTH)
        decl.children = declare(
          mergedAttrs(variants, kind !== "object"),
          types,
          depth + 1,
          skipped,
        );
    } else if (kind === "array") {
      const elements = variants.flatMap((v) => v.elements ?? []);
      const itemKinds = distinct(elements.map((e) => e.kind));
      if (itemKinds.length === 1) {
        const itemKind = itemKinds[0] as FieldKind;
        decl.item = itemKind;
        if (
          depth < MAX_DEPTH &&
          (itemKind === "object" || itemKind === "image" || itemKind === "file")
        )
          decl.children = declare(
            mergedAttrs(elements, itemKind !== "object"),
            types,
            depth + 1,
            skipped,
          );
      } else if (itemKinds.length > 1) decl.itemsMixed = itemKinds;
    }
    out.push(decl);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Counts, from the dataset
// ---------------------------------------------------------------------------------------------

interface Entry {
  key: string;
  expr: string;
}

/**
 * The count queries for a level of fields, over `set` (the documents, or the values one level up).
 * Each is `count(<set>[defined(field)])`: a whole number, never a value. An object's fields are
 * counted over its own values (`(<set>[defined(seo)].seo)[defined(title)]`) and an array of
 * objects' over its items (`.items[]`), so "optional" is compared with the right parent.
 */
function plan(decls: readonly Decl[], set: string, entries: Entry[]): void {
  for (const d of decls) {
    d.key = `p${entries.length}`;
    entries.push({ key: d.key, expr: `count(${set}[defined(${d.name})])` });
    if (d.children.length === 0) continue;
    const below = `(${set}[defined(${d.name})].${d.name}${d.kind === "array" ? "[]" : ""})`;
    if (d.kind === "array") {
      d.itemKey = `p${entries.length}`;
      entries.push({ key: d.itemKey, expr: `count(${below})` });
    }
    plan(d.children, below, entries);
  }
}

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** One request, or two halves when the address would be too long. */
async function ask(entries: readonly Entry[], read: SanityRead): Promise<Map<string, number>> {
  let result: unknown;
  try {
    result = await read.query(`{${entries.map((e) => `"${e.key}":${e.expr}`).join(",")}}`);
  } catch (err) {
    if (!(err instanceof QueryTooLongError)) throw err;
    if (entries.length < 2)
      throw new Error("A count query is too long to send as a GET, even for one field.");
    const half = Math.ceil(entries.length / 2);
    return new Map([
      ...(await ask(entries.slice(0, half), read)),
      ...(await ask(entries.slice(half), read)),
    ]);
  }
  const answer = isRecord(result) ? result : {};
  const out = new Map<string, number>();
  for (const e of entries) {
    const n = answer[e.key];
    if (!isCount(n)) throw new Error("Sanity answered with something that is not a count.");
    out.set(e.key, n);
  }
  return out;
}

function shapeOf(d: Decl, counts: ReadonlyMap<string, number>): FieldShape {
  const present = counts.get(d.key ?? "") ?? 0;
  const out: FieldShape = { name: d.name, kind: d.kind, present };
  if (d.mixed) out.mixed = d.mixed;
  if (d.item) out.item = d.item;
  if (d.itemsMixed) out.itemsMixed = d.itemsMixed;
  if (d.children.length > 0) {
    out.of = d.children.map((c) => shapeOf(c, counts));
    out.instances = d.itemKey === undefined ? present : (counts.get(d.itemKey) ?? 0);
  }
  return out;
}

/**
 * The fields of a document type and how common each is among the newest published documents. What
 * the fields are, and their kinds, come from the schema file (`sanity schema extract`): GROQ has no
 * function that lists a document's keys or gives a value's kind, so the dataset is never asked for
 * either. How common they are comes from count queries over the newest `sample` published
 * documents (drafts left out): `count(<sample>[defined(field)])` for each field, whole numbers in
 * and out, one GET (more only when the address would be too long). No document and no value is
 * requested, so none can be returned, logged or printed. `sampled` is how many documents the counts
 * are over, which is fewer than `sample` for a type with fewer, and 0 for a type with none. A type
 * the schema does not declare is a ConfigError. The gap: fields in documents that the schema does
 * not declare are not seen, and a field's kind is what the schema allows, not what each document holds.
 */
export async function readContentShape(
  type: string,
  sanity: SanityRead,
  schema: SchemaFile,
  sample: number = DEFAULT_SAMPLE,
): Promise<ContentShape> {
  if (!TYPE_NAME.test(type)) throw new Error(`"${type}" is not a Sanity document type name.`);
  if (!Number.isInteger(sample) || sample < 1 || sample > MAX_SAMPLE)
    throw new Error(`The sample must be a whole number of documents from 1 to ${MAX_SAMPLE}.`);
  const declared = schema.nodes.get(type);
  if (declared === undefined) {
    const names = [...schema.nodes.keys()].slice(0, TYPES_NAMED);
    throw new ConfigError(
      `The schema has no document type named "${type}".${names.length > 0 ? ` It has: ${names.join(", ")}.` : ""}`,
      { hint: "Check the type name against the schema file, or point --schema at the right one." },
    );
  }
  const skipped = new Set<string>();
  const decls = declare([...declared], schema.declarations, 0, skipped);
  const newest = `(*[_type == ${JSON.stringify(type)} && !(_id in path("drafts.**"))] | order(_updatedAt desc)[0...${sample}])`;
  const entries: Entry[] = [{ key: "total", expr: `count(${newest})` }];
  plan(decls, newest, entries);
  const counts = await ask(entries, sanity);
  const sampled = counts.get("total") ?? 0;
  if (sampled === 0) return { type, sampled: 0, fields: [] };
  return {
    type,
    sampled,
    fields: decls.map((d) => shapeOf(d, counts)),
    ...(skipped.size > 0 ? { skipped: skipped.size } : {}),
  };
}
