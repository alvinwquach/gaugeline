import type { LocalSourceInput } from "../../local-source/run.js";
import { matching, scrub, sourcePathsOf } from "./scan.js";

/**
 * What the content-group static checks share (FF-26 to FF-30): the schema fields a Sanity project
 * declares, the GROQ queries it writes, and the objects around a position. Plain text reading over the
 * two scrubbed views of a file (`code`: comments blanked; `bare`: comments and string text blanked, the
 * same length), no parser. Nothing here keeps a value; a check says a file, a line and a field name.
 */

/** A file's two views. */
export interface View {
  file: string;
  text: string;
  code: string;
  bare: string;
}

export function viewsOf(input: LocalSourceInput): View[] {
  return sourcePathsOf(input.tree).map((file) => {
    const text = input.tree.files.get(file) ?? "";
    return { file, text, code: scrub(text, false), bare: scrub(text, true) };
  });
}

/** A `{ ... }` range: the index of the opening and of the closing brace. */
export interface Obj {
  start: number;
  end: number;
}

/** The objects that contain `index`, innermost first. */
export function objectsAround(bare: string, index: number): Obj[] {
  const out: Obj[] = [];
  let skip = 0;
  for (let k = index - 1; k >= 0; k--) {
    const c = bare[k];
    if (c === "}") skip++;
    else if (c === "{") {
      if (skip > 0) skip--;
      else {
        const end = matching(bare, k);
        if (end > index) out.push({ start: k, end });
      }
    }
  }
  return out;
}

/** The text of the object's own string property (`name: "author"`), not one of a nested object's; with where it is. */
export function ownString(
  view: View,
  obj: Obj,
  prop: string,
): { value: string; index: number } | undefined {
  const re = new RegExp(`(?<![\\w$.])${prop}\\s*:\\s*(["'])([^"'\\n]*)\\1`, "g");
  const body = view.code.slice(obj.start, obj.end);
  for (const m of body.matchAll(re)) {
    // Own when only this object's brace is open between its start and the match.
    let depth = 0;
    for (let k = obj.start; k < obj.start + m.index; k++) {
      const c = view.bare[k];
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
    }
    if (depth === 1) return { value: m[2] ?? "", index: obj.start + m.index };
  }
  return undefined;
}

/** One `type: "..."` in a schema: what it is, the field's name (own or an enclosing field's), and the object it is in. */
export interface SchemaType {
  file: string;
  type: string;
  /** The name of the field this type belongs to: the object's own, else the nearest enclosing one's. */
  name: string | undefined;
  index: number;
  obj: Obj;
  view: View;
}

const IS_SCHEMA =
  /\bdefine(?:Type|Field|ArrayMember)\s*\(|\btype\s*:\s*["'](?:document|object)["']/;

/** Every `type: "..."` in the files that look like a Sanity schema, and whether any file did. */
export function schemaTypes(views: readonly View[]): { found: boolean; types: SchemaType[] } {
  const types: SchemaType[] = [];
  let found = false;
  for (const view of views) {
    if (!IS_SCHEMA.test(view.bare) && !IS_SCHEMA.test(view.code)) continue;
    found = true;
    for (const m of view.code.matchAll(/(?<![\w$.])type\s*:\s*(["'])([\w-]+)\1/g)) {
      if (view.bare[m.index] !== "t") continue;
      const objs = objectsAround(view.bare, m.index);
      const obj = objs[0];
      if (obj === undefined) continue;
      let name: string | undefined;
      for (const o of objs) {
        name = ownString(view, o, "name")?.value;
        if (name !== undefined) break;
      }
      types.push({ file: view.file, type: m[2] ?? "", name, index: m.index, obj, view });
    }
  }
  return { found, types };
}

/** A GROQ query written as a string or template literal in code: where it starts and its text. */
export interface Query {
  file: string;
  index: number;
  text: string;
}

/** The string and template literals in a file that start with `*[` (a GROQ query). */
export function groqQueries(view: View): Query[] {
  const out: Query[] = [];
  for (const m of view.bare.matchAll(/(["'`])[ \t\r\n]*\1/g)) {
    const text = view.code.slice(m.index + 1, m.index + m[0].length - 1);
    if (/^\s*\*\s*\[/.test(text)) out.push({ file: view.file, index: m.index, text });
  }
  return out;
}
