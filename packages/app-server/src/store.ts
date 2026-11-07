import { randomUUID } from "node:crypto";
import type { Result } from "@gaugeline/core";

/** What a run streams: a step's text, then done with the counts, or failed with the reason. */
export type RunEvent =
  | { id: number; event: "step"; data: { text: string } }
  | { id: number; event: "done"; data: { counts: Counts } }
  | { id: number; event: "failed"; data: { reason: string } };

export interface Counts {
  high: number;
  medium: number;
  low: number;
}

export interface Run {
  id: string;
  url: string;
  state: "running" | "done" | "failed";
  startedAt: string;
  counts?: Counts;
  /** When done: the same versioned JSON `gaugeline <address> --json` prints. */
  result?: Result;
  reason?: string;
  /** Every event so far, so a late subscriber (or one sending Last-Event-ID) gets a replay. */
  events: RunEvent[];
  /** Who is watching now. Removed when their connection closes. */
  listeners: Set<(e: RunEvent) => void>;
}

/** Every run's slots are taken by runs still going: the app answers 429. */
export class StoreFull extends Error {
  constructor(max: number) {
    super(`${max} checks are already running: wait for one to finish.`);
    this.name = "StoreFull";
  }
}

/**
 * The session's runs, in memory only (nothing is saved): a Map keeps insertion order, which is the
 * order the runs are listed in. Full, the oldest finished run is dropped; never a running one.
 */
export function createStore({ max = 50 }: { max?: number } = {}) {
  const runs = new Map<string, Run>();
  return {
    add(url: string, now: Date = new Date()): Run {
      if (runs.size >= max) {
        const oldest = [...runs.values()].find((r) => r.state !== "running");
        if (!oldest) throw new StoreFull(max);
        runs.delete(oldest.id);
      }
      const run: Run = {
        id: randomUUID(),
        url,
        state: "running",
        startedAt: now.toISOString(),
        events: [],
        listeners: new Set(),
      };
      runs.set(run.id, run);
      return run;
    },
    get: (id: string) => runs.get(id),
    list: () => [...runs.values()],
    /** Record an event and hand it to everyone watching. */
    emit(run: Run, e: Omit<RunEvent, "id">): void {
      const event = { ...e, id: run.events.length + 1 } as RunEvent;
      run.events.push(event);
      for (const l of [...run.listeners]) l(event);
    },
  };
}
export type Store = ReturnType<typeof createStore>;
