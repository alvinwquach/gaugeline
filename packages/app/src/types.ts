/** What the server's routes return. The result is the versioned JSON from `gaugeline --json`. */

export const LEVELS = ["high", "medium", "low"] as const;
export type Level = (typeof LEVELS)[number];

/** The three levels in the words the report and the docs use. */
export const LEVEL_LABEL: Readonly<Record<Level, string>> = {
  high: "Fix this first",
  medium: "Fix soon",
  low: "Worth knowing",
};

export type Counts = Record<Level, number>;

export interface Finding {
  checkId: string;
  severity: Level;
  title: string;
  evidence: string;
  url: string;
}

export interface CouldNotCheck {
  id: string;
  reason: string;
  url: string;
}

export interface Sample {
  seen: number;
  taken: number;
  limit: number;
}

/** Result schema 2: the only version this app reads. */
export interface Result {
  schema: 2;
  url: string;
  startedAt: string;
  findings: Finding[];
  passed: string[];
  failed: string[];
  couldNotCheck: CouldNotCheck[];
  sampled: Record<string, Sample>;
}

/** What an address was requested as, in the order the Pages checked view lists them. */
export const REQUEST_KINDS = [
  "page",
  "link",
  "image",
  "sitemap",
  "feed",
  "script",
  "extra-page",
  "other",
  "query",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** One request the check sent (or refused to send), in the order the server lists them. */
export interface RequestRow {
  url: string;
  kind: RequestKind;
  method: "GET" | "HEAD" | "POST";
  /** On a read-only query (kind "query", ADR-0006): the id of the allowlist entry. Never the body. */
  allow?: string;
  /** null when nothing answered. */
  status: number | null;
  error?: "timeout" | "private-address-refused" | "no-answer";
  ms: number;
  /** Where a 3xx pointed, as an absolute address. */
  location?: string;
}

/** One structured data script tag: its value, or the text that did not parse and the parser's message. */
export type StructuredBlock =
  { ok: true; value: unknown } | { ok: false; raw: string; error: string };

/** What the checked page declares, as read without JavaScript. */
export interface PageData {
  url: string;
  /** Absent: no title element. "": an empty one. */
  title?: string;
  /** Absent: no canonical link. "": a link with no address. */
  canonical?: string;
  words: number;
  firstWords: string;
  blocks: StructuredBlock[];
}

/** One Sanity dataset the page's images name. A public one carries its type names and document count, never a document. */
export interface DatasetView {
  projectId: string;
  dataset: string;
  state: "public" | "private" | "unknown";
  count?: number;
  types?: string[];
}

/** One same-site JavaScript file the scan asked for. */
export interface ScriptView {
  url: string;
  /** The address as a finding names it: a path on the page's own site, else the full address. */
  where: string;
  status: number | null;
  truncated: boolean;
}

/** What the key, dataset and preview checks read, for the Leaks & access view. */
export interface LeaksView {
  /** Absent: no check read the datasets. Empty: the page names no Sanity dataset. */
  datasets?: DatasetView[];
  /** Absent: no check scanned JavaScript. */
  scripts?: ScriptView[];
  previews: string[];
}

/** What the server sends beside the result for the Pages checked, Search data and Leaks & access views. */
export interface Checked {
  requests?: RequestRow[];
  page: PageData;
  leaks?: LeaksView;
}

/** One landing page of an ads export: how many ads send people there, and what they cost. */
export interface AdsDestination {
  url: string;
  ads: number;
  /** An integer in minor units of the currency (cents), never a float. */
  spend: number;
}

/**
 * The spend of one currency. An export that mixes currencies has one of these for each, and the
 * app never adds across them. `currency` is an ISO 4217 code, or null when the export names none.
 */
export interface AdsCurrency {
  currency: string | null;
  destinations: AdsDestination[];
}

/** What the server sends beside an ads run's result, in the API's `checked` field. */
export interface AdsData {
  currencies: AdsCurrency[];
}

export type RunStatus = "running" | "done" | "failed";

/** What a run is of: one page checked from an address, or an ads export read from a file. */
export type RunKind = "page" | "ads";

/** One row of GET /api/runs. */
export interface RunSummary {
  id: string;
  url: string;
  /** Absent in an answer from a server that does not say: a page run. */
  kind?: RunKind;
  state: RunStatus;
  startedAt: string;
  counts?: Counts;
}

/** GET /api/runs/:id: the summary, and when finished the result or the reason. */
export interface RunDetail extends RunSummary {
  result?: Result;
  checked?: Checked;
  /** An ads run: the destinations and their spend. */
  ads?: AdsData;
  /** An ads run: there is a report to download. */
  hasReport?: boolean;
  reason?: string;
}

/** What /api/runs/:id/events sends, each with the id the server gave it. */
export type StreamEvent =
  | { kind: "step"; id: number; text: string }
  | { kind: "done"; id: number; counts: Counts }
  | { kind: "failed"; id: number; reason: string };

/** What watchRun reports: the stream's events, and the run as the server has it after a drop. */
export type WatchEvent = StreamEvent | { kind: "sync"; run: RunDetail };
