import { SEVERITY_ORDER, type Severity } from "../model.js";
import { UNTRUSTED_CAPS } from "../untrusted.js";
import { forSlack, forSlackPlain } from "../untrusted-output.js";
import {
  MESSAGE_FINDINGS,
  SLACK_SECTION_MAX,
  slackFindingText,
  type SlackPayload,
} from "./payloads.js";

/** A finding a night opened, as a channel message shows it. Every text field is page text: data. */
export interface ChangedFinding {
  checkId: string;
  severity: Severity;
  title: string;
  evidence: string;
  url?: string;
  /** core's fingerprint(): the finding's identity across nights. */
  fingerprint: string;
}

/** What changed on one site since its previous nightly run (the worker's run_changes row). */
export interface SiteChanges {
  /** The site's name as the organisation typed it. */
  site: string;
  siteUrl: string;
  opened: ChangedFinding[];
  closed: number;
  stillOpen: number;
}

const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}\u2026` : s);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one-line summary: also Slack's notification text. Page text is escaped. */
function headline(c: SiteChanges): string {
  const parts = [
    c.opened.length > 0 ? plural(c.opened.length, "new finding", "new findings") : "",
    c.closed > 0 ? `${c.closed} fixed` : "",
  ].filter((s) => s !== "");
  return `Gaugeline: ${forSlackPlain(c.site, UNTRUSTED_CAPS.title)} has ${parts.join(", ")}`;
}

/**
 * One Slack message for one site's night: the new findings, most urgent first (at most ten), each with
 * its plain sentence, its evidence and its page; then how many were fixed and how many are still open.
 * An incoming webhook cannot edit a message it posted, so a fix is reported in the next night's message.
 */
export function slackChangesPayload(c: SiteChanges, appUrl?: string): SlackPayload {
  const head = headline(c);
  const blocks: SlackPayload["blocks"] = [
    { type: "section", text: { type: "mrkdwn", text: trim(`*${head}*`, SLACK_SECTION_MAX) } },
  ];
  const list = [...c.opened].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  for (const f of list.slice(0, MESSAGE_FINDINGS)) {
    const page = f.url ? `\n${forSlack(f.url)}` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: trim(
          slackFindingText(
            f.severity,
            forSlackPlain(f.title, UNTRUSTED_CAPS.title),
            forSlack(f.evidence),
          ) + page,
          SLACK_SECTION_MAX,
        ),
      },
    });
  }
  const more = list.length - MESSAGE_FINDINGS;
  const tail = [
    more > 0 ? `and ${more} more` : "",
    c.opened.length > 0 && c.stillOpen > 0 ? `${c.stillOpen} still open` : "",
    appUrl ? `<${appUrl}|Open in Gaugeline>` : "",
  ]
    .filter((s) => s !== "")
    .join(" \u00B7 ");
  if (tail)
    blocks.push({ type: "context", text: { type: "mrkdwn", text: trim(tail, SLACK_SECTION_MAX) } });
  return { text: trim(head, SLACK_SECTION_MAX), blocks };
}
