/**
 * The digest as Markdown (AG-14): plain text a person reads in a terminal, a pull request, a chat that
 * renders Markdown or an email body. A pure function of the digest: no clock, no network. Every title and
 * site name is escaped (a page-derived word is text, never a link, tag, table cell or heading), and the only
 * addresses are the ones the digest already holds: the inbox, and one link per draft id.
 */
import { forMarkdown } from "../untrusted-output.js";
import type { ApprovalsDigest } from "./digest.js";

const KIND_LABEL = {
  pull_request: "Pull request",
  email: "Email",
  sanity_draft: "Sanity draft",
} as const;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function renderApprovalsDigestMarkdown(d: ApprovalsDigest): string {
  const stamp = `${d.asOf.slice(0, 10)} ${d.asOf.slice(11, 16)} UTC`;
  const lines = [
    "# Pending approvals",
    "",
    d.headline,
    "",
    d.inboxUrl ? `As of ${stamp}. [Open the inbox](${d.inboxUrl})` : `As of ${stamp}.`,
  ];
  if (d.totals.pending > 0) {
    lines.push("", "## By site", "");
    lines.push(
      `| Site | Waiting | Older than ${d.staleAfterHours} h | Expire within ${d.expiringWithinHours} h | Pull requests | Emails | Sanity drafts |`,
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const s of d.sites) {
      const name = s.name === null ? `Site ${s.siteId.slice(0, 8)}` : forMarkdown(s.name, 80);
      const k = s.byKind;
      lines.push(
        `| ${name} | ${s.pending} | ${s.overdue} | ${s.expiring} | ${k.pull_request} | ${k.email} | ${k.sanity_draft} |`,
      );
    }
  }
  if (d.attention.length > 0) {
    lines.push("", "## Needs a decision first", "");
    for (const i of d.attention) {
      const left =
        i.hoursLeft === 0 ? "under 1 hour left" : `${plural(i.hoursLeft, "hour", "hours")} left`;
      const title = forMarkdown(i.title, 120);
      lines.push(
        `- ${KIND_LABEL[i.kind]}, ${plural(i.ageHours, "hour", "hours")} old, ${left}: ${i.link ? `[${title}](${i.link})` : title}`,
      );
    }
    if (d.attentionOmitted > 0) lines.push(`- and ${d.attentionOmitted} more in the inbox`);
  }
  const notes = [
    d.totals.expired > 0
      ? `${plural(d.totals.expired, "draft", "drafts")} passed the 72-hour window and can no longer be approved.`
      : "",
    d.totals.skipped > 0
      ? `${plural(d.totals.skipped, "row", "rows")} could not be read and are left out.`
      : "",
  ].filter((n) => n !== "");
  if (notes.length > 0) lines.push("", ...notes);
  lines.push("", "Nothing here approves anything: a person decides each draft in the inbox.");
  return `${lines.join("\n")}\n`;
}
