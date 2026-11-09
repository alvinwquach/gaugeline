import { vi } from "vitest";
import type { Counts, Finding, Result, RunDetail } from "../types";

/** A finding with invented content; override what a test cares about. */
export function finding(over: Partial<Finding> = {}): Finding {
  return {
    checkId: "canonical-elsewhere",
    severity: "high",
    title: "This page tells Google to show a different page",
    evidence: '<link rel="canonical" href="https://shop.example/other">',
    url: "https://shop.example/",
    ...over,
  };
}

export function result(over: Partial<Result> = {}): Result {
  return {
    schema: 2,
    url: "https://shop.example/",
    startedAt: "2026-11-09T10:00:00.000Z",
    findings: [],
    passed: [],
    failed: [],
    couldNotCheck: [],
    sampled: {},
    ...over,
  };
}

export function countsOf(findings: readonly Finding[]): Counts {
  const c: Counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity] += 1;
  return c;
}

/** A finished run as GET /api/runs/:id answers it. */
export function doneRun(id: string, url: string, r: Result): RunDetail {
  return {
    id,
    url,
    state: "done",
    startedAt: r.startedAt,
    counts: countsOf(r.findings),
    result: r,
  };
}

/** One answer for the fetch stub: JSON with a status. */
export function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in for the browser's EventSource that tests drive by hand. `sources` lists every one
 * that was opened, so a test can see reconnects.
 */
export class FakeEventSource {
  static sources: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.sources = [];
  }
  readonly url: string;
  closed = false;
  onerror: ((e: Event) => void) | null = null;
  private handlers = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.sources.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
  }
  /** The server sends an event. */
  emit(type: string, id: number, data: unknown): void {
    if (this.closed) return;
    const e = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(id) });
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
  /** The connection drops. */
  drop(): void {
    this.onerror?.(new Event("error"));
  }
}

export function installEventSource(): void {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
}

import type { RunState } from "../store";

/** A run as the store holds it. */
export function runState(over: Partial<RunState> = {}): RunState {
  return {
    id: "run-1",
    url: "https://shop.example/",
    state: "done",
    startedAt: "2026-11-09T10:00:00.000Z",
    steps: [],
    lastEventId: 0,
    ...over,
  };
}

export interface FakeApi {
  /** Runs the server holds, oldest first. Tests edit it between calls. */
  runs: RunDetail[];
  /** "GET /api/runs", "POST /api/check", ... in order. */
  calls: string[];
  /** What POST /api/check does. Default: add a running run and answer 202. */
  onCheck: (url: string) => Response | Promise<Response>;
}

/** Stub fetch with the server's four routes, over `api.runs`. */
export function installApi(initial: RunDetail[] = []): FakeApi {
  let n = 0;
  const api: FakeApi = {
    runs: initial,
    calls: [],
    onCheck(url) {
      n += 1;
      const run: RunDetail = {
        id: `new-${n}`,
        url: new URL(/^https?:/.test(url) ? url : `https://${url}`).href,
        state: "running",
        startedAt: "2026-11-09T11:00:00.000Z",
      };
      api.runs.push(run);
      return reply(202, { id: run.id });
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      api.calls.push(`${method} ${input}`);
      if (input === "/api/check") {
        const body = JSON.parse(String(init?.body)) as { url: string };
        return api.onCheck(body.url);
      }
      if (input === "/api/runs") {
        return reply(
          200,
          api.runs.map(({ result: _r, reason: _x, ...summary }) => summary),
        );
      }
      const m = /^\/api\/runs\/([^/]+)$/.exec(input);
      const run = m ? api.runs.find((r) => r.id === decodeURIComponent(m[1] ?? "")) : undefined;
      if (run) return reply(200, run);
      return reply(404, { error: "There is no run with that id in this session." });
    }),
  );
  return api;
}
