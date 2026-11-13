/**
 * Slack's side of approving in chat (X69, part 2): the interactive request a button press sends, and the
 * messages sent back. Everything before the body is parsed is chat/receive.ts (size, connection, secret,
 * signature, replay); everything that decides is chat/decide.ts. This file only reads Slack's payload shape
 * and answers.
 *
 * The payload is signed, so it came from the team's own Slack app; it is still untrusted TEXT: only an id
 * of a known shape is taken from each field, and nothing in it is shown back except as escaped text. The
 * answer goes to Slack's `response_url` through core's notify POST module (ADR-0005): a reply to the
 * person's own workspace, never to a checked site, and never anywhere but hooks.slack.com/actions/...
 * (checkSlackResponseUrl). No new request site is added here.
 */
import {
  APPROVE_ACTION,
  checkDestination,
  checkSlackResponseUrl,
  DECLINE_ACTION,
  postJson,
  slackApprovalMessage,
  slackDecidedMessage,
  slackPrivateReply,
  type ApprovalRequest,
  type SlackReply,
} from "@gaugeline/core";
import type postgres from "postgres";
import type { ApplyQueue } from "../inbox/inbox.js";
import { decideFromChat, type ChatAction, type ChatDecision } from "./decide.js";
import { authenticate, rejection } from "./receive.js";
import { alreadyText, refusalText, titleOf } from "./replies.js";
import type { ChatStore } from "./store.js";
import { slackVerifier } from "./verify.js";

type PostResult = Awaited<ReturnType<typeof postJson>>;

export interface SlackDeps {
  /** A login that may `set local role authenticated` (the chat endpoint's own). */
  sql: postgres.Sql;
  store: ChatStore;
  queue: ApplyQueue;
  now?: () => Date;
  /** Answers a button press at its response address. Production: core's postJson, public addresses only. */
  reply?: (endpoint: string, body: SlackReply) => Promise<PostResult>;
  /** The app's public address, for "Edit first". */
  appUrl?: string;
}

/** What a verified interaction asks for. `ignore` is a press that asks for nothing (a link button). */
export type Interaction =
  | { kind: "ignore" }
  | { kind: "malformed" }
  | { kind: "decision"; action: ChatAction; responseUrl: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/;
const SLACK_TEAM = /^[A-Z][A-Z0-9]{2,30}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Exactly the form type Slack sends, with or without parameters such as a charset; nothing that merely starts with it. */
function isFormType(contentType: string | null): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

/**
 * Slack sends an interaction as a form: one field, `payload`, holding JSON (a `block_actions` object with
 * `user`, `team`, `actions` and a `response_url`; bolt-js `BlockAction`). Called only on a body whose
 * signature has been checked.
 */
export function parseInteraction(rawBody: Buffer, contentType: string | null): Interaction {
  if (!isFormType(contentType)) return { kind: "malformed" };
  const fields = new URLSearchParams(rawBody.toString("utf8")).getAll("payload");
  if (fields.length !== 1) return { kind: "malformed" };
  let p: unknown;
  try {
    p = JSON.parse(fields[0]!);
  } catch {
    return { kind: "malformed" };
  }
  if (!isRecord(p)) return { kind: "malformed" };
  // Other interactions (a view submission, a shortcut) ask for nothing here.
  if (p.type !== "block_actions") return { kind: "ignore" };
  if (!Array.isArray(p.actions) || p.actions.length !== 1 || !isRecord(p.actions[0]))
    return { kind: "malformed" };
  const a = p.actions[0];
  if (a.action_id !== APPROVE_ACTION && a.action_id !== DECLINE_ACTION) return { kind: "ignore" };
  const user = isRecord(p.user) ? p.user : {};
  const team = isRecord(p.team) ? p.team : {};
  const teamId = typeof team.id === "string" ? team.id : user.team_id;
  if (typeof user.id !== "string" || !SLACK_USER.test(user.id)) return { kind: "malformed" };
  if (typeof a.value !== "string" || !UUID.test(a.value)) return { kind: "malformed" };
  return {
    kind: "decision",
    responseUrl: p.response_url,
    action: {
      chatUserId: user.id,
      workspace: typeof teamId === "string" && SLACK_TEAM.test(teamId) ? teamId : null,
      draftId: a.value.toLowerCase(),
      choice: a.action_id === APPROVE_ACTION ? "approve" : "decline",
    },
  };
}

/** What the reply says was decided: the draft's kind and one-line title, from the row the database returned. */
function summaryOf(
  kind: string,
  payloadText: string,
  draftId: string,
  appUrl?: string,
): ApprovalRequest {
  return {
    kind,
    title: titleOf(payloadText),
    draftId,
    ...(appUrl ? { inboxUrl: `${appUrl.replace(/\/+$/, "")}/inbox/${draftId}` } : {}),
  };
}

/** What to send back for a result: the clicked message replaced, or a private line for the clicker. */
function answer(
  deps: SlackDeps,
  result: ChatDecision,
  slackUser: string,
  draftId: string,
): SlackReply {
  if (result.status === "recorded")
    return slackDecidedMessage(summaryOf(result.kind, result.payloadText, draftId, deps.appUrl), {
      decision: result.decision,
      by: slackUser,
      at: (deps.now ?? (() => new Date()))(),
    });
  if (result.status === "already-decided") return slackPrivateReply(alreadyText(result.decision));
  return slackPrivateReply(refusalText(result.status, "Slack"));
}

/** Slack wants an answer to the request itself within three seconds; the reply to the person follows it. */
const REPLY_TIMEOUT_MS = 2000;

const empty = () => new Response("", { status: 200, headers: { "cache-control": "no-store" } });
const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/** POST /api/chat/slack/<connection id>: Slack's interactivity request address. */
export async function slackInteraction(
  request: Request,
  connectionId: string,
  deps: SlackDeps,
): Promise<Response> {
  // Before anything is read or looked up: Slack sends a form and nothing else.
  if (!isFormType(request.headers.get("content-type"))) return plain(400, "Bad request");
  const auth = await authenticate(request, connectionId, "slack", slackVerifier, {
    store: deps.store,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!auth.ok) {
    console.warn(`chat: slack request refused: ${auth.reason}`);
    return rejection(auth);
  }
  const parsed = parseInteraction(auth.rawBody, request.headers.get("content-type"));
  if (parsed.kind === "malformed") return plain(400, "Bad request");
  if (parsed.kind === "ignore") return empty();
  const result = await decideFromChat(
    { sql: deps.sql, queue: deps.queue },
    auth.connection,
    parsed.action,
  );
  const target = checkSlackResponseUrl(parsed.responseUrl);
  if (target.ok) {
    const body = answer(deps, result, parsed.action.chatUserId, parsed.action.draftId);
    const send =
      deps.reply ??
      ((endpoint, b) => postJson(endpoint, b, { publicOnly: true, timeoutMs: REPLY_TIMEOUT_MS }));
    // The decision is already recorded: a reply that fails is logged by host only and never undoes it.
    const sent = await send(target.endpoint, body).catch((): PostResult => ({
      ok: false,
      error: "the reply could not be sent",
    }));
    if (!sent.ok) console.warn(`chat: slack reply to ${target.host} failed`);
  }
  return empty();
}

/**
 * Post a proposal to the team's own Slack channel with its buttons (an incoming webhook of the team's
 * Slack app, with interactivity turned on). The address is checked again here, and the POST is core's.
 */
export async function sendApprovalRequest(
  webhookUrl: string,
  request: ApprovalRequest,
  send: (endpoint: string, body: unknown) => Promise<PostResult> = (e, b) =>
    postJson(e, b, { publicOnly: true }),
): Promise<PostResult> {
  const d = checkDestination("slack", webhookUrl);
  if (!d.ok) return { ok: false, error: d.error };
  return send(d.endpoint, slackApprovalMessage(request));
}
