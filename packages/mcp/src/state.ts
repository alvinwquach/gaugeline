import {
  Semaphore,
  createFetcher,
  LIMITS,
  type CheckRegistry,
  type Fetcher,
  type FetcherOptions,
  type Finding,
  type Result,
} from "@gaugeline/core";

/** What the server needs from whoever starts it. None of it can be changed by a tool call. */
export interface ServerOptions {
  /** Started with --allow-private: the address the caller named may be private or loopback. Default false. */
  allowPrivate?: boolean;
  /** The only folder plan_check may read a plan file from. Default: the working directory. */
  root?: string;
  /** Fetcher settings for tests (a `hosts` map, a resolver). Never exposed to a tool. */
  fetcher?: Partial<FetcherOptions>;
  now?: () => Date;
  /** The most findings one result carries (default 40); the rest are counted and kept in the run. */
  maxFindings?: number;
  /** Shared by every server made from the same options (the HTTP transport makes one per request). */
  state?: ServerState;
}

/** One finished run kept for this session so explain_finding, compare_runs and draft_fix can refer to it. */
export interface StoredRun {
  id: string;
  kind: "site" | "plan";
  url: string;
  startedAt: string;
  findings: Finding[];
  passed: string[];
  failed: string[];
  couldNotCheck: Result["couldNotCheck"];
  registry: CheckRegistry;
}

/** How many runs one server remembers. A Map keeps insertion order, so the oldest is the first key. */
export const MAX_RUNS = 20;

export interface ServerState {
  runs: Map<string, StoredRun>;
  nextRun: number;
  /** One in-flight limit shared by every call: fifty callers still make at most LIMITS.concurrency requests at once. */
  gate: Semaphore;
}

export function createState(): ServerState {
  return { runs: new Map(), nextRun: 1, gate: new Semaphore(LIMITS.concurrency) };
}

export function remember(state: ServerState, run: Omit<StoredRun, "id">): StoredRun {
  const id = `run-${state.nextRun++}`;
  const stored = { id, ...run };
  state.runs.set(id, stored);
  while (state.runs.size > MAX_RUNS) {
    const oldest = state.runs.keys().next().value;
    if (oldest === undefined) break;
    state.runs.delete(oldest);
  }
  return stored;
}

export interface ToolContext {
  options: ServerOptions;
  state: ServerState;
  now(): Date;
  maxFindings: number;
  /** The one way a tool reaches a site: the core fetcher (GET and HEAD only, private addresses refused). */
  fetcherFor(target: string): Fetcher;
}

export function contextFor(options: ServerOptions, state: ServerState): ToolContext {
  return {
    options,
    state,
    now: options.now ?? (() => new Date()),
    maxFindings: options.maxFindings ?? 40,
    fetcherFor: (target) =>
      createFetcher({
        ...options.fetcher,
        semaphore: state.gate,
        // The same rule as the CLI's --allow-private: it trusts the address the caller named, not where
        // its pages point, so a redirect or a link to another non-public address is still refused.
        ...(options.allowPrivate === true ? { allowPrivate: true, target } : {}),
      }),
  };
}

/** A problem the caller can fix: returned as a tool error with this text, not as a crash. */
export class ToolError extends Error {}
