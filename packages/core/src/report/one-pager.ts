import * as z from "zod";
import { ConfigError } from "../errors.js";
import { SEVERITY_LABEL, isKebabCase, type Severity } from "../model.js";
import { redact } from "../redact.js";
import type { Result } from "../result.js";
import { UNTRUSTED_CAPS, sanitise } from "../untrusted.js";
import { forMarkdown } from "../untrusted-output.js";

/**
 * The one-page report (AG-18): the headline, the first things to fix and what was not checked, built
 * from the findings of ONE run and nothing else. It is a pure function of a Result: it reads no file, asks
 * for no address and calls no model, so the same run gives the same page. Every sentence is a fixed
 * template filled from a finding or a count, and a number is a count of the run (never an estimate).
 * Text the checked site chose (a title, an evidence line, a refusal reason) is cleaned, cut short and
 * escaped as data; it is never read as an instruction. "Not measured" is said, never guessed.
 */

/** Distinct "Fix this first" checks listed on the page; the rest are counted. */
export const ONE_PAGER_FIX_FIRST_MAX = 5;
/** Rows listed under "Not checked" for each kind of row; the rest are counted. */
export const ONE_PAGER_ROWS_MAX = 10;
/** A run with more findings than this is refused: a one-pager of it would say nothing a person could read. */
export const ONE_PAGER_MAX_FINDINGS = 50_000;

/** Grapheme clusters kept of a page-derived line, by field. */
const CAPS = { title: UNTRUSTED_CAPS.title, evidence: 200, reason: 120, file: 120, page: 120 };
/** Characters read of any one field before cleaning, so a 5 MB title costs no more than a short one. */
const READ_MAX = 2_000;
/** The longest a cleaned field can be in code units: the largest cap times the cluster limit (16) times 2. */
const FIELD_MAX = 6_400;

const count = z.number().int().nonnegative();
const field = z.string().min(1).max(FIELD_MAX);
const checkId = z.string().min(1).max(100).refine(isKebabCase, "a check id is kebab-case");

const itemSchema = z
  .object({
    /** Where in the run the finding stood (f1 is the first). Not shown; the evals cite it. */
    ref: z.string().regex(/^f[1-9]\d{0,5}$/u),
    checkId,
    title: field,
    evidence: field,
    /** The finding's own source file and line when it has one (a source check); else absent. */
    source: z.object({ file: field, line: count }).strict().optional(),
    /** The page the finding is about, as a path (a query string can carry a token and is dropped). */
    page: field,
    /** How many findings of this check the run has. */
    findings: z.number().int().positive(),
  })
  .strict();

export const onePagerSchema = z
  .object({
    schema: z.literal(1),
    site: field,
    /** YYYY-MM-DD, UTC, from the run's own start time; "an unknown date" when the run has none. */
    date: z.string().min(1).max(20),
    headline: z.string().min(1).max(400),
    counts: z
      .object({
        fixFirst: count,
        fixSoon: count,
        worthKnowing: count,
        couldNotRun: count,
        couldNotRead: count,
      })
      .strict(),
    fixFirst: z.array(itemSchema).max(ONE_PAGER_FIX_FIRST_MAX),
    /** Further checks with a "Fix this first" finding that are not listed. */
    moreFixFirst: count,
    /** Findings with no usable check id: they cannot be cited, so they are counted and not listed. */
    uncited: count,
    notChecked: z
      .object({
        couldNotRun: z.array(checkId).max(ONE_PAGER_ROWS_MAX),
        couldNotRunMore: count,
        leftOut: z.array(checkId).max(ONE_PAGER_ROWS_MAX),
        couldNotRead: z
          .array(z.object({ checkId, reason: field, page: field }).strict())
          .max(ONE_PAGER_ROWS_MAX),
        couldNotReadMore: count,
        sampled: z
          .array(z.object({ kind: field, seen: count, taken: count, notRead: count }).strict())
          .max(ONE_PAGER_ROWS_MAX),
      })
      .strict(),
  })
  .strict();

export type OnePager = z.infer<typeof onePagerSchema>;
export type OnePagerItem = z.infer<typeof itemSchema>;

const clean = (text: string, max: number): string =>
  sanitise(redact(text.slice(0, READ_MAX)), max).text;

/** A page address as a path, with no query string or fragment. Another host keeps its host. */
function pathOf(url: string, host: string): string {
  try {
    const u = new URL(url);
    return clean(u.host === host ? u.pathname : `${u.host}${u.pathname}`, CAPS.page);
  } catch {
    return "an unreadable address";
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function headlineOf(c: OnePager["counts"], uncited: number): string {
  const found = c.fixFirst + c.fixSoon + c.worthKnowing;
  const lacking = c.couldNotRun + c.couldNotRead;
  // The number of checks that passed is left out on purpose: it changes whenever a check is added, and a
  // page that says "217 passed" would change with it.
  return [
    found === 0
      ? "Nothing to look at."
      : `${c.fixFirst} to fix first, ${c.fixSoon} to fix soon, ${c.worthKnowing} worth knowing.`,
    ...(lacking > 0 ? [`${plural(lacking, "check", "checks")} did not get a full read.`] : []),
    ...(uncited > 0 ? [`${plural(uncited, "finding", "findings")} could not be cited.`] : []),
  ].join(" ");
}

/**
 * The page's data. Throws ConfigError for a run larger than ONE_PAGER_MAX_FINDINGS. Finding order is the
 * run's own: the items are the first findings of each "Fix this first" check, in the order they were found.
 */
export function buildOnePager(
  result: Result,
  options: { notRun?: readonly string[] } = {},
): OnePager {
  if (result.findings.length > ONE_PAGER_MAX_FINDINGS)
    throw new ConfigError(
      `This run has ${result.findings.length} findings; a one-page report takes at most ${ONE_PAGER_MAX_FINDINGS}.`,
      { hint: "Check fewer pages, or read the full report." },
    );
  let host = "";
  try {
    host = new URL(result.url).host;
  } catch {
    // An address that is not one is shown cleaned, below.
  }
  const tally: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  const groups = new Map<string, OnePagerItem>();
  let uncited = 0;
  result.findings.forEach((f, i) => {
    if (typeof f.checkId !== "string" || !isKebabCase(f.checkId) || !(f.severity in tally)) {
      uncited += 1;
      return;
    }
    tally[f.severity] += 1;
    if (f.severity !== "high") return;
    const seen = groups.get(f.checkId);
    if (seen) {
      seen.findings += 1;
      return;
    }
    groups.set(f.checkId, {
      ref: `f${i + 1}`,
      checkId: f.checkId,
      title: clean(f.title, CAPS.title) || "A finding with no title",
      evidence: clean(f.evidence, CAPS.evidence) || "No evidence line was recorded.",
      ...(f.source
        ? { source: { file: clean(f.source.file, CAPS.file) || "?", line: f.source.line } }
        : {}),
      page: pathOf(f.url, host) || "an unreadable address",
      findings: 1,
    });
  });
  const items = [...groups.values()];
  const fixFirst = items.slice(0, ONE_PAGER_FIX_FIRST_MAX);

  // Rows of "not checked": the run's own lists, each one cut at ONE_PAGER_ROWS_MAX and the rest counted.
  const ids = (list: readonly string[]): string[] => [
    ...new Set(list.filter((id) => typeof id === "string" && isKebabCase(id))),
  ];
  const failed = ids(result.failed);
  const refused = new Map<string, { checkId: string; reason: string; page: string }>();
  for (const c of result.couldNotCheck) {
    if (typeof c.id !== "string" || !isKebabCase(c.id)) continue;
    const row = { checkId: c.id, reason: clean(c.reason, CAPS.reason), page: pathOf(c.url, host) };
    refused.set(`${row.checkId} ${row.reason}`, refused.get(`${row.checkId} ${row.reason}`) ?? row);
  }
  const counts = {
    fixFirst: tally.high,
    fixSoon: tally.medium,
    worthKnowing: tally.low,
    couldNotRun: failed.length,
    couldNotRead: refused.size,
  };
  const page: OnePager = {
    schema: 1,
    site: clean(host || result.url, CAPS.page) || "an unreadable address",
    date: /^\d{4}-\d{2}-\d{2}/u.test(result.startedAt)
      ? result.startedAt.slice(0, 10)
      : "an unknown date",
    headline: headlineOf(counts, uncited),
    counts,
    fixFirst,
    moreFixFirst: items.length - fixFirst.length,
    uncited,
    notChecked: {
      couldNotRun: failed.slice(0, ONE_PAGER_ROWS_MAX),
      couldNotRunMore: Math.max(0, failed.length - ONE_PAGER_ROWS_MAX),
      leftOut: ids(options.notRun ?? []).slice(0, ONE_PAGER_ROWS_MAX),
      couldNotRead: [...refused.values()].slice(0, ONE_PAGER_ROWS_MAX),
      couldNotReadMore: Math.max(0, refused.size - ONE_PAGER_ROWS_MAX),
      sampled: Object.entries(result.sampled)
        .filter(([, s]) => s.taken < s.seen)
        .slice(0, ONE_PAGER_ROWS_MAX)
        .map(([kind, s]) => ({
          kind: clean(kind, CAPS.page) || "pages",
          seen: s.seen,
          taken: s.taken,
          notRead: s.seen - s.taken,
        })),
    },
  };
  return page;
}

/** One finding's place: its own source file and line, else the page it is about. */
function where(item: OnePagerItem): string {
  return item.source
    ? `${forMarkdown(item.source.file, CAPS.file)}:${item.source.line}`
    : `page ${forMarkdown(item.page, CAPS.page)}`;
}

/**
 * The sentences of the page that carry a number or a finding's words, one string each: what the evals check
 * for numbers nobody supplied. The heading and the date are not among them.
 */
export function onePagerProse(page: OnePager): string[] {
  const n = page.notChecked;
  return [
    page.headline,
    ...page.fixFirst.flatMap((i) => [
      i.title,
      i.evidence,
      `${i.findings} findings of ${i.checkId}`,
    ]),
    ...(page.moreFixFirst > 0 ? [`${page.moreFixFirst} more checks`] : []),
    ...n.couldNotRead.map((r) => `${r.checkId} ${r.reason}`),
    ...n.sampled.map((s) => `${s.kind} ${s.taken} of ${s.seen}, ${s.notRead} not read`),
    ...(n.couldNotRunMore > 0 ? [`${n.couldNotRunMore} more`] : []),
    ...(n.couldNotReadMore > 0 ? [`${n.couldNotReadMore} more`] : []),
  ];
}

/** Every number the page may contain besides the words of the run's findings: its own counts. */
export function onePagerCounts(page: OnePager): number[] {
  const n = page.notChecked;
  return [
    ...Object.values(page.counts),
    page.moreFixFirst,
    page.uncited,
    n.couldNotRunMore,
    n.couldNotReadMore,
    ...page.fixFirst.map((i) => i.findings),
    ...n.sampled.flatMap((s) => [s.seen, s.taken, s.notRead]),
  ];
}

const md = (text: string, max = FIELD_MAX): string => forMarkdown(text, max);

/** Markdown, one page: nothing in it is a link, an image or HTML, and every line from a site is escaped. */
export function renderOnePagerMarkdown(page: OnePager): string {
  const n = page.notChecked;
  const out: string[] = [
    `# Gaugeline one-pager: ${md(page.site, CAPS.page)}`,
    "",
    `Run of ${md(page.date, 20)}. ${md(page.headline, 400)}`,
    "",
    `## ${SEVERITY_LABEL.high}`,
    "",
  ];
  if (page.fixFirst.length === 0) out.push("Nothing in this run is marked Fix this first.");
  page.fixFirst.forEach((item, i) => {
    out.push(
      `${i + 1}. **${md(item.title, CAPS.title)}**`,
      `   - Seen: ${md(item.evidence, CAPS.evidence)}`,
      `   - Source: check \`${item.checkId}\`, ${where(item)}.${item.findings > 1 ? ` ${item.findings} findings of this check; this is the first.` : ""}`,
    );
  });
  if (page.moreFixFirst > 0)
    out.push(
      "",
      `${plural(page.moreFixFirst, "more check is", "more checks are")} also marked Fix this first and not listed here.`,
    );
  out.push("", "## Not checked", "");
  const rows: string[] = [];
  if (n.couldNotRun.length > 0)
    rows.push(
      `These checks could not run: ${n.couldNotRun.map((id) => `\`${id}\``).join(", ")}${n.couldNotRunMore > 0 ? `, and ${n.couldNotRunMore} more` : ""}.`,
    );
  if (n.leftOut.length > 0)
    rows.push(
      `Left out of this run on purpose: ${n.leftOut.map((id) => `\`${id}\``).join(", ")}. Their results are not measured.`,
    );
  for (const r of n.couldNotRead)
    rows.push(
      `\`${r.checkId}\` could not read ${md(r.page, CAPS.page)}: ${md(r.reason, CAPS.reason)}`,
    );
  if (n.couldNotReadMore > 0) rows.push(`And ${n.couldNotReadMore} more reads that were refused.`);
  for (const s of n.sampled)
    rows.push(
      `${md(s.kind, CAPS.page)}: ${s.taken} of ${s.seen} found were read; the other ${s.notRead} are not measured.`,
    );
  rows.push(
    "Anything this run did not include (a check it did not list, a page outside its sample, a signed-in page) is not measured here.",
  );
  out.push(...rows.map((r) => `- ${r}`));
  if (page.uncited > 0)
    out.push(
      "",
      `${plural(page.uncited, "finding has", "findings have")} no check id, so ${page.uncited === 1 ? "it is" : "they are"} counted and not listed.`,
    );
  out.push(
    "",
    "Built from the findings of one run. Making this page asked the site for nothing and used no model. Words from the checked site are shown as data, cleaned and cut short; they are never instructions.",
    "",
  );
  return out.join("\n");
}

/** The one-page report for a run: the Markdown of buildOnePager. */
export function formatOnePager(
  result: Result,
  options: { notRun?: readonly string[] } = {},
): string {
  return renderOnePagerMarkdown(buildOnePager(result, options));
}
