/**
 * Which pull request a run is for (ACTION-COMMENT part 2). Pure: the CLI reads the environment and the event
 * file and hands them over. A comment is posted only for a `pull_request` event, never `pull_request_target`
 * (which runs with a write token in the base repository's context), and only with a token.
 */
import type { CommentTarget } from "./send.js";

export type TargetResult =
  | { ok: true; target: CommentTarget }
  | { ok: false; reason: "not-a-pull-request" | "no-token" | "bad-repository" | "bad-event" };

/** owner/name as GitHub spells them (the sender checks them again before it builds an address). */
const REPOSITORY = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;

export function commentTargetFrom(input: {
  /** GITHUB_EVENT_NAME */
  eventName: string | undefined;
  /** GITHUB_REPOSITORY */
  repository: string | undefined;
  /** GITHUB_TOKEN */
  token: string | undefined;
  /** The parsed file GITHUB_EVENT_PATH names. */
  event: unknown;
}): TargetResult {
  if (input.eventName !== "pull_request") return { ok: false, reason: "not-a-pull-request" };
  if (input.token === undefined || input.token.trim() === "")
    return { ok: false, reason: "no-token" };
  const m = REPOSITORY.exec(input.repository ?? "");
  if (!m || /^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!))
    return { ok: false, reason: "bad-repository" };
  const pr =
    typeof input.event === "object" && input.event !== null && !Array.isArray(input.event)
      ? (input.event as { pull_request?: unknown }).pull_request
      : undefined;
  const number =
    typeof pr === "object" && pr !== null ? (pr as { number?: unknown }).number : undefined;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    return { ok: false, reason: "bad-event" };
  return { ok: true, target: { owner: m[1]!, repo: m[2]!, pullNumber: number } };
}
