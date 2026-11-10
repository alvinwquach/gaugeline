import { randomUUID } from "node:crypto";
import type { LeaksView, PageData, RequestRow, Result, RunResult } from "@gaugeline/core";
import type { AdsData } from "./ads.js";

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

/** What a run is of: a page checked from an address, or an ads export read from a file. */
export type RunKind = "page" | "ads";

export interface Run {
  id: string;
  /** The address that was typed. For an ads run, the file's base name and never its folder. */
  url: string;
  kind: RunKind;
  state: "running" | "done" | "failed";
  startedAt: string;
  counts?: Counts;
  /** When done: the same versioned JSON `gaugeline <address> --json` prints. */
  result?: Result;
  /**
   * When done: every address the check requested, what the page declares and what the key,
   * dataset and preview checks read, for the Pages checked, Search data and Leaks & access views. Beside the result, not in it: the result's shape is versioned.
   */
  checked?: { requests?: RequestRow[]; page: PageData; leaks: LeaksView };
  /**
   * An ads run, when done: each landing page's ads and spend (integers in minor units). The API sends
   * it in `checked`, beside the result, so the result's schema stays as it is.
   */
  ads?: AdsData;
  /**
   * When done: what the report download is made from, the same inputs the CLI gives renderReport
   * (the run's own result, which has no DNS entries added, and the address the page ended at).
   * Kept as data, not as text: the HTML is rendered when it is asked for.
   */
  report?: { result: RunResult; url: string };
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
    add(url: string, now: Date = new Date(), kind: RunKind = "page"): Run {
      if (runs.size >= max) {
        const oldest = [...runs.values()].find((r) => r.state !== "running");
        if (!oldest) throw new StoreFull(max);
        runs.delete(oldest.id);
      }
      const run: Run = {
        id: randomUUID(),
        url,
        kind,
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
