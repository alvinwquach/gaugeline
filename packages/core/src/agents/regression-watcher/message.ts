/**
 * The regression alert as a message object (AG-13). It is only text: nothing here posts, sends or writes,
 * and there is no clock and no network. A later step may hand the message to a channel; until then it is
 * what the agent returns. A report that did not get worse gives no message at all: that is how "post only
 * when something got worse" is kept, by the absence of a thing to post.
 *
 * The subject is fixed words and a count, so nothing from a finding can reach it. The body is Markdown, and
 * every title and the site name is escaped (a page-derived word is text, never a link, tag, mention or
 * heading). The message holds no address: it does not know the hosted app's routes.
 */
import { SEVERITY_LABEL } from "../../model.js";
import { forMarkdown } from "../../untrusted-output.js";
import type { RegressionReport } from "./compare.js";

/** An agent's message for the person who owns the site. `kind` names the shape for whatever delivers it. */
export interface RegressionMessage {
  kind: "regression-alert";
  subject: string;
  /** Markdown. */
  body: string;
  /** New findings plus findings that went up in severity: what the subject counts. */
  worse: number;
}

export interface RegressionMessageOptions {
  /** The site's name for a person to read. Page-adjacent text: cleaned, cut and escaped like a title. */
  siteName?: string;
}

const SITE_NAME_MAX = 80;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The message for a report, or null when nothing got worse (or nothing could be compared). */
export function buildRegressionMessage(
  report: RegressionReport,
  opts: RegressionMessageOptions = {},
): RegressionMessage | null {
  if (report.status !== "compared" || !report.worse || report.previous === null) return null;
  const worse = report.counts.added + report.counts.worsened;
  const site =
    opts.siteName === undefined ? "" : `${forMarkdown(opts.siteName, SITE_NAME_MAX)}: the `;
  const lines = [
    "# Regression watch",
    "",
    report.headline,
    "",
    `${site || "The "}run of ${stamp(report.current.takenAt)} against the run of ${stamp(report.previous.takenAt)}.`,
  ];
  if (report.worsened.length > 0) {
    lines.push("", "## Went up in severity", "");
    for (const w of report.worsened)
      lines.push(
        `- ${SEVERITY_LABEL[w.severity]}, was ${SEVERITY_LABEL[w.from]}: ${forMarkdown(w.title, 120)}`,
      );
    if (report.omitted.worsened > 0) lines.push(`- and ${report.omitted.worsened} more`);
  }
  if (report.added.length > 0) {
    lines.push("", "## New", "");
    for (const a of report.added)
      lines.push(`- ${SEVERITY_LABEL[a.severity]}: ${forMarkdown(a.title, 120)}`);
    if (report.omitted.added > 0) lines.push(`- and ${report.omitted.added} more`);
  }
  if (report.counts.resolved > 0)
    lines.push("", `Fixed since the last run: ${report.counts.resolved}.`);
  lines.push("", "Nothing here changes your site: a person decides what to do.");
  return {
    kind: "regression-alert",
    subject: `Regression watch: ${plural(worse, "finding", "findings")} got worse`,
    body: `${lines.join("\n")}\n`,
    worse,
  };
}
