/**
 * What a person is told, privately, when a chat press records nothing. One set of words for every provider;
 * only the name of the account differs. Nothing here repeats text the person or the draft supplied.
 */
import { PROPOSAL_EXPIRY_MS, type ChatDecision } from "./decide.js";

export type Refusal = Exclude<ChatDecision["status"], "recorded" | "already-decided">;

export function refusalText(status: Refusal, account: string): string {
  switch (status) {
    case "unknown-user":
      return `Your ${account} account is not linked to a Gaugeline member, so nothing was recorded. Ask an owner or admin to link it.`;
    case "not-allowed":
    case "wrong-workspace":
      return "You are not allowed to decide proposals in Gaugeline. Nothing was recorded.";
    case "not-found":
      return "That proposal is not available any more. Nothing was recorded.";
    case "expired":
      return `That proposal is more than ${PROPOSAL_EXPIRY_MS / 3_600_000} hours old and can no longer be approved here. Open it in Gaugeline to review it.`;
    case "open-inbox":
      return "A finding this proposal fixes has closed, or the proposal changed. Open it in Gaugeline to decide. Nothing was recorded.";
  }
}

export const alreadyText = (decision: string) =>
  `That proposal was already ${decision === "declined" ? "declined" : "approved"}. Nothing was changed.`;

/** What the person sees for a recorded decision's title: the draft's one-line title, from the database's row. */
export function titleOf(payloadText: string): string {
  try {
    const p = JSON.parse(payloadText) as Record<string, unknown>;
    const found = [p.title, p.subject, p.documentId].find(
      (v): v is string => typeof v === "string",
    );
    if (found) return found;
  } catch {
    // The database holds only objects that fit their kind; a payload that does not parse is not shown.
  }
  return "A proposed change";
}
