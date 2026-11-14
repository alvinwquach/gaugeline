import { UNTRUSTED_CAPS } from "../untrusted.js";
import { forDiscord } from "../untrusted-output.js";
import { KIND_WORDS, type ApprovalRequest, type Decided } from "./slack-approval.js";

/**
 * The Discord messages for approving a draft in a channel (X69, part 3). Shapes and a validator only: this
 * file sends nothing. A proposal goes to the team's own channel through post.ts (ADR-0005). The answer to a
 * button press goes back in the HTTP response to Discord's own request (interaction callback types 4 and 7),
 * so it needs no request of ours at all.
 *
 * Every text field a draft, a site or a person supplies is data, escaped for Discord (forDiscord), and every
 * message carries `allowed_mentions: { parse: [] }`, so nothing in it can ping anyone. A button's
 * `custom_id` is the action and the draft's id and nothing else; a press is checked again on the server.
 */
export const DISCORD_APPROVE = "gaugeline_approve";
export const DISCORD_DECLINE = "gaugeline_decline";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^[0-9]{5,25}$/;

/** Component types and button styles (Discord's components reference). */
const ACTION_ROW = 1;
const BUTTON = 2;
const STYLE_SUCCESS = 3;
const STYLE_DANGER = 4;
const STYLE_LINK = 5;

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
}
export interface DiscordMessage {
  allowed_mentions: { parse: string[] };
  embeds: DiscordEmbed[];
  components: unknown[];
  content?: string;
}

const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const NO_PINGS = () => ({ parse: [] as string[] });

function embed(r: Pick<ApprovalRequest, "site" | "kind" | "title">, color: number): DiscordEmbed {
  const what = KIND_WORDS[r.kind] ?? "a change";
  const site = r.site === undefined ? "" : ` for ${forDiscord(r.site, UNTRUSTED_CAPS.title)}`;
  return {
    title: trim(`Gaugeline proposes ${what}${site}`, 256),
    description: trim(forDiscord(r.title, UNTRUSTED_CAPS.title), 4096),
    color,
  };
}

function plainUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 512) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (u.username !== "" || u.password !== "") return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** The proposal as it is posted: what it proposes, and Approve, Edit first (a link) and Decline. */
export function discordApprovalMessage(r: ApprovalRequest): DiscordMessage {
  if (!UUID.test(r.draftId)) throw new Error("a draft id is a UUID");
  const edit = plainUrl(r.inboxUrl);
  return {
    allowed_mentions: NO_PINGS(),
    embeds: [embed(r, 0x475467)],
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: BUTTON,
            style: STYLE_SUCCESS,
            label: "Approve",
            custom_id: `${DISCORD_APPROVE}:${r.draftId}`,
          },
          ...(edit ? [{ type: BUTTON, style: STYLE_LINK, label: "Edit first", url: edit }] : []),
          {
            type: BUTTON,
            style: STYLE_DANGER,
            label: "Decline",
            custom_id: `${DISCORD_DECLINE}:${r.draftId}`,
          },
        ],
      },
    ],
  };
}

/** `by` is shown as a mention only when it is a Discord id; the message cannot ping anyone either way. */
export function discordDecidedData(r: ApprovalRequest, d: Decided): DiscordMessage {
  const who = SNOWFLAKE.test(d.by) ? `<@${d.by}>` : "a teammate";
  const line =
    d.decision === "approved"
      ? `Approved by ${who} at ${d.at.toISOString()}. Your own worker applies it next; nothing changes until it does.`
      : `Declined by ${who} at ${d.at.toISOString()}. Nothing will be applied.`;
  return {
    allowed_mentions: NO_PINGS(),
    content: "",
    embeds: [{ ...embed(r, d.decision === "approved" ? 0x039855 : 0x475467), description: line }],
    components: [],
  };
}

/** The interaction callback that replaces the message the button was on (type 7, UPDATE_MESSAGE). */
export const discordUpdateMessage = (data: DiscordMessage) => ({ type: 7, data });

/** The interaction callback only the person who pressed sees (type 4 with the EPHEMERAL flag, 1 << 6). */
export function discordPrivateReply(text: string) {
  return {
    type: 4,
    data: {
      content: trim(forDiscord(text, 500), 2000),
      flags: 64,
      allowed_mentions: NO_PINGS(),
    },
  };
}

/** The answer to Discord's PING when an endpoint is registered (type 1, PONG). */
export const DISCORD_PONG = Object.freeze({ type: 1 });

/** Acknowledge a component press that asks for nothing, changing nothing (type 6, DEFERRED_UPDATE_MESSAGE). */
export const DISCORD_ACK = Object.freeze({ type: 6 });

/**
 * A Discord webhook address, `https://discord.com/api/webhooks/<id>/<token>`: exactly that shape on
 * Discord's own host (no port, no user name, no look-alike). The endpoint adds `with_components=true`,
 * without which Discord ignores the buttons. The address is a secret like a Slack webhook: only its host is
 * ever shown. Discord documents the host and path in its Execute Webhook reference.
 */
export function checkDiscordWebhook(
  value: unknown,
): { ok: true; endpoint: string; host: string } | { ok: false; error: string } {
  const bad = { ok: false as const, error: "not a Discord webhook address" };
  if (typeof value !== "string" || value.length > 2048) return bad;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return bad;
  }
  const ok =
    u.protocol === "https:" &&
    u.hostname === "discord.com" &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    u.search === "" &&
    u.hash === "" &&
    /^\/api\/webhooks\/[0-9]{5,25}\/[A-Za-z0-9_-]{20,100}$/.test(u.pathname);
  if (!ok) return bad;
  return { ok: true, endpoint: `${u.origin}${u.pathname}?with_components=true`, host: u.hostname };
}
