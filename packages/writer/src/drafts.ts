/**
 * The other two kinds a writer may create, as interfaces only: their bodies are separate rows (X71 for a
 * Sanity draft document, X75 for a Gmail draft). Each creates a draft that a person still has to act on;
 * neither has a way to make it live. There is deliberately no interface for a live field write (X72 is
 * held to v1.1 by the owner's decision of 12 Nov 2026).
 */
import type { ApplyJob, TrailEntry } from "./types.js";

/** One kind's writer: validates the job's payload strictly, then creates one draft or refuses. */
export interface DraftWriter {
  readonly kind: string;
  apply(job: ApplyJob): Promise<TrailEntry>;
}

/** X71: one Sanity document under a `drafts.` id, through the Actions API with a dry run first. */
export interface SanityDraftWriter extends DraftWriter {
  readonly kind: "sanity_draft";
}

/** X75: one Gmail draft (the gmail.drafts.create scope only); recipients from the site's contacts. */
export interface EmailDraftWriter extends DraftWriter {
  readonly kind: "email";
}
