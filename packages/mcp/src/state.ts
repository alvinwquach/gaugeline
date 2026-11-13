import {
  type AgentDenyLog,
  type AgentPolicy,
  Semaphore,
  createFetcher,
  LIMITS,
  type CheckRegistry,
  type Fetcher,
  type FetcherOptions,
  type Finding,
  type Result,
} from "@gaugeline/core";
import {
  NEVER_MESSAGE,
  checkTarget,
  guardedFetcher,
  guardedResolver,
  hostPortOf,
  normaliseHostPort,
} from "./net-guard.js";
import { ToolError } from "./errors.js";

/** What the server needs from whoever starts it. None of it can be changed by a tool call. */
export const DEFAULT_CALL_MS = 120_000;

export interface ServerOptions {
  /**
   * Started with --allow-private: an address a model names may be loopback or private (never link-local or
   * metadata, which are always refused). Default false.
   */
  allowPrivate?: boolean;
  /** --allow-private-host: the only private host:port pairs a model may reach. When set, no other private address is reachable. */
  allowPrivateHosts?: string[];
  /** The only folder plan_check may read plan files from. There is no default: without it plan_check is not offered. */
  root?: string;
  /** --plan-base: the origins plan_check may check a plan against. Without at least one, plan_check is not offered. */
  planBases?: string[];
  /**
   * --allow-probing: the operator's switch for probing checks (CLAUDE.md rule 14: non-public paths such as
   * /.env or a download route, asked for with no login). Alone it enables nothing: a call is probed only if
   * its origin is also in `probingOrigins`. A tool call has no argument that can turn it on.
   */
  allowProbing?: boolean;
  /** --probing-origin: the origins the operator says may be probed (repeat for more). Needs `allowProbing`. */
  probingOrigins?: string[];
  /** The most calls that make requests and may be running or waiting at once (default 16); beyond it a call is refused. */
  maxActiveCalls?: number;
  /** The longest one tool call may run, in milliseconds (default 120000): checked before every hop, and the call is answered at the limit. */
  maxCallMs?: number;
  /** Fetcher settings for tests (a `hosts` map, a resolver). Never exposed to a tool. */
  fetcher?: Partial<FetcherOptions>;
  now?: () => Date;
  /** The most findings one result carries (default 40); the rest are counted and kept in the run. */
  maxFindings?: number;
  /** --allow-tool: the only tools a call may use (repeat). Absent: every tool, as before. */
  allowedTools?: string[];
  /** --calls-per-minute: calls allowed per minute, every tool together (default 120; 0 stops every call). */
  callsPerMinute?: number;
  /** --cost-ceiling-micros: cost allowed per UTC day in micro-units (default 1000000). Every tool declares 0 today. */
  costCeilingMicros?: number;
  /** Read at every call for the global kill switch GAUGELINE_AGENTS_OFF (default: the live process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * The cost a tool call declares, in micro-units (default 0 for every tool: none calls a model). For tests,
   * and for a later tool that does; never set from a call.
   */
  toolCostMicros?: (tool: string) => number;
  /** Where each deny is logged (default: one line on stderr). Gets the time, the tool and the reason only. */
  onDeny?: (entry: AgentDenyLog) => void;
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
  /** Site runs: the page as served (capped), so draft_fix can build a patch against it. */
  page?: { url: string; html: string };
}

/** How many runs one server remembers. A Map keeps insertion order, so the oldest is the first key. */
export const MAX_RUNS = 20;

export interface ServerState {
  runs: Map<string, StoredRun>;
  nextRun: number;
  /** One in-flight limit shared by every call: fifty callers still make at most LIMITS.concurrency requests at once. */
  gate: Semaphore;
  /** Calls that make requests and have not finished. */
  active: number;
  /** The agent policy, made by the first server built on this state, so every server shares one budget. */
  policy?: AgentPolicy;
}

export function createState(): ServerState {
  return { runs: new Map(), nextRun: 1, gate: new Semaphore(LIMITS.concurrency), active: 0 };
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
  fetcherFor(target: string, onlyOrigin?: string): Fetcher;
}

/**
 * Whether probing checks may run for a call on this address. Only the operator decides: the flag AND the
 * address's origin in the operator's list. Nothing a tool call or a page says is read here.
 */
export function probingAllowedFor(options: ServerOptions, url: string): boolean {
  if (options.allowProbing !== true || !URL.canParse(url)) return false;
  const origin = new URL(url).origin;
  return (options.probingOrigins ?? []).some(
    (o) => URL.canParse(o) && new URL(o).origin === origin,
  );
}

export function contextFor(options: ServerOptions, state: ServerState): ToolContext {
  const listed = new Set((options.allowPrivateHosts ?? []).map(normaliseHostPort));
  return {
    options,
    state,
    now: options.now ?? (() => new Date()),
    maxFindings: options.maxFindings ?? 40,
    fetcherFor: (target, onlyOrigin) => {
      try {
        checkTarget(target);
      } catch {
        throw new ToolError(NEVER_MESSAGE);
      }
      // May the model's own address be private? Only if the operator said so: for every private address
      // (--allow-private), or for the named host:port pairs only (--allow-private-host, which wins).
      const open =
        listed.size > 0 ? listed.has(hostPortOf(new URL(target))) : options.allowPrivate === true;
      const inner = createFetcher({
        ...options.fetcher,
        resolver: guardedResolver(options.fetcher?.resolver),
        semaphore: state.gate,
        // The same rule as the CLI's --allow-private: it trusts the address named, not where its pages
        // point, so a redirect or a link to another non-public address is still refused.
        ...(open ? { allowPrivate: true, target } : {}),
      });
      // Every hop of every request is judged by the wrapper, not only the first address.
      return guardedFetcher(inner, {
        ...(onlyOrigin !== undefined ? { origin: onlyOrigin } : {}),
        deadline: Date.now() + (options.maxCallMs ?? DEFAULT_CALL_MS),
        ...(options.fetcher?.maxHops !== undefined ? { maxHops: options.fetcher.maxHops } : {}),
      });
    },
  };
}

export { ToolError } from "./errors.js";
