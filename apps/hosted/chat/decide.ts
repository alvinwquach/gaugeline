/**
 * A chat button press becomes the decision the web inbox records (X69). The deciding happens in the
 * database, in `private.chat_decide` (migration 0010), which the chat login (gaugeline_chat, a role that
 * is not `authenticated` and cannot become anyone) calls with only what the signed request said. The
 * function finds the member from a link THAT MEMBER CONFIRMED, and applies the inbox's own rules (the same
 * SQL functions inbox.ts calls: closed findings, the draft's own findings; the same triggers: payload shape
 * and hash, one decision per draft). So a chat login cannot record a decision in a name nobody confirmed,
 * and a compromised endpoint can do no more than a confirmed, allowed member's own press could.
 *
 * What this file does, in order:
 *   1. the signed request named this workspace (a payload for another workspace is refused);
 *   2. the database decides (see chat_decide: unknown or unconfirmed user, client viewer, another
 *      organisation's draft, already decided, expired, closed finding);
 *   3. an approval enqueues the apply job in the same transaction, from the row the database returns. The
 *      writer still checks everything itself (ADR-0010); nothing is applied here.
 * Approve never confirms a closed finding: that second, deliberate click stays in the inbox.
 */
import type postgres from "postgres";
import type { ApplyQueue } from "../inbox/inbox.js";
import { asChat, type ChatConnection } from "./store.js";

/**
 * ADR-0010 part 2 proposes 72 hours (uncited: the owner's proposal, not a vendor's number). The rule is
 * `interval '72 hours'` in chat_decide; this copy is for the words of a reply, and a test keeps the two equal.
 */
export const PROPOSAL_EXPIRY_MS = 72 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a verified request asks for, in no provider's words. Every field is untrusted text until checked. */
export interface ChatAction {
  chatUserId: string;
  /** The workspace the payload says it came from, or null when the provider does not say. */
  workspace: string | null;
  draftId: string;
  choice: "approve" | "decline";
}

export type ChatDecision =
  | { status: "recorded"; decision: "approved" | "declined"; decisionId: string; userId: string }
  | { status: "already-decided"; decision: string; decidedBy: string | null }
  | { status: "unknown-user" }
  | { status: "not-allowed" }
  | { status: "wrong-workspace" }
  | { status: "not-found" }
  | { status: "expired" }
  /** The inbox must be used: a finding the draft fixes has closed, or the payload no longer fits. */
  | { status: "open-inbox"; why: "closed-findings" | "invalid-payload" };

export interface ChatDecideDeps {
  /** The chat login: a member of gaugeline_chat only. */
  sql: postgres.Sql;
  queue: ApplyQueue;
}

/** The database refusing a payload's shape (23514 from 0005's triggers): the payload's problem, nothing recorded. */
function shapeRefusal(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return (
    code === "23514" &&
    typeof message === "string" &&
    message.startsWith("the payload does not match the ")
  );
}

export async function decideFromChat(
  deps: ChatDecideDeps,
  connection: ChatConnection,
  action: ChatAction,
): Promise<ChatDecision> {
  if (connection.workspaceRef !== null && action.workspace !== connection.workspaceRef)
    return { status: "wrong-workspace" };
  if (!UUID.test(action.draftId)) return { status: "not-found" };
  try {
    return await asChat(deps.sql, async (tx): Promise<ChatDecision> => {
      const [r] = await tx`select * from private.chat_decide(
        ${connection.id}, ${action.chatUserId}, ${action.draftId}, ${action.choice})`;
      switch (r?.r_status) {
        case "recorded":
          if (r.r_enqueue)
            await deps.queue.enqueueApply(tx, {
              orgId: r.r_org_id as string,
              draftId: action.draftId,
              decisionId: String(r.r_decision_id),
              kind: r.r_kind as string,
              payloadText: r.r_payload as string,
              payloadSha256: r.r_sha as string,
            });
          return {
            status: "recorded",
            decision: r.r_decision as "approved" | "declined",
            decisionId: String(r.r_decision_id),
            userId: r.r_user_id as string,
          };
        case "already-decided":
          return {
            status: "already-decided",
            decision: r.r_decision as string,
            decidedBy: (r.r_decided_by as string | null) ?? null,
          };
        case "unknown-user":
        case "not-allowed":
        case "not-found":
        case "expired":
          return { status: r.r_status };
        case "open-inbox":
          return { status: "open-inbox", why: "closed-findings" };
        case "invalid-payload":
          return { status: "open-inbox", why: "invalid-payload" };
        default:
          throw new Error("chat_decide returned nothing usable");
      }
    });
  } catch (error) {
    if (shapeRefusal(error)) return { status: "open-inbox", why: "invalid-payload" };
    throw error;
  }
}
