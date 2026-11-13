/**
 * The other two kinds a writer may create. X71's Sanity draft document is `sanityDraftWriter`; X75's Gmail
 * draft is `emailDraftWriter`. Each creates a draft that a person still has to act on; neither has a way
 * to make it live or to send it. There is deliberately no interface for a live field write (X72 is held
 * to v1.1 by the owner's decision of 12 Nov 2026).
 */
import { applyEmailDraft, type MailDeps } from "./gmail/apply.js";
import { applySanityDraft, type SanityApplyDeps } from "./sanity/apply.js";
import type { ApplyJob, TrailEntry } from "./types.js";

/** One kind's writer: validates the job's payload strictly, then creates one draft or refuses. */
export interface DraftWriter {
  readonly kind: string;
  apply(job: ApplyJob): Promise<TrailEntry>;
}

/** X71: one Sanity document under a `drafts.` id, created once and never overwritten (sanity/apply.ts). */
export interface SanityDraftWriter extends DraftWriter {
  readonly kind: "sanity_draft";
}

/** The Sanity kind's writer over one site's project (sanity/apply.ts). It creates a draft and has no way to make it live. */
export function sanityDraftWriter(deps: SanityApplyDeps): SanityDraftWriter {
  return { kind: "sanity_draft", apply: (job) => applySanityDraft(job, deps) };
}

/** X75: one Gmail draft (the gmail.drafts.create scope only); recipients from the site's contacts. */
export interface EmailDraftWriter extends DraftWriter {
  readonly kind: "email";
}

/** The email kind's writer over one site's mailbox (gmail/apply.ts). It creates a draft and has no way to send it. */
export function emailDraftWriter(deps: MailDeps): EmailDraftWriter {
  return { kind: "email", apply: (job) => applyEmailDraft(job, deps) };
}
