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
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** One request the check sent (or refused to send), in the order the server lists them. */
export interface RequestRow {
  url: string;
  kind: RequestKind;
  method: "GET" | "HEAD";
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

/** What the server sends beside the result for the Pages checked and Search data views. */
export interface Checked {
  requests?: RequestRow[];
  page: PageData;
}

export type RunStatus = "running" | "done" | "failed";

/** One row of GET /api/runs. */
export interface RunSummary {
  id: string;
  url: string;
  state: RunStatus;
  startedAt: string;
  counts?: Counts;
}

/** GET /api/runs/:id: the summary, and when finished the result or the reason. */
export interface RunDetail extends RunSummary {
  result?: Result;
  checked?: Checked;
  reason?: string;
}

/** What /api/runs/:id/events sends, each with the id the server gave it. */
export type StreamEvent =
  | { kind: "step"; id: number; text: string }
  | { kind: "done"; id: number; counts: Counts }
  | { kind: "failed"; id: number; reason: string };

/** What watchRun reports: the stream's events, and the run as the server has it after a drop. */
export type WatchEvent = StreamEvent | { kind: "sync"; run: RunDetail };
