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
  reason?: string;
}

/** What /api/runs/:id/events sends, each with the id the server gave it. */
export type StreamEvent =
  | { kind: "step"; id: number; text: string }
  | { kind: "done"; id: number; counts: Counts }
  | { kind: "failed"; id: number; reason: string };

/** What watchRun reports: the stream's events, and the run as the server has it after a drop. */
export type WatchEvent = StreamEvent | { kind: "sync"; run: RunDetail };
