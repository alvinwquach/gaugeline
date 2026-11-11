import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { QueryTooLongError, type SanityRead } from "../connectors/sanity.js";
import type { Finding } from "../model.js";
import type { QueryShape } from "./shape.js";

/**
 * What the dataset holds of one document type: how many published documents there are, and for
 * each field path how many of them have it. Integers only; no document is ever read.
 */
export interface TypeCounts {
  type: string;
  total: number;
  /** Counted field path to the number of documents that have it (see countedPath). */
  defined: Map<string, number>;
}

/** The finding titles. The four checks in checks/query-counts.ts use the same text. */
export const TITLES = {
  absent: "A field your query asks for is on no document",
  empty: "A document type your query asks for has no documents",
  partial: "A field your query asks for is missing on some documents",
  drafts: "A query does not leave drafts out",
} as const;

/** Every document has these, so counting them says nothing. */
const SYSTEM_FIELDS = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt"]);

/**
 * The field that is counted for a path a query reads. A reference is counted at the reference
 * field itself (`topic->title` is `topic`, `photo.asset->url` is `photo.asset`) and an array of
 * objects at the array (`sections[].heading` is `sections`), because what is behind them belongs
 * to another type or to many items and `defined()` over it would not say how many documents have
 * the field. Null for a system field (`_id`, `_updatedAt`), which every document has.
 */
export function countedPath(path: string): string | null {
  const cuts = [path.indexOf("->"), path.indexOf("[]")].filter((i) => i >= 0);
  const counted = cuts.length === 0 ? path : path.slice(0, Math.min(...cuts));
  if (counted === "") return null;
  const first = counted.split(".")[0] ?? "";
  return SYSTEM_FIELDS.has(first) ? null : counted;
}

/** The distinct counted paths of a list of field paths, in the order they were first read. */
export function countedPaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const c = countedPath(p);
    if (c !== null) out.add(c);
  }
  return [...out];
}

/** Words GROQ reads as something other than a field name. */
export const RESERVED = new Set(["true", "false", "null", "in", "match", "asc", "desc"]);
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `slug.current`, or `@["gated-file"]["a b"]` when a name is not a plain identifier. */
export function accessor(path: string): string {
  return path
    .split(".")
    .map((name, i) => {
      if (PLAIN.test(name) && !RESERVED.has(name)) return i === 0 ? name : `.${name}`;
      const quoted = `[${JSON.stringify(name)}]`;
      return i === 0 ? `@${quoted}` : quoted;
    })
    .join("");
}

/**
 * One GROQ object for one type, whose values are all count() calls: `total` (published documents
 * of the type), then `p0`, `p1`, ... one for each distinct counted path (the order countedPaths
 * gives), counting the documents where `defined(path)`. No field value is projected: the answer
 * is integers. Published documents only is the request's perspective, not part of the query.
 */
export function buildCountQuery(type: string, paths: readonly string[]): string {
  const set = `*[_type == ${JSON.stringify(type)}`;
  const parts = [`"total":count(${set}])`];
  countedPaths(paths).forEach((p, i) =>
    parts.push(`"p${i}":count(${set} && defined(${accessor(p)})])`),
  );
  return `{${parts.join(",")}}`;
}

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** One request, or two halves when the address would be too long. Returns the counts and how many requests it took. */
export async function countPaths(
  type: string,
  paths: readonly string[],
  read: SanityRead,
): Promise<{ total: number; defined: Map<string, number>; requests: number }> {
  let result: unknown;
  try {
    result = await read.query(buildCountQuery(type, paths));
  } catch (err) {
    if (!(err instanceof QueryTooLongError)) throw err;
    if (paths.length < 2)
      throw new Error(
        `The count query for the type "${escapeInvisible(type, 60)}" is too long to send as a GET, even for one field.`,
      );
    const half = Math.ceil(paths.length / 2);
    const first = await countPaths(type, paths.slice(0, half), read);
    const second = await countPaths(type, paths.slice(half), read);
    return {
      total: first.total,
      defined: new Map([...first.defined, ...second.defined]),
      requests: first.requests + second.requests,
    };
  }
  const answer =
    result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (!isCount(answer.total))
    throw new Error("Sanity answered with something that is not a count.");
  const defined = new Map<string, number>();
  for (const [i, p] of paths.entries()) {
    const n = answer[`p${i}`];
    if (!isCount(n)) throw new Error("Sanity answered with something that is not a count.");
    defined.set(p, n);
  }
  return { total: answer.total, defined, requests: 1 };
}

export interface FetchCountsOptions {
  /** Told when a query had to be sent in parts. */
  log?: (message: string) => void;
}

/**
 * Counts for every type the shapes name: one request per type (two or more only when a wide type's
 * address is too long, and that is logged). A type the dataset has no documents of comes back with
 * total 0. The map is in the order the types were first named.
 */
export async function fetchCounts(
  shapes: readonly QueryShape[],
  sanity: SanityRead,
  options: FetchCountsOptions = {},
): Promise<Map<string, TypeCounts>> {
  const wanted = new Map<string, Set<string>>();
  for (const s of shapes) {
    const paths = wanted.get(s.type) ?? new Set<string>();
    for (const p of countedPaths(s.fields.map((f) => f.path))) paths.add(p);
    wanted.set(s.type, paths);
  }
  const read = await Promise.all(
    [...wanted].map(async ([type, paths]) => {
      const list = [...paths];
      const c = await countPaths(type, list, sanity);
      if (c.requests > 1)
        options.log?.(
          `The query counting ${list.length} fields of ${escapeInvisible(type, 60)} was too long for one GET, so it was sent in ${c.requests} parts.`,
        );
      return [type, { type, total: c.total, defined: c.defined }] as const;
    }),
  );
  return new Map(read);
}

const where = (s: QueryShape): string => `${escapeInvisible(s.source.file, 200)}:${s.source.line}`;
const unit = (n: number): string => `${n} ${n === 1 ? "document" : "documents"}`;

/**
 * The four findings: a type with no documents (its fields are not also reported), a field on no
 * document, a field on some, and a query whose filter leaves drafts in (which needs no count). One
 * finding for each field in each query, so two queries that read the same field give two, each
 * with its own file and line. A type with no entry in `counts` gets only the drafts finding.
 */
export function compareWithCounts(
  shapes: readonly QueryShape[],
  counts: ReadonlyMap<string, TypeCounts>,
): Finding[] {
  const out: Finding[] = [];
  for (const s of shapes) {
    const type = escapeInvisible(s.type, 60);
    const url = `sanity:${type}`;
    const source = { file: s.source.file, line: s.source.line };
    if (!s.excludesDrafts)
      out.push({
        checkId: "query-no-drafts-filter",
        severity: "medium",
        title: TITLES.drafts,
        evidence: `${where(s)}  The ${type} query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.`,
        url,
        source,
      });
    const c = counts.get(s.type);
    if (c === undefined) continue;
    if (c.total === 0) {
      out.push({
        checkId: "query-type-empty",
        severity: "high",
        title: TITLES.empty,
        evidence: `${where(s)}  Nothing of type ${type} exists: the dataset has 0 published documents of it, so every page that asks for it comes back blank.`,
        url,
        source,
      });
      continue;
    }
    for (const path of countedPaths(s.fields.map((f) => f.path))) {
      const have = c.defined.get(path);
      if (have === undefined || have >= c.total) continue;
      const field = escapeInvisible(path, 80);
      out.push(
        have === 0
          ? {
              checkId: "query-field-absent",
              severity: "high",
              title: TITLES.absent,
              evidence: `${where(s)}  ${field} doesn't exist on any ${type}: 0 of ${unit(c.total)} have it. The field was probably renamed, so what shows it renders empty.`,
              url,
              source,
            }
          : {
              checkId: "query-field-partial",
              severity: "low",
              title: TITLES.partial,
              evidence: `${where(s)}  ${field} is missing on ${c.total - have} of ${unit(c.total)}. Fine if it is optional; a bug if the template assumes it.`,
              url,
              source,
            },
      );
    }
  }
  return out;
}
