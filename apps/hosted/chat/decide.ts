/**
 * A chat button press becomes the same decision the web inbox records (X69). It reuses `decide()` from
 * inbox.ts, so the row, the one-decision-per-draft rule, the payload check, the closed-finding check and
 * the apply job are the inbox's own: a chat click can do exactly what the same person could do there, and
 * the writer still applies nothing until its own checks pass (ADR-0010).
 *
 * What this adds, in order, each one refusing before anything is written:
 *   1. the signed request named this workspace (a payload for another workspace is refused);
 *   2. the chat user is linked to a member, and the member is staff (owner, admin or member): a client
 *      viewer, a removed member and a stranger cannot decide;
 *   3. the draft is in THIS connection's organisation, as the member sees it under row-level security: a
 *      person who belongs to two organisations cannot decide one organisation's draft through the other's
 *      chat connection;
 *   4. a draft already decided answers with who decided first (a double press, or the inbox got there);
 *   5. an approval of a proposal older than PROPOSAL_EXPIRY_MS is refused (a decline is not).
 * Approve never confirms a closed finding: that second, deliberate click stays in the inbox.
 */
import { asPerson, decide, type ApplyQueue, type Choice } from "../inbox/inbox.js";
import type postgres from "postgres";
import type { ChatConnection, ChatStore } from "./store.js";

/** ADR-0010 part 2 proposes 72 hours (uncited: the owner's proposal, not a vendor's number). */
export const PROPOSAL_EXPIRY_MS = 72 * 60 * 60 * 1000;
const STAFF = new Set(["owner", "admin", "member"]);
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
  /** A login that may `set local role authenticated` (inbox.ts asPerson). */
  sql: postgres.Sql;
  store: ChatStore;
  queue: ApplyQueue;
  now?: () => Date;
}

export async function decideFromChat(
  deps: ChatDecideDeps,
  connection: ChatConnection,
  action: ChatAction,
): Promise<ChatDecision> {
  if (connection.workspaceRef !== null && action.workspace !== connection.workspaceRef)
    return { status: "wrong-workspace" };
  const member = await deps.store.member(connection.id, action.chatUserId);
  if (!member) return { status: "unknown-user" };
  if (!STAFF.has(member.role)) return { status: "not-allowed" };
  if (!UUID.test(action.draftId)) return { status: "not-found" };
  const who = { userId: member.userId };

  const facts = await asPerson(deps.sql, who, async (tx) => {
    const [row] = await tx`
      select d.org_id, d.created_at, s.decision, s.decided_by
      from public.drafts d join public.draft_state s on s.draft_id = d.id where d.id = ${action.draftId}`;
    return row;
  });
  if (!facts || facts.org_id !== connection.orgId) return { status: "not-found" };
  if (facts.decision !== "pending")
    return {
      status: "already-decided",
      decision: facts.decision as string,
      decidedBy: (facts.decided_by as string | null) ?? null,
    };
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (
    action.choice === "approve" &&
    now - (facts.created_at as Date).getTime() > PROPOSAL_EXPIRY_MS
  )
    return { status: "expired" };

  const choice: Choice = action.choice === "approve" ? { kind: "approve" } : { kind: "decline" };
  const result = await decide(deps.sql, who, action.draftId, choice, deps.queue);
  switch (result.status) {
    case "recorded":
      return {
        status: "recorded",
        decision: result.decision as "approved" | "declined",
        decisionId: result.decisionId,
        userId: member.userId,
      };
    case "already-decided":
      return { status: "already-decided", decision: result.decision, decidedBy: result.decidedBy };
    case "confirm-closed-findings":
      return { status: "open-inbox", why: "closed-findings" };
    case "invalid-payload":
      return { status: "open-inbox", why: "invalid-payload" };
    case "not-found":
      return { status: "not-found" };
  }
}
