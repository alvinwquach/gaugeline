import * as z from "zod";
import { ConfigError } from "../errors.js";
import type { Finding } from "../model.js";

/**
 * The query check's baseline: today's gaps, kept so that a later run can say which ones a change
 * created. It holds the names of things (a check id, a document type, a field path, a file path) and
 * nothing a site or a dataset holds: no document, no field value, no count, no line, no token. This is
 * small on purpose; the general `--baseline` of a later branch can read it or replace it.
 */
export const BASELINE_SCHEMA = 1;

export interface BaselineGap {
  /** checkId, type, field and file joined (see `gapKey`). The identity of the gap. */
  key: string;
  checkId: string;
  /** The document type, or the GraphQL type, as the finding's address names it. */
  type: string;
  /** The field path, when the check is about one. Written as the finding shows it (invisible characters escaped). */
  field?: string;
  /** The source file, as a `/` path from the folder the command ran in. Empty when a finding has none. */
  file: string;
}

export interface QueryBaseline {
  schema: 1;
  /** When it was saved, in UTC. The caller gives the time: nothing here reads the clock. */
  createdAt: string;
  /** Sorted by key, one for each distinct key. */
  gaps: BaselineGap[];
}

/**
 * The key of a gap: check id, type, field and file with `|` between them. A `|` or a `\` inside a
 * part is written with a backslash before it, so two different gaps can never share a key. The line
 * is not in it (a restructure moves code) and neither is a count ("missing on 28 of 40" and "29 of
 * 41" are the same gap). The file is in it, so a gap comes with the file that has to be edited.
 */
export function gapKey(parts: Omit<BaselineGap, "key">): string {
  const esc = (s: string): string => s.replace(/[\\|]/g, (c) => `\\${c}`);
  return [parts.checkId, parts.type, parts.field ?? "", parts.file].map(esc).join("|");
}

/**
 * Where, in a finding's text, the field is. Each pattern reads the text the check itself writes,
 * and has one group: the field. A check with no pattern, or text that does not match, gives a gap
 * with no field, which is a gap for the check, the type and the file.
 */
const FIELD: Readonly<Record<string, RegExp>> = Object.freeze({
  "query-field-absent": /^.*?:\d+ {2}(.+?) doesn't exist on any /,
  "query-field-partial": /^.*?:\d+ {2}(.+?) is missing on \d+ of /,
  "mutation-undeclared-field": /^.*?:\d+ {2}This \w+ writes (.+?), and (?:the |no )/,
  "mutation-ref-as-string": /^.*?:\d+ {2}(.+?) is a reference, and /,
  "mutation-missing-required": /^.*?:\d+ {2}This \w+ of .+? leaves out (.+?), which the schema /,
  "mutation-shared-field": /^(.+?) is written by \d+ routes/,
});

/** The gap a finding is one of. Reads the finding's address, check id, file and text, and nothing else. */
export function gapOf(finding: Finding): BaselineGap {
  const parts: Omit<BaselineGap, "key"> = {
    checkId: finding.checkId,
    type: finding.url.replace(/^(?:sanity|graphql):/, ""),
    ...fieldOf(finding),
    file: finding.source?.file ?? "",
  };
  return { key: gapKey(parts), ...parts };
}

function fieldOf(finding: Finding): { field?: string } {
  const pattern = FIELD[finding.checkId];
  const field = pattern?.exec(finding.evidence)?.[1];
  return field === undefined || field === "" ? {} : { field };
}

const byKey = (a: BaselineGap, b: BaselineGap): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** The baseline for a run's findings. One gap for each key, sorted by key so the file diffs cleanly in git. */
export function toBaseline(findings: readonly Finding[], now: Date): QueryBaseline {
  const gaps = new Map<string, BaselineGap>();
  for (const f of findings) {
    const g = gapOf(f);
    if (!gaps.has(g.key)) gaps.set(g.key, g);
  }
  return {
    schema: BASELINE_SCHEMA,
    createdAt: now.toISOString(),
    gaps: [...gaps.values()].sort(byKey),
  };
}

/**
 * What a change did. `created` is every finding whose key the baseline lacks, with its text and line
 * (two findings with one key, which are two lines to edit, are both listed). `closed` is each baseline
 * gap no finding has now. `carried` counts the baseline gaps that are still there. Two Sets of keys
 * answer it: is this gap new is one lookup, and the rest is a difference each way.
 */
export function diffBaseline(
  before: QueryBaseline,
  after: readonly Finding[],
): { created: Finding[]; closed: BaselineGap[]; carried: number } {
  const was = new Set(before.gaps.map((g) => g.key));
  const now = new Set<string>();
  const created: Finding[] = [];
  for (const f of after) {
    const key = gapOf(f).key;
    now.add(key);
    if (!was.has(key)) created.push(f);
  }
  const closed = before.gaps.filter((g) => !now.has(g.key));
  let carried = 0;
  for (const key of was) if (now.has(key)) carried += 1;
  return { created, closed, carried };
}

/**
 * Files that look renamed: every gap that closed in one file is a gap that was created, with the same
 * check, type and field, in one other file, and no other file claims it. Pure guesswork on names, so
 * it only says "looks": a file that has both closed and created gaps is never one of the pair.
 */
export function likelyRenames(
  closed: readonly BaselineGap[],
  created: readonly Finding[],
): Array<{ from: string; to: string }> {
  const shape = (g: Omit<BaselineGap, "key">): string => gapKey({ ...g, file: "" });
  const sets = (gaps: readonly Omit<BaselineGap, "key">[]): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const g of gaps) {
      const set = out.get(g.file) ?? new Set<string>();
      set.add(shape(g));
      out.set(g.file, set);
    }
    return out;
  };
  const from = sets(closed);
  const to = sets(created.map(gapOf));
  const same = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every((x) => b.has(x));
  const claims = new Map<string, string[]>();
  for (const [a, setA] of from) {
    if (a === "" || to.has(a)) continue;
    for (const [b, setB] of to) {
      if (b === "" || from.has(b) || !same(setA, setB)) continue;
      claims.set(b, [...(claims.get(b) ?? []), a]);
    }
  }
  const pairs: Array<{ from: string; to: string }> = [];
  for (const [b, as] of claims) {
    const a = as[0];
    if (as.length !== 1 || a === undefined) continue;
    // The other way too: the closed file must have only this one candidate.
    if ([...claims.values()].filter((x) => x.includes(a)).length !== 1) continue;
    pairs.push({ from: a, to: b });
  }
  return pairs.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
}

/** The text of the file: JSON with two-space indent, the keys of each gap in order, one newline at the end. */
export function serializeBaseline(baseline: QueryBaseline): string {
  const gaps = baseline.gaps.map((g) => ({
    checkId: g.checkId,
    ...(g.field === undefined ? {} : { field: g.field }),
    file: g.file,
    key: g.key,
    type: g.type,
  }));
  return `${JSON.stringify({ schema: baseline.schema, createdAt: baseline.createdAt, gaps }, null, 2)}\n`;
}

const gapSchema = z.object({
  key: z.string(),
  checkId: z.string().min(1),
  type: z.string(),
  field: z.string().min(1).optional(),
  file: z.string(),
});

const fileSchema = z.object({
  schema: z.literal(BASELINE_SCHEMA),
  createdAt: z.iso.datetime({ offset: true }),
  gaps: z.array(gapSchema),
});

/**
 * Read the file's text. `name` is the path as the person typed it, for the messages. A file of
 * another schema number, text that is not a baseline, and a file whose keys do not match their
 * parts (it was edited) are each a ConfigError (exit 2); none of the file's text is repeated.
 */
export function parseBaseline(text: string, name: string): QueryBaseline {
  const notOne = (): ConfigError =>
    new ConfigError(`${name} is not a Gaugeline baseline.`, {
      hint: "Save one first with gaugeline query <folder> --save before.json, then give that file to --against.",
    });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw notOne();
  }
  const schema =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as { schema?: unknown }).schema
      : undefined;
  if (typeof schema !== "number") throw notOne();
  if (schema !== BASELINE_SCHEMA)
    throw new ConfigError(
      `${name} was written with baseline schema ${schema}, and this version reads schema ${BASELINE_SCHEMA}.`,
      {
        hint:
          schema > BASELINE_SCHEMA
            ? "Update Gaugeline to the version that wrote it, or save a new baseline with this one: gaugeline query <folder> --save <file> --force."
            : "Save a new baseline with this version: gaugeline query <folder> --save <file> --force.",
      },
    );
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw notOne();
  const gaps: BaselineGap[] = parsed.data.gaps.map((g) => ({
    key: g.key,
    checkId: g.checkId,
    type: g.type,
    ...(g.field === undefined ? {} : { field: g.field }),
    file: g.file,
  }));
  for (const g of gaps)
    if (g.key !== gapKey(g))
      throw new ConfigError(
        `${name} was edited: a gap's key does not match the check, type, field and file beside it.`,
        {
          hint: "Save a new baseline instead of editing one: gaugeline query <folder> --save <file> --force.",
        },
      );
  return { schema: BASELINE_SCHEMA, createdAt: parsed.data.createdAt, gaps: gaps.sort(byKey) };
}
