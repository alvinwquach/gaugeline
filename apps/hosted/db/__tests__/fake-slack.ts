/**
 * A local stand-in for Slack (X69): no real app, no real token, no network. It holds the messages a team's
 * channel shows, "presses" their buttons by sending the signed interaction request real Slack would send
 * (a form with one `payload` field, signed with the app's signing secret), and applies the replies the
 * hosted app posts to the `response_url` (replace the message, or show a line to the clicker only).
 * Everything in it is invented (rule 12).
 */
import { createHmac, randomBytes } from "node:crypto";
import type { SlackReply } from "@gaugeline/core";

interface Message {
  text: string;
  blocks: { type: string; text?: { text: string }; elements?: Record<string, unknown>[] }[];
}

export class FakeSlack {
  readonly channel = new Map<string, Message>();
  /** What only the clicker saw, per Slack user id. */
  readonly private = new Map<string, string[]>();
  /** Every reply the app posted to a response address, in order. */
  readonly replies: { endpoint: string; body: SlackReply }[] = [];
  /** As posted: a stale copy of a message that was since replaced still has its buttons, as in real Slack. */
  private readonly original = new Map<string, Message>();
  private presses = new Map<string, { ts: string; user: string }>();
  private n = 0;

  constructor(
    readonly secret: string,
    readonly team: string,
  ) {}

  /** What the team's incoming webhook does with a posted message: show it, under a new timestamp. */
  post(body: unknown): string {
    const ts = `1731488400.${String(++this.n).padStart(6, "0")}`;
    this.channel.set(ts, body as Message);
    this.original.set(ts, body as Message);
    return ts;
  }

  buttons(ts: string) {
    return (this.original.get(ts)?.blocks.find((b) => b.type === "actions")?.elements ?? []) as {
      action_id: string;
      value?: string;
      url?: string;
    }[];
  }

  /** The signed request for pressing `actionId` on the message at `ts` as `user`. */
  press(
    ts: string,
    actionId: string,
    user: string,
    over: {
      secret?: string;
      timestamp?: number;
      team?: string;
      mutate?: (p: Record<string, unknown>) => void;
    } = {},
  ): { path: (id: string) => string; body: string; headers: Record<string, string> } {
    const button = this.buttons(ts).find((b) => b.action_id === actionId);
    const token = randomBytes(8).toString("hex");
    const responseUrl = `https://hooks.slack.com/actions/${this.team}/${++this.n}/${token}`;
    this.presses.set(token, { ts, user });
    const payload: Record<string, unknown> = {
      type: "block_actions",
      user: { id: user, username: "invented.person", team_id: over.team ?? this.team },
      team: { id: over.team ?? this.team, domain: "northgate-example" },
      api_app_id: "A0EXAMPLE",
      container: { type: "message", message_ts: ts },
      channel: { id: "C0TIDEWATER", name: "tidewater" },
      message: { type: "message", ts, text: this.channel.get(ts)?.text },
      response_url: responseUrl,
      actions: [
        {
          type: "button",
          action_id: actionId,
          block_id: "b1",
          ...(button?.value ? { value: button.value } : {}),
          text: { type: "plain_text", text: "x" },
          action_ts: "1731488410.000100",
        },
      ],
    };
    over.mutate?.(payload);
    const body = "payload=" + encodeURIComponent(JSON.stringify(payload));
    const timestamp = over.timestamp ?? Math.floor(Date.now() / 1000);
    const signature =
      "v0=" +
      createHmac("sha256", over.secret ?? this.secret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");
    return {
      path: (id) => `/api/chat/slack/${id}`,
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": signature,
      },
    };
  }

  /** What the hosted app's POST to a response address does in Slack. */
  reply = async (endpoint: string, body: SlackReply) => {
    this.replies.push({ endpoint, body });
    const press = this.presses.get(endpoint.split("/").pop() ?? "");
    if (!press) return { ok: false, status: 404 };
    if (body.replace_original) this.channel.set(press.ts, body as Message);
    else this.private.set(press.user, [...(this.private.get(press.user) ?? []), body.text]);
    return { ok: true, status: 200 };
  };
}
