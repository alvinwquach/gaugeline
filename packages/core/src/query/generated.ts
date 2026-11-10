import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { QueryTooLongError, TYPE_NAME, type SanityRead } from "../connectors/sanity.js";
import { ConfigError } from "../errors.js";
import { SEVERITY_ORDER, type Finding } from "../model.js";
import { TITLES as COUNT_TITLES, RESERVED } from "./counts.js";

/**
 * Content that software wrote has to add up: a stated number must equal the sum of its parts
 * (--totals), and the documents it links to must be published (--refs). Both are answered by the
 * dataset, in one GET per rule, and what comes back is ids and whole numbers: the comparison is
 * made by GROQ on the server (`stated != math::sum(parts)` is a filter), so the numbers
 * themselves, and every other field, stay there. A finding names the document by its id.
 */

/** `mealPlan:targetCalories=days[].meals[]->calories`. `parts` is a GROQ path that ends in a number. */
export interface TotalsRule {
  type: string;
  stated: string;
  parts: string;
}

/** `mealPlan:meals`. `path` leads to an array of references. */
export interface RefsRule {
  type: string;
  path: string;
}

/** At most this many rules, --totals and --refs together, in one run. */
export const MAX_RULES = 10;
/** A rule longer than this is refused: it would not fit in a GET address with the rest of the query. */
export const MAX_RULE_LENGTH = 300;
/** At most this many documents are named for one rule; the finding says when there are more. */
export const MAX_DOCUMENTS = 100;
/** At most this many missing targets are named for one document. */
export const MAX_TARGETS = 10;

/** A rule that does not parse. Exit 2; `position` is the 1-based character the problem is at. */
export class RuleError extends ConfigError {
  readonly position: number;
  constructor(message: string, position: number, hint?: string) {
    super(message, hint === undefined ? {} : { hint });
    this.position = position;
  }
}

type Flag = "--totals" | "--refs";

const EXAMPLE: Record<Flag, string> = {
  "--totals": 'a rule looks like --totals "mealPlan:targetCalories=days[].meals[]->calories"',
  "--refs": 'a rule looks like --refs "mealPlan:meals"',
};

function fail(flag: Flag, rule: string, position: number, problem: string): never {
  throw new RuleError(
    `${flag} "${escapeInvisible(rule, 80)}": ${problem} (character ${position}).`,
    position,
    `${EXAMPLE[flag]}: the type, a colon, then ${flag === "--totals" ? "the stated field, an equals sign and the path of the parts" : "the path to the array of references"}.`,
  );
}

/** A character as it is shown in a message: quoted, and escaped if it is invisible. */
const shown = (ch: string): string => `"${escapeInvisible(ch, 4)}"`;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Check a path of field names: `a.b` (stated), `a[].b` (refs) or `a[].b[]->c` (parts), from
 * `start` up to `end` in the rule. Field names are letters, digits and underscores, and a
 * name is never a GROQ keyword; a quote, a space or a bracket anywhere else is refused at its
 * position. Nothing but the names and the three joins `.`, `[]` and `->` can get through, which is
 * why a rule can be written into a query.
 */
function checkPath(
  flag: Flag,
  rule: string,
  start: number,
  end: number,
  allow: { array: boolean; deref: boolean; endsInArray?: boolean },
  what: string,
): void {
  let i = start;
  let needName = true;
  let closed = false;
  const at = (n: number): number => n + 1;
  while (i < end) {
    const rest = rule.slice(i, end);
    if (needName) {
      const m = IDENT.exec(rest);
      if (m === null)
        fail(
          flag,
          rule,
          at(i),
          `a field name was expected here, and ${shown(rule.charAt(i))} is not one (a field name is letters, digits and underscores)`,
        );
      if (RESERVED.has(m[0]))
        fail(flag, rule, at(i), `${m[0]} is a GROQ keyword, not a field name`);
      i += m[0].length;
      needName = false;
      closed = false;
      continue;
    }
    if (allow.array && rest.startsWith("[]")) {
      i += 2;
      // After [] comes another join, never a name.
      needName = false;
      closed = true;
      if (i < end && !/^(\.|\[\]|->)/.test(rule.slice(i, end)))
        fail(
          flag,
          rule,
          at(i),
          `after [] expected ".", "[]" or "->", not ${shown(rule.charAt(i))}`,
        );
      continue;
    }
    if (allow.deref && rest.startsWith("->")) {
      i += 2;
      needName = true;
      continue;
    }
    if (rest.startsWith(".")) {
      i += 1;
      needName = true;
      continue;
    }
    fail(
      flag,
      rule,
      at(i),
      `${shown(rule.charAt(i))} is not allowed in ${what}; use field names joined by "."${allow.array ? ', "[]"' : ""}${allow.deref ? ' or "->"' : ""}`,
    );
  }
  if (needName || (closed && allow.endsInArray !== true))
    fail(
      flag,
      rule,
      at(end),
      end === start
        ? `${what} is empty`
        : `${what} must end in a field name, not in ${shown(rule.charAt(end - 1))}`,
    );
}

/** The type, up to the colon; returns where the colon is. */
function typeOf(flag: Flag, rule: string): { type: string; colon: number } {
  if (rule.length > MAX_RULE_LENGTH)
    fail(flag, rule, MAX_RULE_LENGTH + 1, `a rule is at most ${MAX_RULE_LENGTH} characters`);
  const colon = rule.indexOf(":");
  if (colon < 0) fail(flag, rule, rule.length + 1, 'a ":" is missing after the document type');
  const type = rule.slice(0, colon);
  if (type === "") fail(flag, rule, 1, "the document type is missing before the colon");
  if (!TYPE_NAME.test(type)) {
    const bad = [...type].findIndex((c, k) => !(k === 0 ? /[A-Za-z]/ : /[A-Za-z0-9_-]/).test(c));
    const k = bad < 0 ? 64 : bad;
    fail(
      flag,
      rule,
      k + 1,
      `${shown(type.charAt(k))} is not allowed in a document type name (letters, digits, underscores and hyphens, starting with a letter, at most 64)`,
    );
  }
  return { type, colon };
}

/**
 * `type:stated=parts`. The type and the field names are identifiers; the parts path may use `.`,
 * `[]` and `->` and must end in a field name. A rule that does not parse is a RuleError (exit 2)
 * naming the character the problem is at.
 */
export function parseTotalsRule(s: string): TotalsRule {
  const flag = "--totals";
  const { type, colon } = typeOf(flag, s);
  const eq = s.indexOf("=", colon + 1);
  if (eq < 0)
    fail(flag, s, s.length + 1, 'an "=" is missing between the stated field and its parts');
  checkPath(flag, s, colon + 1, eq, { array: false, deref: false }, "the stated field");
  checkPath(flag, s, eq + 1, s.length, { array: true, deref: true }, "the parts path");
  return { type, stated: s.slice(colon + 1, eq), parts: s.slice(eq + 1) };
}

/** `type:path`. The path leads to an array of references: `meals`, or `days[].meals[]`. */
export function parseRefsRule(s: string): RefsRule {
  const flag = "--refs";
  const { type, colon } = typeOf(flag, s);
  checkPath(
    flag,
    s,
    colon + 1,
    s.length,
    { array: true, deref: false, endsInArray: true },
    "the path",
  );
  return { type, path: s.slice(colon + 1) };
}

/** A rule as the person typed it, for a message or an evidence line. */
const totalsText = (r: TotalsRule): string => `${r.type}:${r.stated}=${r.parts}`;
const refsText = (r: RefsRule): string => `${r.type}:${r.path}`;

/** The rule's own fields, re-checked: a rule built by hand cannot put anything in a query that the parser would refuse. */
function totalsChecked(rule: TotalsRule): TotalsRule {
  return parseTotalsRule(totalsText(rule));
}
function refsChecked(rule: RefsRule): RefsRule {
  return parseRefsRule(refsText(rule));
}

/**
 * The one query for a totals rule, over published documents (the request's perspective). It asks
 * for the number of documents of the type, the ids (and nothing else) of the documents that
 * state no total and of those whose stated number is not the sum of the parts, and two counts of
 * documents where the stated number, or a part, is not a number at all. Equality is decided here
 * by the dataset, exactly: no number is returned. A part that does not dereference is null and
 * adds nothing to the sum, which is what makes an unpublished part show up as a shortfall.
 */
export function totalsQuery(input: TotalsRule): string {
  const { type, stated, parts } = totalsChecked(input);
  const set = `*[_type == ${JSON.stringify(type)}`;
  const sum = `math::sum(${parts})`;
  const statedSum = `math::sum([${stated}])`;
  const ids = `| order(_id)[0...${MAX_DOCUMENTS + 1}]{_id}`;
  return `{${[
    `"documents":count(${set}])`,
    `"unstated":${set} && !defined(${stated})] ${ids}`,
    `"statedNotNumber":count(${set} && defined(${stated}) && !defined(${statedSum})])`,
    `"partsNotNumber":count(${set} && defined(${parts}) && !defined(${sum})])`,
    `"mismatched":${set} && defined(${stated}) && defined(${statedSum}) && ${stated} != coalesce(${sum}, 0)] ${ids}`,
  ].join(",")}}`;
}

/** The references at a refs path: `meals` and `meals[]` both mean the items of the array. */
const itemsOf = (path: string): string => `(${path.endsWith("[]") ? path : `${path}[]`})`;

/**
 * The one query for a refs rule. For each document of the type, the references at the path are
 * counted, and so are those whose target is a published document; a document where the two
 * differ comes back as its id, the two counts and the ids its missing targets have (a reference's
 * `_ref`, which is an id). Nothing else of the document is projected.
 */
export function refsQuery(input: RefsRule): string {
  const { type, path } = refsChecked(input);
  const items = itemsOf(path);
  const refs = `${items}[defined(_ref)]`;
  const live = `${items}[defined(_ref) && defined(@->_id)]`;
  const missing = `${items}[defined(_ref) && !defined(@->_id)]`;
  return `{${[
    `"documents":count(*[_type == ${JSON.stringify(type)}])`,
    `"broken":*[_type == ${JSON.stringify(type)} && count(${refs}) != count(${live})] | order(_id)[0...${MAX_DOCUMENTS + 1}]{_id,"found":count(${refs}),"live":count(${live}),"missing":${missing}[0...${MAX_TARGETS + 1}]._ref}`,
  ].join(",")}}`;
}

/** The finding titles. The three checks in checks/query-generated.ts use the same text. */
export const GENERATED_TITLES = {
  mismatch: "A stated total is not the sum of its parts",
  unstated: "A document has no stated total",
  unpublished: "A document links to something that was never published",
} as const;

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const NOT_AN_ANSWER = "Sanity answered with something that is not what the rule asked for.";

/** A list of `{ _id }` rows as ids. Anything else is an answer that cannot be read. */
function idsOf(rows: unknown): string[] {
  if (!Array.isArray(rows)) throw new Error(NOT_AN_ANSWER);
  return rows.map((row) => {
    if (!isRecord(row) || typeof row._id !== "string" || row._id === "")
      throw new Error(NOT_AN_ANSWER);
    return row._id;
  });
}

/** The document a finding is about: the address is `sanity:<type>/<id>`. */
const urlOf = (type: string, id: string): string =>
  `sanity:${escapeInvisible(type, 60)}/${escapeInvisible(id, 80)}`;

/** The question, or the ConfigError that says it cannot be asked. */
async function ask(read: SanityRead, groq: string, what: string): Promise<Record<string, unknown>> {
  let answer: unknown;
  try {
    answer = await read.query(groq);
  } catch (err) {
    if (err instanceof QueryTooLongError)
      throw new ConfigError(
        `The question for ${what} is too long to send as a GET, even for one rule.`,
        { hint: "Use shorter field names or a shorter path." },
      );
    throw err;
  }
  if (!isRecord(answer) || !isCount(answer.documents)) throw new Error(NOT_AN_ANSWER);
  return answer;
}

/** The finding for a type with no published documents: the same one the field counts give. */
function emptyFinding(rule: string, flag: Flag, type: string): Finding {
  const t = escapeInvisible(type, 60);
  return {
    checkId: "query-type-empty",
    severity: "high",
    title: COUNT_TITLES.empty,
    evidence: `${flag} ${escapeInvisible(rule, 120)}  Nothing of type ${t} exists: the dataset has 0 published documents of it, so there is nothing to check.`,
    url: `sanity:${t}`,
  };
}

/** "and 12 more" when the list was cut. */
const more = (cut: boolean): string =>
  cut ? ` At least ${MAX_DOCUMENTS} documents are listed; there are more.` : "";

/**
 * One totals rule, one GET. A document of the type with a stated number that is not the sum of the
 * parts gets generated-total-mismatch (high); one with no stated number gets
 * generated-total-missing (low), and is never also reported as a mismatch. A type with no
 * published documents gives only query-type-empty. If the stated number, or a part, is not a number
 * on some document the rule cannot be compared and the result is a ConfigError (exit 2) naming the
 * path: nothing is reported from that answer. Exact equality: money is whole numbers in minor
 * units, and decimals (0.1 and 0.2 against 0.3) are a mismatch by design.
 */
export async function checkTotals(rule: TotalsRule, sanity: SanityRead): Promise<Finding[]> {
  const text = totalsText(rule);
  const answer = await ask(sanity, totalsQuery(rule), `--totals ${text}`);
  if (answer.documents === 0) return [emptyFinding(text, "--totals", rule.type)];
  if (!isCount(answer.statedNotNumber) || !isCount(answer.partsNotNumber))
    throw new Error(NOT_AN_ANSWER);
  const t = escapeInvisible(rule.type, 60);
  if (answer.statedNotNumber > 0)
    throw new ConfigError(
      `--totals ${escapeInvisible(text, 120)}: the stated field ${escapeInvisible(rule.stated, 80)} is not a number on ${answer.statedNotNumber} ${t} ${answer.statedNotNumber === 1 ? "document" : "documents"}, so nothing was compared.`,
      {
        hint: "The stated field must hold a number (money in whole minor units, such as cents). Check the path against your schema.",
      },
    );
  if (answer.partsNotNumber > 0)
    throw new ConfigError(
      `--totals ${escapeInvisible(text, 120)}: the parts path ${escapeInvisible(rule.parts, 120)} ends in something that is not a number on ${answer.partsNotNumber} ${t} ${answer.partsNotNumber === 1 ? "document" : "documents"}, so nothing was compared.`,
      {
        hint: "The path must end in a number field. Check it against your schema; a path that stops one field early reaches text or an object.",
      },
    );
  const unstated = idsOf(answer.unstated);
  const mismatched = idsOf(answer.mismatched);
  const stated = escapeInvisible(rule.stated, 80);
  const parts = escapeInvisible(rule.parts, 120);
  const out: Finding[] = [];
  mismatched.slice(0, MAX_DOCUMENTS).forEach((id, k, all) =>
    out.push({
      checkId: "generated-total-mismatch",
      severity: "high",
      title: GENERATED_TITLES.mismatch,
      evidence: `${t} ${escapeInvisible(id, 80)}: ${stated} does not equal the sum of ${parts}.${k === all.length - 1 ? more(mismatched.length > MAX_DOCUMENTS) : ""}`,
      url: urlOf(rule.type, id),
    }),
  );
  unstated.slice(0, MAX_DOCUMENTS).forEach((id, k, all) =>
    out.push({
      checkId: "generated-total-missing",
      severity: "low",
      title: GENERATED_TITLES.unstated,
      evidence: `${t} ${escapeInvisible(id, 80)}: no stated total, so ${stated} was not compared with the sum of ${parts}.${k === all.length - 1 ? more(unstated.length > MAX_DOCUMENTS) : ""}`,
      url: urlOf(rule.type, id),
    }),
  );
  return out;
}

interface BrokenRow {
  id: string;
  found: number;
  live: number;
  missing: string[];
}

function brokenRows(rows: unknown): BrokenRow[] {
  if (!Array.isArray(rows)) throw new Error(NOT_AN_ANSWER);
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row._id !== "string" ||
      row._id === "" ||
      !isCount(row.found) ||
      !isCount(row.live) ||
      !Array.isArray(row.missing) ||
      !row.missing.every((m) => typeof m === "string")
    )
      throw new Error(NOT_AN_ANSWER);
    return {
      id: row._id,
      found: row.found,
      live: row.live,
      missing: [...new Set(row.missing as string[])],
    };
  });
}

/**
 * One refs rule, one GET. For each document of the type where some reference at the path points at
 * nothing that is published (no document, or a document that exists only as a draft),
 * generated-ref-unpublished (high): how many of its references, and the ids of the targets that are
 * missing (ten at most). A type with no published documents gives only query-type-empty.
 * What comes back is the document's id, two counts and the missing ids, which are references' ids.
 */
export async function checkRefs(rule: RefsRule, sanity: SanityRead): Promise<Finding[]> {
  const text = refsText(rule);
  const answer = await ask(sanity, refsQuery(rule), `--refs ${text}`);
  if (answer.documents === 0) return [emptyFinding(text, "--refs", rule.type)];
  const rows = brokenRows(answer.broken);
  const t = escapeInvisible(rule.type, 60);
  const path = escapeInvisible(rule.path, 120);
  return rows.slice(0, MAX_DOCUMENTS).map((row, k, all): Finding => {
    const never = row.found - row.live;
    const names = row.missing
      .slice(0, MAX_TARGETS)
      .map((m) => escapeInvisible(m, 80))
      .join(", ");
    const rest = row.missing.length > MAX_TARGETS ? ", and more" : "";
    return {
      checkId: "generated-ref-unpublished",
      severity: "high",
      title: GENERATED_TITLES.unpublished,
      evidence: `${t} ${escapeInvisible(row.id, 80)}: ${never} of ${row.found} references at ${path} point to documents that were never published: ${names}${rest}.${k === all.length - 1 ? more(rows.length > MAX_DOCUMENTS) : ""}`,
      url: urlOf(rule.type, row.id),
    };
  });
}

/**
 * Findings about one document together: the documents are ordered by their worst finding (then by
 * where they first appeared), and a document's own findings stay in the order they came, so a plan
 * whose total is short because a meal is unpublished prints both under its id.
 */
export function groupByDocument(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, { worst: number; first: number; items: Finding[] }>();
  findings.forEach((f, i) => {
    const g = groups.get(f.url) ?? { worst: 9, first: i, items: [] };
    g.worst = Math.min(g.worst, SEVERITY_ORDER[f.severity]);
    g.items.push(f);
    groups.set(f.url, g);
  });
  return [...groups.values()]
    .sort((a, b) => a.worst - b.worst || a.first - b.first)
    .flatMap((g) => g.items);
}
