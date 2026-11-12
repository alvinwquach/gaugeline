/** Unit: the per-job deadline reaches the fetcher, so a job that is past it makes no more requests. */
import type { Fetcher, Hop } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { DeadlineError, guardFetcher } from "../deadline.js";

const hop = {
  url: "https://tidewater-bar.test/",
  status: 200,
  headers: {},
  ms: 1,
} as unknown as Hop;

function inner(delayMs = 0) {
  const calls: string[] = [];
  const answer = (name: string) => async () => {
    calls.push(name);
    await new Promise((r) => setTimeout(r, delayMs));
    return [hop];
  };
  const fetcher = {
    get: answer("get"),
    getSite: answer("getSite"),
    query: async () => {
      calls.push("query");
      return hop;
    },
    stats: { requests: 7, maxInFlight: 2 },
    history: () => [],
  } as unknown as Fetcher;
  return { calls, fetcher };
}

describe("guardFetcher", () => {
  it("passes requests through until the signal aborts, then refuses them without sending", async () => {
    const stop = new AbortController();
    const { calls, fetcher } = inner();
    const guarded = guardFetcher(fetcher, stop.signal);
    await expect(guarded.get("https://tidewater-bar.test/")).resolves.toEqual([hop]);
    stop.abort();
    await expect(guarded.get("https://tidewater-bar.test/menu")).rejects.toBeInstanceOf(
      DeadlineError,
    );
    await expect(guarded.getSite("tidewater-bar.test")).rejects.toBeInstanceOf(DeadlineError);
    await expect(
      guarded.query!("https://tidewater-bar.test/q", {} as never),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(calls).toEqual(["get"]);
  });

  it("a request in flight when the deadline passes is let go at once", async () => {
    const stop = new AbortController();
    const guarded = guardFetcher(inner(2000).fetcher, stop.signal);
    const pending = guarded.get("https://tidewater-bar.test/slow");
    const started = Date.now();
    setTimeout(() => stop.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(DeadlineError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps the fetcher's own counters and history", () => {
    const guarded = guardFetcher(inner().fetcher, new AbortController().signal);
    expect(guarded.stats.requests).toBe(7);
    expect(guarded.history?.()).toEqual([]);
  });
});
