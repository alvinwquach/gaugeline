import { useCallback, useEffect, useReducer } from "react";
import { getRun, listRuns, startCheck, watchRun } from "./api";
import type {
  AdsData,
  Checked,
  Counts,
  Result,
  RunDetail,
  RunKind,
  RunStatus,
  RunSummary,
  StreamEvent,
} from "./types";

export interface Step {
  id: number;
  text: string;
}

/** One run as the app holds it: what the server lists, the steps seen so far, and the result when read. */
export interface RunState {
  id: string;
  url: string;
  /** What the run is of. A page run when the server does not say. */
  kind: RunKind;
  state: RunStatus;
  startedAt: string;
  counts?: Counts;
  steps: Step[];
  /** The highest event id applied, so a replayed event is not shown twice. */
  lastEventId: number;
  result?: Result;
  /** The addresses the check requested and what the page declares, when the server sent them. */
  checked?: Checked;
  /** An ads run: the destinations and their spend. */
  ads?: AdsData;
  /** An ads run: the server has a report to download. */
  hasReport?: boolean;
  reason?: string;
  /** Why the result could not be read (a version this app doesn't know, or a lost connection). */
  loadError?: string;
}

/** The runs in the order the server lists them (a Map keeps insertion order), and which one is open. */
export interface Session {
  runs: Map<string, RunState>;
  activeId: string | null;
  /** The first listRuns() has answered (or failed). */
  loaded: boolean;
  /** Why the session could not be listed. */
  listError?: string;
}

export type Action =
  | { type: "listed"; runs: RunSummary[] }
  | { type: "list-failed"; message: string }
  | { type: "refreshed"; runs: RunSummary[] }
  | { type: "started"; run: RunDetail }
  | { type: "event"; runId: string; event: StreamEvent }
  | { type: "detail"; run: RunDetail }
  | { type: "detail-failed"; runId: string; message: string }
  | { type: "select"; id: string | null };

export const initialSession: Session = { runs: new Map(), activeId: null, loaded: false };

const fresh = (r: RunSummary): RunState => ({
  id: r.id,
  url: r.url,
  kind: r.kind ?? "page",
  state: r.state,
  startedAt: r.startedAt,
  ...(r.counts ? { counts: r.counts } : {}),
  steps: [],
  lastEventId: 0,
});

/** The state and counts of a listed run, laid over what the app already holds. A run never goes back to running. */
function overlay(have: RunState, r: RunSummary): RunState {
  if (have.state !== "running" && r.state === "running") return have;
  return { ...have, state: r.state, ...(r.counts ? { counts: r.counts } : {}) };
}

function withRun(s: Session, id: string, fn: (r: RunState) => RunState): Session {
  const run = s.runs.get(id);
  if (!run) return s;
  const next = fn(run);
  if (next === run) return s;
  return { ...s, runs: new Map(s.runs).set(id, next) };
}

/** Every change to the session goes through here: one place that is easy to test. A new Map each time. */
export function reducer(s: Session, a: Action): Session {
  switch (a.type) {
    case "listed": {
      const runs = new Map<string, RunState>();
      for (const r of a.runs) {
        const have = s.runs.get(r.id);
        runs.set(r.id, have ? overlay(have, r) : fresh(r));
      }
      return { ...s, runs, loaded: true };
    }
    case "list-failed":
      return { ...s, loaded: true, listError: a.message };
    case "refreshed": {
      const runs = new Map(s.runs);
      for (const r of a.runs) {
        const have = runs.get(r.id);
        // The open run is followed by its own stream; the others only change here.
        if (have && r.id !== s.activeId) runs.set(r.id, overlay(have, r));
      }
      return { ...s, runs };
    }
    case "started": {
      const runs = s.runs.has(a.run.id) ? s.runs : new Map(s.runs).set(a.run.id, fresh(a.run));
      const next: Session = { ...s, runs, activeId: a.run.id };
      return a.run.result || a.run.reason !== undefined
        ? reducer(next, { type: "detail", run: a.run })
        : next;
    }
    case "event":
      return withRun(s, a.runId, (r) => {
        const e = a.event;
        if (e.kind === "step") {
          if (e.id <= r.lastEventId) return r;
          return { ...r, steps: [...r.steps, { id: e.id, text: e.text }], lastEventId: e.id };
        }
        if (e.kind === "done")
          return {
            ...r,
            state: "done",
            counts: e.counts,
            lastEventId: Math.max(r.lastEventId, e.id),
          };
        return {
          ...r,
          state: "failed",
          reason: e.reason,
          lastEventId: Math.max(r.lastEventId, e.id),
        };
      });
    case "detail":
      return withRun(s, a.run.id, (r) => {
        if (r.state !== "running" && a.run.state === "running") return r;
        const { loadError: _cleared, ...rest } = r;
        return {
          ...rest,
          state: a.run.state,
          ...(a.run.counts ? { counts: a.run.counts } : {}),
          ...(a.run.result ? { result: a.run.result } : {}),
          ...(a.run.checked ? { checked: a.run.checked } : {}),
          ...(a.run.ads ? { ads: a.run.ads } : {}),
          ...(a.run.hasReport ? { hasReport: true } : {}),
          ...(a.run.reason !== undefined ? { reason: a.run.reason } : {}),
        };
      });
    case "detail-failed":
      return withRun(s, a.runId, (r) => ({ ...r, loadError: a.message }));
    case "select":
      if (a.id !== null && !s.runs.has(a.id)) return s;
      return a.id === s.activeId ? s : { ...s, activeId: a.id };
    default: {
      const never: never = a;
      return never;
    }
  }
}

/** How often runs that aren't open are listed again while one of them is running. */
export const REFRESH_MS = 2000;

export interface Runs {
  runs: Map<string, RunState>;
  activeId: string | null;
  loaded: boolean;
  listError: string | undefined;
  /** Post the address. Resolves once the run is in the session and selected; rejects with the server's sentence. */
  start: (url: string) => Promise<void>;
  select: (id: string | null) => void;
}

/**
 * The session: one reducer over a Map of runs. Lists the runs on load (so a reload shows the same
 * session), follows only the open run's event stream, reads the open run's result once it is done,
 * and lists again now and then while a run that isn't open is still going.
 */
export function useRuns(): Runs {
  const [session, dispatch] = useReducer(reducer, initialSession);
  const { runs, activeId } = session;
  const active = activeId === null ? undefined : runs.get(activeId);

  useEffect(() => {
    let live = true;
    listRuns().then(
      (list) => live && dispatch({ type: "listed", runs: list }),
      (err: unknown) => live && dispatch({ type: "list-failed", message: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const watching = active?.state === "running";
  useEffect(() => {
    if (activeId === null || !watching) return;
    return watchRun(activeId, (e) => {
      if (e.kind === "sync") dispatch({ type: "detail", run: e.run });
      else dispatch({ type: "event", runId: activeId, event: e });
    });
  }, [activeId, watching]);

  const needsDetail =
    active !== undefined &&
    active.state !== "running" &&
    active.result === undefined &&
    active.reason === undefined &&
    active.loadError === undefined;
  useEffect(() => {
    if (activeId === null || !needsDetail) return;
    let live = true;
    getRun(activeId).then(
      (run) => live && dispatch({ type: "detail", run }),
      (err: unknown) =>
        live && dispatch({ type: "detail-failed", runId: activeId, message: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [activeId, needsDetail]);

  const othersRunning = [...runs.values()].some((r) => r.state === "running" && r.id !== activeId);
  useEffect(() => {
    if (!othersRunning) return;
    let live = true;
    const timer = setInterval(() => {
      listRuns().then(
        (list) => live && dispatch({ type: "refreshed", runs: list }),
        () => {},
      );
    }, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [othersRunning]);

  const start = useCallback(async (url: string) => {
    const { id } = await startCheck(url);
    // The server writes the address its own way (https://, a trailing slash): ask for the run it made.
    const run = await getRun(id).catch((): RunDetail => ({
      id,
      url,
      state: "running",
      startedAt: new Date().toISOString(),
    }));
    dispatch({ type: "started", run });
  }, []);
  const select = useCallback((id: string | null) => dispatch({ type: "select", id }), []);

  return { runs, activeId, loaded: session.loaded, listError: session.listError, start, select };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}
