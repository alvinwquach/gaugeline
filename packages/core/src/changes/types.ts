/** Bump when a stored run changes shape; an older or newer file is left alone and not compared. */
export const HISTORY_SCHEMA = 1 as const;

/**
 * What one run kept about one page: a few fields and hashes, never the page. Public text only (the
 * title and the first h1, each cut short); the main content is a hash, the links are paths.
 */
export interface PageRecord {
  title?: string;
  canonical?: string;
  h1?: string;
  /** Truncated SHA-256 of the main content's text (header, footer, nav and asides left out). */
  mainHash: string;
  /** Links in the main content, as site paths or addresses, sorted, at most LINKS_MAX. */
  links: string[];
  /** The @type values in the page's JSON-LD, sorted. */
  types: string[];
  /** Script addresses served (query strings dropped), sorted. */
  scripts: string[];
}

export const LINKS_MAX = 200;

/** A finding as a run remembers it: which check, on which path, and its title. No evidence text. */
export interface RecordedFinding {
  checkId: string;
  path: string;
  title: string;
}

export interface RunRecord {
  schema: typeof HISTORY_SCHEMA;
  id: string;
  takenAt: string;
  /** The pages this run read, by path. */
  pages: Record<string, PageRecord>;
  findings: RecordedFinding[];
}

export type FieldName =
  "title" | "canonical" | "h1" | "content" | "links" | "structured data" | "scripts";

export interface FieldChange {
  field: FieldName;
  /** One plain line: what changed, with the old and new value for the short fields. */
  detail: string;
}

/** One revision of a document in a content system. `editor` is the name as the system shows it, never inferred. */
export interface Revision {
  documentId: string;
  /** ISO 8601, UTC. */
  time: string;
  editor?: string;
}

/** One deployment from a host. `commit` is the git commit the host says it built. */
export interface Deploy {
  id: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  commit?: string;
}

/** What a source gave, or why it could not: a source that could not be read never counts as "nothing happened". */
export type SourceRead<T> =
  | { state: "read"; items: T[] }
  | { state: "not-configured" }
  | { state: "could-not-check"; reason: string };

export type ChangeLabel = "content-edit" | "code-deploy" | "both" | "unknown";
