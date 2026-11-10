import { readFile } from "node:fs/promises";
import { QueryTooLongError, type SanityRead } from "../connectors/sanity.js";
import { ConfigError } from "../errors.js";
import { parseSchemaExtract, type SchemaFile } from "../query/mutations.js";
import { RESERVED } from "../query/counts.js";
import { withoutBom } from "../query/source.js";

/**
 * The content model of a Sanity dataset as the schema file states it, and the questions the model
 * checks ask the dataset about it. Every question is a count or a list of document ids: no field
 * value is ever requested, so nothing a client wrote reaches this machine (docs/privacy). The
 * requests are GETs of the query endpoint for published documents, through createSanityRead.
 */

/** One document type of the schema. */
export interface TypeModel {
  /** Every field the type declares (system fields such as `_id` are not in a schema file). */
  fields: Set<string>;
  /** The fields a document must have, in the order the schema lists them. */
  required: string[];
}

/** Document type to what the schema says of it, in the schema's order. */
export function modelOf(schema: SchemaFile): Map<string, TypeModel> {
  const out = new Map<string, TypeModel>();
  for (const [type, fields] of schema.documents) {
    out.set(type, {
      fields: new Set(fields.keys()),
      required: [...fields].filter(([, f]) => f.required).map(([name]) => name),
    });
  }
  return out;
}

/**
 * The schema file named in gaugeline.model.json. A file that is not there, or is not a schema
 * extract, is a ConfigError that names the setting, never a quiet could-not-check: a typo in the
 * path would otherwise look like a clean run.
 */
export async function readModelSchema(
  path: string,
  setting: "schema" | "previousSchema",
  file = "gaugeline.model.json",
): Promise<SchemaFile> {
  const hint =
    "Write it with `npx sanity schema extract` (it makes schema.json). Gaugeline makes no request to fetch it.";
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`${file}: ${setting}: the file "${path}" could not be read.`, {
      hint,
      cause,
    });
  }
  try {
    return parseSchemaExtract(withoutBom(text), path);
  } catch (cause) {
    throw new ConfigError(`${file}: ${setting}: "${path}" is not a schema extract.`, {
      hint,
      cause,
    });
  }
}

/** Document type to the fields to look for in the documents although the schema has none of them. */
export function orphanCandidates(
  current: SchemaFile,
  previous: SchemaFile | undefined,
  retired: Readonly<Record<string, readonly string[]>> | undefined,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (type: string, field: string) => {
    if (current.documents.get(type)?.has(field)) return;
    const set = out.get(type) ?? new Set<string>();
    set.add(field);
    out.set(type, set);
  };
  for (const [type, fields] of previous?.documents ?? [])
    for (const field of fields.keys()) add(type, field);
  for (const [type, fields] of Object.entries(retired ?? {})) for (const f of fields) add(type, f);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, s]) => [t, [...s].sort()]));
}

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A field name that can be written into a query without quoting. */
export const isPlainField = (name: string): boolean => PLAIN.test(name) && !RESERVED.has(name);

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** How many documents, and the first few of their ids. */
export interface Tally {
  count: number;
  /** Ids in order, at most `EXAMPLES` of them. */
  ids: string[];
}

/** Example ids shown with a count. */
export const EXAMPLES = 3;
/** Fields asked about in one request before the address gets long. */
const FIELDS_PER_QUERY = 8;

export interface FieldTallies {
  /** Published documents of the type. */
  total: number;
  /** The tally of each field asked about. */
  byField: Map<string, Tally>;
  /** Fields left out because their name cannot be written into a query plainly. */
  skipped: string[];
}

/**
 * For each field, how many published documents of the type have none (`mode` "missing", for a
 * field the schema requires) or have one (`mode` "populated", for a field the schema no longer
 * has), and the first three of their ids. One request for up to eight fields; a request that would
 * make the address too long is sent in two halves.
 */
export async function tallyFields(
  read: SanityRead,
  type: string,
  fields: readonly string[],
  mode: "missing" | "populated",
): Promise<FieldTallies> {
  const asked = fields.filter(isPlainField);
  const skipped = fields.filter((f) => !isPlainField(f));
  const set = `*[_type == ${JSON.stringify(type)}`;
  const byField = new Map<string, Tally>();
  let total = 0;

  async function ask(names: readonly string[]): Promise<void> {
    const test = (f: string) => (mode === "missing" ? `!defined(${f})` : `defined(${f})`);
    const parts = [`"total":count(${set}])`];
    names.forEach((f, i) => {
      parts.push(`"c${i}":count(${set} && ${test(f)}])`);
      parts.push(`"i${i}":${set} && ${test(f)}]|order(_id)[0...${EXAMPLES}]._id`);
    });
    let result: unknown;
    try {
      result = await read.query(`{${parts.join(",")}}`);
    } catch (err) {
      if (!(err instanceof QueryTooLongError) || names.length < 2) throw err;
      const half = Math.ceil(names.length / 2);
      await ask(names.slice(0, half));
      await ask(names.slice(half));
      return;
    }
    const answer =
      result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
    if (!isCount(answer.total))
      throw new Error("Sanity answered with something that is not a count.");
    total = answer.total;
    names.forEach((f, i) => {
      const count = answer[`c${i}`];
      const ids = answer[`i${i}`];
      if (!isCount(count) || !Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
        throw new Error("Sanity answered with something that is not a count and a list of ids.");
      byField.set(f, { count, ids: (ids as string[]).slice(0, EXAMPLES) });
    });
  }

  if (asked.length === 0) {
    const n = await read.query(`count(${set}])`);
    if (!isCount(n)) throw new Error("Sanity answered with something that is not a count.");
    return { total: n, byField, skipped };
  }
  for (let at = 0; at < asked.length; at += FIELDS_PER_QUERY)
    await ask(asked.slice(at, at + FIELDS_PER_QUERY));
  return { total, byField, skipped };
}

/** How many published documents of a type there are, narrowed by a filter the config declared. */
export async function countType(read: SanityRead, type: string, filter?: string): Promise<number> {
  const narrowed = filter === undefined ? "" : ` && (${filter})`;
  const n = await read.query(`count(*[_type == ${JSON.stringify(type)}${narrowed}])`);
  if (!isCount(n)) throw new Error("Sanity answered with something that is not a count.");
  return n;
}

/** What `idsNotIn` found: ids, or the reason it could not say which. */
export type MissingIds = { ok: true; ids: string[] } | { ok: false; reason: string };

/** A slug an address can carry, as written into a query. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/;

/**
 * The ids of the published documents (narrowed by `filter`) whose `slugField` is not one of the
 * slugs the page shows. The slugs are the site's own public addresses; what comes back is ids.
 * Up to `limit`, in id order.
 */
export async function idsNotIn(
  read: SanityRead,
  type: string,
  filter: string | undefined,
  slugField: string,
  slugs: readonly string[],
  limit: number,
): Promise<MissingIds> {
  if (!slugs.every((s) => SLUG.test(s)))
    return { ok: false, reason: "an entry's address is not a plain slug" };
  const narrowed = filter === undefined ? "" : ` && (${filter})`;
  const list = `[${slugs.map((s) => JSON.stringify(s)).join(",")}]`;
  try {
    const ids = await read.query(
      `*[_type == ${JSON.stringify(type)}${narrowed} && !(${slugField} in ${list})]|order(_id)[0...${limit}]._id`,
    );
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
      throw new Error("Sanity answered with something that is not a list of ids.");
    return { ok: true, ids: ids as string[] };
  } catch (err) {
    if (err instanceof QueryTooLongError)
      return { ok: false, reason: "there are too many entries to name them in one request" };
    throw err;
  }
}
