/**
 * The text of the Action's pull request comment (ACTION-COMMENT part 2; ADR-0005, amendment of 14 Nov 2026).
 * Plain rules over the run's findings: counts by level, a capped list of finding titles with their check ids and
 * a link to the check's entry in the checks reference, how many findings are new compared with the baseline saved from main, and the
 * exit state. No model writes any of it, and the same input gives the same text.
 *
 * Page-derived text (a finding's title) is data. Each title is cleaned by `sanitise` (tag and bidirectional
 * characters removed, controls shown, cut at the title cap), has its backticks turned into apostrophes and its
 * whitespace flattened, and is shown inside one code span. A code span is not read as a mention, a link, an
 * image, a reference or HTML, so a title cannot notify a person, point to another host or start markup. The
 * check id is Gaugeline's own, but it is checked as a slug before it becomes a link; the link's host is fixed.
 * Nothing else from the page is in the comment: no address, no evidence line, no body.
 */
import { checkDocsUrl } from "../docs-url.js";
import { fingerprint } from "../fingerprint.js";
import { SEVERITY_LABEL, SEVERITY_ORDER, type Finding, type Severity } from "../model.js";
import type { FindingsBaseline } from "../config/baseline.js";
import { UNTRUSTED_CAPS, sanitise } from "../untrusted.js";
import { stripAnsi } from "../untrusted-output.js";

/** How many finding titles the comment lists before it says how many more there are. */
export const MAX_COMMENT_FINDINGS = 10;
/** The most characters in the whole comment: a fifth of GitHub's limit of 65,536, so it is small and never refused. */
export const MAX_PR_COMMENT_CHARS = 8_000;

/** A check id as the checks reference spells it. Anything else is shown as text and never linked. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export type CommentFinding = Pick<
  Finding,
  "checkId" | "severity" | "title" | "url" | "evidence" | "group"
>;

export interface PrCommentInput {
  /** Every finding of this run that was not muted, including the ones main's baseline already knows. */
  findings: readonly CommentFinding[];
  /** The baseline saved from main. Absent: the comment says there is none to compare with. */
  baseline?: FindingsBaseline;
  /** The exit code the run ends with: 1 only with --ci and a "Fix this first" finding. */
  exitCode: 0 | 1;
  /** Checks that could not run. */
  couldNotCheck: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const label = (s: Severity) => SEVERITY_LABEL[s];

/** Page text as one line inside a code span: cleaned, no backtick, no line break, never empty. */
function inCode(text: string, max: number): string {
  const flat = sanitise(stripAnsi(text), max).text.replace(/`/gu, "'").replace(/\s+/gu, " ").trim();
  return `\`${flat === "" ? "(no title)" : flat}\``;
}

/** The check id, as a link to its page when it is a slug, as plain code when it is not. */
function checkRef(id: string): string {
  return SLUG.test(id) ? `[${id}](${checkDocsUrl(id)})` : inCode(id, 40);
}

/** Cut at a line, never inside one, and say so. Counts characters, not bytes: the cap is far under the limit. */
export function capComment(text: string, max: number = MAX_PR_COMMENT_CHARS): string {
  if (text.length <= max) return text;
  const note = "\n\n(cut to fit)\n";
  const head = text.slice(0, max - note.length);
  const at = head.lastIndexOf("\n");
  return `${(at > 0 ? head.slice(0, at) : head).trimEnd()}${note}`;
}

/** The comment, as Markdown. */
export function buildPrComment(input: PrCommentInput): string {
  const { baseline, exitCode, couldNotCheck } = input;
  // One entry per fingerprint, the way the baseline counts, in a fixed order: new first, then level, then check id.
  const known = baseline ? new Set(baseline.findings.map((e) => e.fingerprint)) : undefined;
  const seen = new Map<string, { f: CommentFinding; isNew: boolean }>();
  for (const f of input.findings) {
    const fp = fingerprint(f);
    if (!seen.has(fp)) seen.set(fp, { f, isNew: known !== undefined && !known.has(fp) });
  }
  const rows = [...seen.entries()]
    .map(([fp, r]) => ({ fp, ...r }))
    .sort(
      (a, b) =>
        Number(b.isNew) - Number(a.isNew) ||
        SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] ||
        a.f.checkId.localeCompare(b.f.checkId) ||
        a.fp.localeCompare(b.fp),
    );
  const by = (s: Severity) => rows.filter((r) => r.f.severity === s).length;
  const high = by("high");
  const out: string[] = [
    `### Gaugeline: ${rows.length === 0 ? "no findings" : plural(rows.length, "finding", "findings")}`,
    "",
  ];
  if (rows.length > 0)
    out.push(
      "| Level | Findings |",
      "| --- | ---: |",
      ...(["high", "medium", "low"] as const).map((s) => `| ${label(s)} | ${by(s)} |`),
      "",
    );
  if (couldNotCheck > 0) out.push(`${plural(couldNotCheck, "check", "checks")} could not run.`, "");
  if (known === undefined) out.push("**Compared with main:** no baseline to compare with.", "");
  else {
    const fresh = rows.filter((r) => r.isNew);
    const freshHigh = fresh.filter((r) => r.f.severity === "high").length;
    out.push(
      `**Compared with main:** ${fresh.length === 0 ? "nothing new" : `${fresh.length} new${freshHigh > 0 ? ` (${freshHigh} ${label("high")})` : ""}`}, ${rows.length - fresh.length} already in main's baseline.`,
      "",
    );
  }
  if (rows.length > 0) {
    out.push(
      ...rows
        .slice(0, MAX_COMMENT_FINDINGS)
        .map(
          (r) =>
            `- ${label(r.f.severity)}: ${inCode(r.f.title, UNTRUSTED_CAPS.title)} (${checkRef(r.f.checkId)})${r.isNew ? ", new" : ""}`,
        ),
    );
    if (rows.length > MAX_COMMENT_FINDINGS)
      out.push(
        "",
        `${rows.length - MAX_COMMENT_FINDINGS} more: run Gaugeline on the preview to see them all.`,
      );
    out.push("");
  }
  out.push(
    exitCode === 1
      ? `Exit code 1: ${plural(high, `"${label("high")}" finding fails`, `"${label("high")}" findings fail`)} this run (--ci).`
      : "Exit code 0.",
  );
  return capComment(`${out.join("\n")}\n`);
}
