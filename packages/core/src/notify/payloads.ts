import { SEVERITY_LABEL, SEVERITY_ORDER, type Finding, type Severity } from "../model.js";
import type { Result } from "../result.js";
import { UNTRUSTED_CAPS } from "../untrusted.js";
import { forDiscord, forSlack, forSlackPlain, type SafeText } from "../untrusted-output.js";

/** Slack's limit for one section's text (Block Kit). Longer text is trimmed, never rejected. */
export const SLACK_SECTION_MAX = 3000;
/** The findings listed in a Slack or Discord message: the most urgent first. */
export const MESSAGE_FINDINGS = 10;

const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function urgent(result: Result): Finding[] {
  return [...result.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

function counts(result: Result): string {
  const n = (s: Severity) => result.findings.filter((f) => f.severity === s).length;
  if (result.findings.length === 0) return "Nothing to fix.";
  return (["high", "medium", "low"] as const)
    .filter((s) => n(s) > 0)
    .map((s) => `${n(s)} ${SEVERITY_LABEL[s].toLowerCase()}`)
    .join(" · ");
}

/** One finding's Slack text: the title as plain mrkdwn, the evidence in a code span. Escaped text only. */
export function slackFindingText(
  severity: Severity,
  title: SafeText<"slack">,
  evidence: SafeText<"slack">,
): string {
  return `*${SEVERITY_LABEL[severity]}:* ${title}\n\`${evidence}\``;
}

/** One finding as a Discord embed field. Escaped text only. */
export function discordField(
  severity: Severity,
  title: SafeText<"discord">,
  evidence: SafeText<"discord">,
): { name: string; value: string } {
  return { name: trim(`${SEVERITY_LABEL[severity]}: ${title}`, 256), value: trim(evidence, 1024) };
}

export interface SlackPayload {
  text: string;
  blocks: { type: string; text?: { type: string; text: string } }[];
}

export function slackPayload(result: Result, reportUrl?: string): SlackPayload {
  const list = urgent(result);
  const head = `*Gaugeline* checked ${forSlack(result.url)}: ${counts(result)}`;
  const blocks: SlackPayload["blocks"] = [
    { type: "section", text: { type: "mrkdwn", text: trim(head, SLACK_SECTION_MAX) } },
  ];
  for (const f of list.slice(0, MESSAGE_FINDINGS))
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: trim(
          slackFindingText(
            f.severity,
            forSlackPlain(f.title, UNTRUSTED_CAPS.title),
            forSlack(f.evidence),
          ),
          SLACK_SECTION_MAX,
        ),
      },
    });
  const more = list.length - MESSAGE_FINDINGS;
  const tail = [
    more > 0 ? `and ${more} more` : "",
    reportUrl ? `<${reportUrl}|Open the full report>` : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
  if (tail)
    blocks.push({ type: "context", text: { type: "mrkdwn", text: trim(tail, SLACK_SECTION_MAX) } });
  return { text: trim(head, SLACK_SECTION_MAX), blocks };
}

/** Embed colours by the worst finding; green when there is nothing to fix. */
export const DISCORD_COLOR: Readonly<Record<Severity | "none", number>> = {
  high: 0xb42318,
  medium: 0xb54708,
  low: 0x475467,
  none: 0x039855,
};

export interface DiscordPayload {
  /** No mention types: nothing in the message can ping anyone, whatever the page wrote. */
  allowed_mentions: { parse: string[] };
  embeds: {
    title: string;
    description: string;
    color: number;
    url?: string;
    fields: { name: string; value: string }[];
  }[];
}

export function discordPayload(result: Result, reportUrl?: string): DiscordPayload {
  const list = urgent(result);
  const worst = list[0]?.severity ?? "none";
  const more = list.length - MESSAGE_FINDINGS;
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: trim(`Gaugeline: ${forDiscord(result.url)}`, 256),
        description: trim(
          `${counts(result)}${more > 0 ? ` (the ${MESSAGE_FINDINGS} most urgent below, and ${more} more)` : ""}`,
          4096,
        ),
        color: DISCORD_COLOR[worst],
        ...(reportUrl ? { url: reportUrl } : {}),
        fields: list
          .slice(0, MESSAGE_FINDINGS)
          .map((f) =>
            discordField(
              f.severity,
              forDiscord(f.title, UNTRUSTED_CAPS.title),
              forDiscord(f.evidence),
            ),
          ),
      },
    ],
  };
}

/** The webhook gets the run exactly as --json prints it. */
export function webhookPayload(result: Result): Result {
  return result;
}
