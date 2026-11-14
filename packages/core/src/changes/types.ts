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

/**
 * A finding about the site, not about a page: a domain, a token, a hosting project, the certificate of
 * another host. `address` is what the check named it by (`domain:example.test`, `token:github`,
 * `vercel:project`, or `https://www.example.test/`), never a page path. Like a page finding it keeps
 * no evidence text, so no domain's registrar and no token value is stored.
 */
export interface RecordedSiteFinding {
  checkId: string;
  address: string;
  title: string;
}

export interface RunRecord {
  schema: typeof HISTORY_SCHEMA;
  id: string;
  takenAt: string;
  /** The pages this run read, by path. */
  pages: Record<string, PageRecord>;
  /** Findings on those pages only. */
  findings: RecordedFinding[];
  /** How many findings were on other pages: not compared, and said so. */
  offPage?: number;
  /** Site-wide findings (renewals and certificates) that were not on the checked page. Absent in older runs. */
  siteFindings?: RecordedSiteFinding[];
  /**
   * The renewal checks that ran in this run and could read what they needed, sorted. A site finding
   * missing from a run counts as gone only when its check is listed here; a run without --renewals,
   * an older run, or a check that could not read (a registry that did not answer) says nothing.
   */
  renewalChecks?: string[];
}

/** The only shape a run id has: it is also the file name, so it can never hold a path. */
export const RUN_ID = /^r-\d{8}T\d{6}Z$/;

const MAX_TEXT = 500;
const MAX_PAGES = 200;
const MAX_FINDINGS = 2000;
const MAX_LIST = 300;

const isText = (v: unknown, max = MAX_TEXT): v is string =>
  typeof v === "string" && v.length <= max;
const isList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_LIST && v.every((x) => isText(x, 1000));
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Is this parsed JSON a run this version wrote: right schema, a run id, a real time, and every page
 * and finding with the fields the diff reads, each bounded. A file that fails is skipped, never
 * trusted and never deleted.
 */
export function isRunRecord(v: unknown): v is RunRecord {
  if (!isObject(v) || v.schema !== HISTORY_SCHEMA) return false;
  if (typeof v.id !== "string" || !RUN_ID.test(v.id)) return false;
  if (typeof v.takenAt !== "string" || Number.isNaN(Date.parse(v.takenAt))) return false;
  if (!isObject(v.pages) || Object.keys(v.pages).length > MAX_PAGES) return false;
  for (const [path, p] of Object.entries(v.pages)) {
    // A page key is a site path: "constructor" or "toString" would otherwise hit the prototype.
    if (!isText(path) || !path.startsWith("/") || !isObject(p)) return false;
    if (!isText(p.mainHash, 64) || !isList(p.links) || !isList(p.types) || !isList(p.scripts))
      return false;
    for (const k of ["title", "canonical", "h1"])
      if (p[k] !== undefined && !isText(p[k], 1000)) return false;
  }
  if (!Array.isArray(v.findings) || v.findings.length > MAX_FINDINGS) return false;
  for (const f of v.findings)
    if (
      !isObject(f) ||
      !isText(f.checkId, 100) ||
      !isText(f.path) ||
      !f.path.startsWith("/") ||
      !isText(f.title)
    )
      return false;
  if (v.renewalChecks !== undefined) {
    if (!Array.isArray(v.renewalChecks) || v.renewalChecks.length > 50) return false;
    if (!v.renewalChecks.every((id) => isText(id, 100))) return false;
  }
  if (v.siteFindings !== undefined) {
    if (!Array.isArray(v.siteFindings) || v.siteFindings.length > MAX_FINDINGS) return false;
    for (const f of v.siteFindings)
      if (!isObject(f) || !isText(f.checkId, 100) || !isText(f.address) || !isText(f.title))
        return false;
  }
  return v.offPage === undefined || (Number.isSafeInteger(v.offPage) && (v.offPage as number) >= 0);
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
