/**
 * Discord's side of approving in chat (X69, part 3): the interaction a button press sends, and the answer.
 * Before the body is parsed everything is chat/receive.ts (size, connection, secret, signature, replay);
 * everything that decides is chat/decide.ts (private.chat_decide). This file reads Discord's payload shape
 * and answers.
 *
 * Discord answers a press in the HTTP response to its own request (interaction callback type 7 replaces the
 * message, type 4 with the ephemeral flag shows the clicker a private line), so this endpoint sends no
 * request of its own. The only request Gaugeline makes for Discord is the proposal posted to the team's own
 * webhook, through core's postJson (ADR-0005), after checkDiscordWebhook pinned the host.
 *
 * The payload is signed, so it came from the team's own Discord application; it is still untrusted TEXT:
 * only an id of a known shape is taken from each field.
 */
import {
  checkDiscordWebhook,
  DISCORD_ACK,
  DISCORD_APPROVE,
  DISCORD_DECLINE,
  DISCORD_PONG,
  discordApprovalMessage,
  discordDecidedData,
  discordPrivateReply,
  discordUpdateMessage,
  postJson,
  type ApprovalRequest,
} from "@gaugeline/core";
import type postgres from "postgres";
import type { ApplyQueue } from "../inbox/inbox.js";
import { decideFromChat, type ChatAction, type ChatDecision } from "./decide.js";
import { authenticate, rejection } from "./receive.js";
import { alreadyText, refusalText, titleOf } from "./replies.js";
import type { ChatStore } from "./store.js";
import { discordVerifier } from "./verify.js";

type PostResult = Awaited<ReturnType<typeof postJson>>;

export interface DiscordDeps {
  /** The chat login: a member of gaugeline_chat only. */
  sql: postgres.Sql;
  store: ChatStore;
  queue: ApplyQueue;
  now?: () => Date;
  /** The app's public address, for "Edit first". */
  appUrl?: string;
}

export type DiscordInteraction =
  | { kind: "malformed" }
  | { kind: "ping" }
  /** A component press that asks for nothing here (another application's button, a link). */
  | { kind: "ignore" }
  | { kind: "decision"; action: ChatAction };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^[0-9]{5,25}$/;
const CUSTOM_ID = new RegExp(`^(${DISCORD_APPROVE}|${DISCORD_DECLINE}):([0-9a-fA-F-]{36})$`);
const PING = 1;
const MESSAGE_COMPONENT = 3;
const BUTTON = 2;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Exactly the type Discord sends, with or without parameters; nothing that merely starts with it. */
function isJsonType(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * An interaction is JSON: `type` 1 is a PING, `type` 3 a message component, whose `data.custom_id` names the
 * button, `member.user.id` the person and `guild_id` the server (Discord's interactions reference). Called
 * only on a body whose signature has been checked.
 */
export function parseDiscord(rawBody: Buffer, contentType: string | null): DiscordInteraction {
  if (!isJsonType(contentType)) return { kind: "malformed" };
  let p: unknown;
  try {
    p = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { kind: "malformed" };
  }
  if (!isRecord(p)) return { kind: "malformed" };
  if (p.type === PING) return { kind: "ping" };
  if (p.type !== MESSAGE_COMPONENT) return { kind: "malformed" };
  const data = isRecord(p.data) ? p.data : {};
  if (data.component_type !== BUTTON || typeof data.custom_id !== "string")
    return { kind: "ignore" };
  const match = CUSTOM_ID.exec(data.custom_id);
  if (!match) return { kind: "ignore" };
  if (!UUID.test(match[2]!)) return { kind: "malformed" };
  const member = isRecord(p.member) ? p.member : {};
  const user = isRecord(member.user) ? member.user : {};
  // A press in a direct message has a `user` and no `member`: it names no server, so it decides nothing.
  if (typeof user.id !== "string" || !SNOWFLAKE.test(user.id)) return { kind: "malformed" };
  if (user.bot === true) return { kind: "malformed" };
  return {
    kind: "decision",
    action: {
      chatUserId: user.id,
      workspace: typeof p.guild_id === "string" && SNOWFLAKE.test(p.guild_id) ? p.guild_id : null,
      draftId: match[2]!.toLowerCase(),
      choice: match[1] === DISCORD_APPROVE ? "approve" : "decline",
    },
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

function answer(deps: DiscordDeps, result: ChatDecision, discordUser: string, draftId: string) {
  if (result.status === "recorded") {
    const summary: ApprovalRequest = {
      kind: result.kind,
      title: titleOf(result.payloadText),
      draftId,
    };
    return discordUpdateMessage(
      discordDecidedData(summary, {
        decision: result.decision,
        by: discordUser,
        at: (deps.now ?? (() => new Date()))(),
      }),
    );
  }
  if (result.status === "already-decided") return discordPrivateReply(alreadyText(result.decision));
  return discordPrivateReply(refusalText(result.status, "Discord"));
}

/** POST /api/chat/discord/<connection id>: the application's "Interactions Endpoint URL". */
export async function discordInteraction(
  request: Request,
  connectionId: string,
  deps: DiscordDeps,
): Promise<Response> {
  // Before anything is read or looked up: Discord sends JSON and nothing else.
  if (!isJsonType(request.headers.get("content-type"))) return plain(400, "Bad request");
  const auth = await authenticate(request, connectionId, "discord", discordVerifier, {
    store: deps.store,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!auth.ok) {
    console.warn(`chat: discord request refused: ${auth.reason}`);
    return rejection(auth);
  }
  const parsed = parseDiscord(auth.rawBody, request.headers.get("content-type"));
  if (parsed.kind === "malformed") return plain(400, "Bad request");
  if (parsed.kind === "ping") return json(DISCORD_PONG);
  if (parsed.kind === "ignore") return json(DISCORD_ACK);
  const result = await decideFromChat(
    { sql: deps.sql, queue: deps.queue },
    auth.connection,
    parsed.action,
  );
  return json(answer(deps, result, parsed.action.chatUserId, parsed.action.draftId));
}

/**
 * Post a proposal to the team's own Discord channel with its buttons (a webhook of the team's Discord
 * application). The address is checked again here, and the POST is core's.
 */
export async function sendDiscordApprovalRequest(
  webhookUrl: string,
  request: ApprovalRequest,
  send: (endpoint: string, body: unknown) => Promise<PostResult> = (e, b) =>
    postJson(e, b, { publicOnly: true }),
): Promise<PostResult> {
  const d = checkDiscordWebhook(webhookUrl);
  if (!d.ok) return { ok: false, error: d.error };
  return send(d.endpoint, discordApprovalMessage(request));
}
