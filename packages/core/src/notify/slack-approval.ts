import { UNTRUSTED_CAPS } from "../untrusted.js";
import { forSlackPlain } from "../untrusted-output.js";
import { SLACK_SECTION_MAX } from "./payloads.js";

/**
 * The Slack messages for approving a draft in the channel (X69). Shapes only: this file builds JSON and
 * sends nothing. Every message goes out through post.ts (ADR-0005), to the team's own webhook or to the
 * `response_url` Slack gave with a button press, which checkSlackResponseUrl checks first.
 *
 * Every text field a draft or a site name supplies is data, escaped for Slack (forSlackPlain): a title
 * that says `<!channel>` is shown as text and pings nobody. Button values carry the draft's id and
 * nothing else; a press is checked again on the server, so a value is a name, never an instruction.
 */
export const APPROVE_ACTION = "gaugeline_approve";
export const DECLINE_ACTION = "gaugeline_decline";
export const EDIT_ACTION = "gaugeline_edit";

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: unknown[];
}
export interface SlackApprovalMessage {
  text: string;
  blocks: SlackBlock[];
}
/** A message sent to a `response_url`: it replaces the clicked message or is shown to the clicker only. */
export interface SlackReply extends SlackApprovalMessage {
  replace_original?: boolean;
  response_type?: "ephemeral" | "in_channel";
}

export interface ApprovalRequest {
  /** The site's name as the organisation typed it; left out where the caller does not have it. */
  site?: string;
  /** The draft's kind (`pull_request`, `email`, `sanity_draft`). */
  kind: string;
  /** What the draft proposes, one line: page-derived or agent text, so data. */
  title: string;
  draftId: string;
  /** Where "Edit first" opens: the inbox at this draft. Left out when it is not a plain http(s) address. */
  inboxUrl?: string;
}

const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
export const KIND_WORDS: Record<string, string> = {
  pull_request: "a pull request",
  email: "an email draft",
  sanity_draft: "a content draft",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/;

function summary(r: Pick<ApprovalRequest, "site" | "kind" | "title">): string {
  const site = r.site === undefined ? "" : ` for ${forSlackPlain(r.site, UNTRUSTED_CAPS.title)}`;
  const what = KIND_WORDS[r.kind] ?? "a change";
  return `*Gaugeline proposes ${what}${site}*\n${forSlackPlain(r.title, UNTRUSTED_CAPS.title)}`;
}

/** A plain http(s) address with no user name or password, or undefined. */
function plainUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2000) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (u.username !== "" || u.password !== "") return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** The proposal as it is posted: what it proposes, and Approve, Decline and Edit first. */
export function slackApprovalMessage(r: ApprovalRequest): SlackApprovalMessage {
  if (!UUID.test(r.draftId)) throw new Error("a draft id is a UUID");
  const edit = plainUrl(r.inboxUrl);
  const button = (text: string, action_id: string, style?: "primary" | "danger") => ({
    type: "button",
    text: { type: "plain_text", text },
    action_id,
    value: r.draftId,
    ...(style ? { style } : {}),
  });
  const elements: unknown[] = [
    button("Approve", APPROVE_ACTION, "primary"),
    ...(edit
      ? [
          {
            type: "button",
            text: { type: "plain_text", text: "Edit first" },
            action_id: EDIT_ACTION,
            url: edit,
          },
        ]
      : []),
    button("Decline", DECLINE_ACTION, "danger"),
  ];
  const text = summary(r);
  return {
    text: trim(text.replace(/\*/g, "").replace(/\n/g, ": "), SLACK_SECTION_MAX),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: trim(text, SLACK_SECTION_MAX) } },
      { type: "actions", elements },
    ],
  };
}

export interface Decided {
  decision: "approved" | "declined";
  /** The Slack user who pressed the button, shown as a mention. Anything that is not a Slack id is not shown. */
  by: string;
  at: Date;
}

/** The same message after a decision: no buttons, who decided and when. Replaces the clicked message. */
export function slackDecidedMessage(r: ApprovalRequest, d: Decided): SlackReply {
  const who = SLACK_USER.test(d.by) ? `<@${d.by}>` : "a teammate";
  const line =
    d.decision === "approved"
      ? `Approved by ${who} at ${d.at.toISOString()}. Your own worker applies it next; nothing changes until it does.`
      : `Declined by ${who} at ${d.at.toISOString()}. Nothing will be applied.`;
  const head = summary(r);
  return {
    replace_original: true,
    text: trim(`${d.decision === "approved" ? "Approved" : "Declined"}: ${r.title}`, 300).replace(
      /[<>&]/g,
      " ",
    ),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: trim(head, SLACK_SECTION_MAX) } },
      { type: "context", text: { type: "mrkdwn", text: line } },
    ],
  };
}

/** A reply only the person who pressed the button sees; the channel's message is left as it is. */
export function slackPrivateReply(text: string): SlackReply {
  const safe = trim(forSlackPlain(text, 500), SLACK_SECTION_MAX);
  return {
    response_type: "ephemeral",
    replace_original: false,
    text: safe,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: safe } }],
  };
}

/**
 * The address Slack gives with a button press to answer it: `https://hooks.slack.com/actions/<ids>`.
 * Refused unless it is exactly that shape on Slack's own host (no port, no user name, no query), so a
 * forged-but-signed payload can still not point the reply anywhere else. It is a secret like a webhook:
 * only its host is ever shown.
 */
export function checkSlackResponseUrl(
  value: unknown,
): { ok: true; endpoint: string; host: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length > 2048)
    return { ok: false, error: "not a Slack response address" };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, error: "not a Slack response address" };
  }
  const ok =
    u.protocol === "https:" &&
    u.hostname === "hooks.slack.com" &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    u.search === "" &&
    u.hash === "" &&
    /^\/actions\/[A-Za-z0-9]{1,40}\/[0-9]{1,20}\/[A-Za-z0-9]{1,80}$/.test(u.pathname);
  return ok
    ? { ok: true, endpoint: u.href, host: u.hostname }
    : { ok: false, error: "not a Slack response address" };
}
