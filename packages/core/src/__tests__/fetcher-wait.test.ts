import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../fetcher.js";

/** GetOptions.timeoutMs: the wait for one request, for a public API that is slow by design (PERF-01). */
function recording() {
  const waits: number[] = [];
  const transport: Transport = (_url, req) => {
    waits.push(req.timeoutMs);
    return Promise.resolve({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Readable.from([Buffer.from("ok")]),
    });
  };
  return { waits, transport };
}

describe("fetcher.get with timeoutMs", () => {
  it("gives the request the wait asked for, and every other request the fetcher's own", async () => {
    const { waits, transport } = recording();
    const f = createFetcher({ transport, timeoutMs: 10_000 });
    await f.get("https://one.example/", { timeoutMs: 90_000 });
    await f.get("https://two.example/");
    expect(waits).toEqual([90_000, 10_000]);
  });

  it("caps the wait at two minutes and never goes below a millisecond", async () => {
    const { waits, transport } = recording();
    const f = createFetcher({ transport });
    await f.get("https://one.example/", { timeoutMs: 10 * 60_000 });
    await f.get("https://two.example/", { timeoutMs: -5 });
    expect(waits).toEqual([120_000, 1]);
  });

  it("does not honour a wait that is not a finite number: the fetcher's own applies", async () => {
    const { waits, transport } = recording();
    const f = createFetcher({ transport, timeoutMs: 10_000 });
    await f.get("https://one.example/", { timeoutMs: Number.NaN });
    await f.get("https://two.example/", { timeoutMs: Number.POSITIVE_INFINITY });
    expect(waits).toEqual([10_000, 10_000]);
  });

  it("is part of the memo key: the same address with a different wait is asked again", async () => {
    const { waits, transport } = recording();
    const f = createFetcher({ transport });
    await f.get("https://one.example/", { timeoutMs: 30_000 });
    await f.get("https://one.example/", { timeoutMs: 30_000 });
    await f.get("https://one.example/", { timeoutMs: 40_000 });
    expect(waits).toEqual([30_000, 40_000]);
  });

  it("says how long it waited when it gives up", async () => {
    const f = createFetcher({
      transport: () => Promise.reject(Object.assign(new Error("slow"), { name: "TimeoutError" })),
    });
    await expect(f.get("https://slow.example/", { timeoutMs: 45_000 })).rejects.toThrow(
      /within 45 seconds/,
    );
  });
});
