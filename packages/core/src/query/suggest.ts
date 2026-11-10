import { TYPE_NAME } from "../connectors/sanity.js";
import type { ContentShape, FieldKind, FieldShape } from "./content-shape.js";

/** What a dereferenced reference asks for. The referenced type is never read, so this is the same for every reference. */
const REFERENCE = '{ _id, title, "slug": slug.current }';
const IMAGE_FIXED = ['"url": asset->url', '"alt": coalesce(alt, "")'];
const FILE_FIXED = ['"url": asset->url', '"name": asset->originalFilename', '"size": asset->size'];
/** Names the printer writes itself inside an image or file, so a field of that name is not written twice. */
const IMAGE_OWN = new Set(["url", "alt"]);
const FILE_OWN = new Set(["url", "name", "size", "alt"]);
/** A block of fields longer than this is written over several lines. */
const WIDTH = 80;

/** Words GROQ reads as something other than a field name. */
const RESERVED = new Set(["true", "false", "null", "in", "match", "asc", "desc"]);
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `title`, or `@["gated-file"]` for a name that is not a plain GROQ identifier. */
const access = (name: string): string =>
  PLAIN.test(name) && !RESERVED.has(name) ? name : `@[${JSON.stringify(name)}]`;

/** A whole percent, never 0 or 100 for a count that is neither none nor all. */
function percent(present: number, of: number): number {
  return Math.min(99, Math.max(1, Math.round((100 * present) / of)));
}

const article = (k: FieldKind): string => (k === "object" || k === "image" ? `an ${k}` : `a ${k}`);

/** "a string and an object", "a string, a number or an object": the kinds a field was seen as, named. */
function mixedComment(path: string, kinds: readonly FieldKind[], items: boolean): string {
  const named = kinds.map(article);
  if (items)
    return `// ${path} has items of more than one kind, ${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}, so it is written as ${path}[]`;
  if (named.length === 2)
    return `// ${path} is ${named[0]} on some documents and ${named[1]} on others`;
  return `// ${path} is ${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}, depending on the document`;
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

/** `prefix{ a, b }` on one line when it is short and flat, else one entry for each line. */
function block(prefix: string, inner: readonly string[], inline = false): string {
  const flat = `${prefix}{ ${inner.join(", ")} }`;
  if (inline || (flat.length <= WIDTH && !inner.some((i) => i.includes("\n")))) return flat;
  return `${prefix}{\n${inner.map(indent).join(",\n")}\n}`;
}

/** What is being compared with, in the comment on an optional nested field. */
interface Scope {
  of: number;
  /** "the sample" or "the documents that have seo" or "the sections items". */
  label: string;
}

function entries(
  fields: readonly FieldShape[],
  scope: Scope,
  parent: string,
  comments: string[],
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (skip.has(f.name)) continue;
    out.push(entry(f, scope, parent === "" ? f.name : `${parent}.${f.name}`, comments));
  }
  return out;
}

function entry(f: FieldShape, scope: Scope, path: string, comments: string[]): string {
  const a = access(f.name);
  const optional = f.present < scope.of;
  if (optional)
    comments.push(`// ${path} is present on ${percent(f.present, scope.of)}% of ${scope.label}`);
  if (f.mixed) comments.push(mixedComment(path, f.mixed, false));
  if (f.kind === "array" && f.itemsMixed) comments.push(mixedComment(path, f.itemsMixed, true));
  // An expression that starts with the name gives its key; anything else, and a quoted name, is aliased.
  const alias = (expr: string): string => `${JSON.stringify(f.name)}: ${expr}`;
  const named = (expr: string): string => (a === f.name ? expr : alias(expr));
  if (f.mixed) return named(a);
  const inside = (label: string): Scope => ({ of: f.instances ?? f.present, label });
  const objectScope = inside(`the documents that have ${path}`);
  const itemScope = inside(`the ${path} items`);
  const extras = (own: ReadonlySet<string>, s: Scope): string[] =>
    entries(f.of ?? [], s, path, comments, own);
  switch (f.kind) {
    case "string":
      return optional ? alias(`coalesce(${a}, "")`) : named(a);
    case "number":
      return optional ? alias(`coalesce(${a}, 0)`) : named(a);
    case "boolean":
      return optional ? alias(`coalesce(${a}, false)`) : named(a);
    case "slug":
      return alias(optional ? `coalesce(${a}.current, "")` : `${a}.current`);
    case "portable-text":
      return optional ? alias(`coalesce(${a}, [])`) : named(a);
    case "reference":
      return named(`${a}->${REFERENCE}`);
    case "image":
    case "file": {
      const more = extras(f.kind === "image" ? IMAGE_OWN : FILE_OWN, objectScope);
      const fixed = f.kind === "image" ? IMAGE_FIXED : FILE_FIXED;
      return named(block(a, [...fixed, ...more], more.length === 0));
    }
    case "object": {
      const inner = extras(new Set(), objectScope);
      return named(inner.length === 0 ? a : block(a, inner));
    }
    case "array": {
      let expr = `${a}[]`;
      if (f.item === "reference") expr = `${a}[]->${REFERENCE}`;
      else if (f.item === "image" || f.item === "file") {
        const more = extras(f.item === "image" ? IMAGE_OWN : FILE_OWN, itemScope);
        const fixed = f.item === "image" ? IMAGE_FIXED : FILE_FIXED;
        expr = block(`${a}[]`, [...fixed, ...more], more.length === 0);
      } else if (f.item === "object") {
        const inner = extras(new Set(), itemScope);
        if (inner.length > 0) expr = block(`${a}[]`, inner);
      }
      return optional ? alias(`coalesce(${expr}, [])`) : named(expr);
    }
  }
}

/**
 * A GROQ query written from the shape of a type's published documents, by rules alone: the same
 * shape gives the same text. Field order is `_id`, then the fields in the order they first
 * appeared. A slug is unwrapped (`slug.current`), a reference dereferenced one level, an image
 * or a file resolved to its address, an array printed as `name[]`. A field that is on fewer
 * documents than were read gets a comment saying how common it is, and a string, number, boolean,
 * slug, array or Portable Text field is wrapped in `coalesce` so the page gets an empty value
 * instead of null. An object, image, file or reference is left to be null, since an empty one
 * would hide that it is missing. Drafts are left out and the newest come first. Never reads a
 * value: the shape holds none.
 */
export function suggestQuery(shape: ContentShape): string {
  if (!TYPE_NAME.test(shape.type))
    throw new Error(`${JSON.stringify(shape.type)} is not a Sanity document type name.`);
  if (shape.sampled === 0) throw new Error(`Nothing of type ${shape.type} exists.`);
  const comments: string[] = [];
  const fields = entries(shape.fields, { of: shape.sampled, label: "the sample" }, "", comments);
  if (shape.skipped !== undefined && shape.skipped > 0)
    comments.push(
      `// ${shape.skipped} ${shape.skipped === 1 ? "field" : "fields"} with names that cannot be written plainly ${shape.skipped === 1 ? "was" : "were"} left out`,
    );
  const documents = `${shape.sampled} published ${shape.sampled === 1 ? "document" : "documents"}`;
  return [
    `// ${shape.type}, written from ${documents}`,
    ...comments,
    `*[_type == ${JSON.stringify(shape.type)} && !(_id in path("drafts.**"))] | order(_updatedAt desc) {`,
    ["_id", ...fields].map(indent).join(",\n"),
    "}",
  ].join("\n");
}
