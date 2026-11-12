/** An apply job as the hosted inbox enqueues it (G37): which decision approved which payload. */
export interface ApplyJob {
  orgId: string;
  draftId: string;
  decisionId: string;
  kind: string;
  /** The approved payload exactly as the database holds it (jsonb text); untrusted until checked. */
  payloadText: string;
  /** The approval row's SHA-256 of payloadText (computed by the database, G37). */
  payloadSha256: string;
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
  /** The pull request's address, when one exists. */
  ref?: string;
  /** GitHub's HTTP status, when a request failed. */
  status?: number;
  /** Why nothing was written: "hash", "payload", "kind", "kill switch", "organisation paused". */
  reason?: string;
  /** A dry run's plan: the registered endpoint and the path it would call. */
  planned?: { endpoint: string; path: string }[];
}

/** Where outcomes go: the hosted decisions trail, through the worker's connection. */
export interface Trail {
  record(entry: TrailEntry): Promise<void>;
}
