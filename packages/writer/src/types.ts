/** An apply job as the hosted inbox enqueues it (G37): which decision approved which payload. */
export interface ApplyJob {
  orgId: string;
  /** The site the draft belongs to. The writer refuses a job for any site but its configured target's. */
  siteId: string;
  draftId: string;
  decisionId: string;
  kind: string;
  /** The approved payload exactly as the database holds it (jsonb text); untrusted until checked. */
  payloadText: string;
  /** The approval row's SHA-256 of payloadText (computed by the database, G37). */
  payloadSha256: string;
}

/**
 * The approval row as the worker reads it from the decisions log over its own connection (ADR-0010
 * parts 2 and 3). The job is a claim; this is the record. The writer compares every field below with the
 * job and with its configured target, and refuses on the first difference.
 */
export interface Approval {
  decisionId: string;
  draftId: string;
  orgId: string;
  /** The draft's site. */
  siteId: string;
  kind: string;
  /** "approved" or "edited" are approvals; anything else is not one. */
  decision: string;
  /** The SHA-256 of the exact payload the person saw, computed by the database. */
  payloadSha256: string;
  decidedAt: Date;
  /** An earlier expiry than the writer's own 72 hours, if the worker's record has one. Never later. */
  expiresAt?: Date;
  /** The decisions appended for this draft after this one ("declined", "withdrawn", "dry_run" ...). */
  later: readonly string[];
}

/** Where the writer finds the approval row a job claims. The worker implements it over its own connection. */
export interface Approvals {
  /** The approval row for `decisionId`, or null when there is none. */
  find(decisionId: string): Promise<Approval | null>;
}

/** What the worker appends to the decisions trail after an apply (ADR-0010 part 4). */
export type Outcome = "dry_run" | "applied" | "apply_failed" | "refused";

/**
 * One trail entry. It refers to things, it never copies them: the pull request's address, the HTTP
 * status, the endpoints a dry run would call. Never a token, a response body or the payload.
 */
export interface TrailEntry {
  draftId: string;
  decisionId: string;
  outcome: Outcome;
  /** The pull request's address, or the mailbox draft's id (Gmail's `Draft.id`), when one exists. */
  ref?: string;
  /** The provider's HTTP status, when a request failed. */
  status?: number;
  /**
   * Why nothing was written: "kind", "target", "kill switch", "organisation paused", "approval",
   * "draft", "org", "site", "hash", "withdrawn", "expired", "payload", "path", "registry"; for a mailbox
   * draft also "recipient" (every contact bounced), "duplicate" (one approval, one draft) and
   * "disconnected" (no access token stored). With an `apply_failed` status, "reconnect" means Gmail no
   * longer accepts the token (401 or 403): the draft stays in the inbox, with a note to reconnect.
   */
  reason?: string;
  /** A dry run's plan: the registered endpoint and the path it would call. */
  planned?: { endpoint: string; path: string }[];
}

/** Where outcomes go: the hosted decisions trail, through the worker's connection. */
export interface Trail {
  record(entry: TrailEntry): Promise<void>;
}
