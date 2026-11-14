/**
 * The approval row's checks (ADR-0010 part 3), shared by every kind's apply: the job is a claim, the
 * decisions log is the record. The writer reads the row itself and refuses on the first difference: the
 * row exists and is an approval, it is this job's draft, organisation, site and kind, the payload hashes to
 * the approved hash, nothing recorded after it withdraws it, and it is under 72 hours old.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Approval, Approvals, ApplyJob } from "./types.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** How long an approval stays good (ADR-0010 part 2: proposed 72 hours, uncited). */
export const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;
/** The outcomes the writer itself records after an approval; any other word that follows one is a withdrawal. */
const MAY_FOLLOW_AN_APPROVAL: ReadonlySet<string> = new Set([
  "dry_run",
  "apply_failed",
  "refused",
  "applied",
]);
/** How far ahead of the worker's clock a decision may be dated (clock skew between the database and the worker). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Two SHA-256 hex digests are equal, compared in constant time. Anything not lower-case hex is not equal. */
export function sameDigest(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface ApprovalContext {
  /** The organisation and site this worker serves. */
  target: { orgId: string; siteId: string };
  approvals: Approvals;
  now?: () => Date;
}

export type ApprovalCheck = { ok: true; approval: Approval } | { ok: false; reason: string };

/**
 * The approval row for this job, or the reason to refuse it. The reasons are the trail's: "approval",
 * "draft", "org", "site", "kind", "hash", "withdrawn", "expired".
 */
export async function checkApproval(job: ApplyJob, ctx: ApprovalContext): Promise<ApprovalCheck> {
  const { target } = ctx;
  const no = (reason: string): ApprovalCheck => ({ ok: false, reason });
  // The approval row, read here, is the authority; the job only says which one to read.
  let approval: Approval | null;
  try {
    approval = await ctx.approvals.find(job.decisionId);
  } catch {
    approval = null;
  }
  if (!approval || (approval.decision !== "approved" && approval.decision !== "edited")) {
    return no("approval");
  }
  if (approval.decisionId !== job.decisionId || approval.draftId !== job.draftId)
    return no("draft");
  if (approval.orgId !== job.orgId || job.orgId !== target.orgId) return no("org");
  if (approval.siteId !== job.siteId || job.siteId !== target.siteId) return no("site");
  if (approval.kind !== job.kind) return no("kind");
  const computed = createHash("sha256").update(job.payloadText, "utf8").digest("hex");
  if (
    !sameDigest(computed, approval.payloadSha256) ||
    !sameDigest(job.payloadSha256, approval.payloadSha256)
  ) {
    return no("hash");
  }
  // Only the outcomes the writer itself records may follow an approval. Anything else ("declined",
  // "withdrawn", "Withdrawn", a word this version does not know) ends it.
  if (approval.later.some((d) => !MAY_FOLLOW_AN_APPROVAL.has(d))) return no("withdrawn");
  const decidedAt = approval.decidedAt.getTime();
  const now = (ctx.now ?? (() => new Date()))().getTime();
  if (!(decidedAt <= now + CLOCK_SKEW_MS)) return no("approval");
  const expires = Math.min(
    decidedAt + APPROVAL_TTL_MS,
    approval.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  if (!(now < expires)) return no("expired");
  return { ok: true, approval };
}
