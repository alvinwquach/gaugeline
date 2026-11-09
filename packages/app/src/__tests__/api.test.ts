import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getRun, listRuns, readChecked, readResult, startCheck, watchRun } from "../api";
import type { WatchEvent } from "../types";
import {
  FakeEventSource,
  checkedOf,
  doneRun,
  finding,
  installEventSource,
  reply,
  request,
  result,
} from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startCheck", () => {
  it("posts the address as JSON to /api/check and returns the run id", async () => {
    const fetchMock = vi.fn(async () => reply(202, { id: "run-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(startCheck("shop.example")).resolves.toEqual({ id: "run-1" });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/check");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ url: "shop.example" });
  });

  it("throws the server's sentence for a 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(400, { error: "That doesn't look like an address." })),
    );
    const err = await startCheck("not an address").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe("That doesn't look like an address.");
  });

  it("says plainly when the app can't be reached, and when the answer isn't the server's JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(startCheck("shop.example")).rejects.toThrow(/couldn't reach|could not reach/i);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>nope</html>", { status: 502 })),
    );
    await expect(startCheck("shop.example")).rejects.toThrow(/502/);
  });
});

describe("listRuns and getRun", () => {
  it("reads the list in the server's order", async () => {
    const rows = [
      { id: "a", url: "https://a.example/", state: "done", startedAt: "2026-11-09T10:00:00Z" },
      { id: "b", url: "https://b.example/", state: "running", startedAt: "2026-11-09T10:01:00Z" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, rows)),
    );
    expect((await listRuns()).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("asks for one run by id, encoded, and reads its schema 2 result", async () => {
    const run = doneRun("a/b", "https://a.example/", result({ findings: [finding()] }));
    const fetchMock = vi.fn(async (_path: string) => reply(200, run));
    vi.stubGlobal("fetch", fetchMock);
    const got = await getRun("a/b");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runs/a%2Fb");
    expect(got.result?.findings).toHaveLength(1);
  });

  it("refuses a result of another version, with a sentence", async () => {
    const run = {
      ...doneRun("a", "https://a.example/", result()),
      result: { ...result(), schema: 3 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, run)),
    );
    await expect(getRun("a")).rejects.toThrow(/schema 3/);
  });

  it("throws the server's sentence for a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(404, { error: "There is no run with that id in this session." })),
    );
    await expect(getRun("gone")).rejects.toThrow("There is no run with that id in this session.");
  });
});

describe("readResult", () => {
  it("accepts the shape and rejects what is missing", () => {
    expect(readResult(result()).schema).toBe(2);
    expect(() => readResult(null)).toThrow();
    expect(() => readResult({ ...result(), findings: "x" })).toThrow(/findings/);
    expect(() => readResult({ ...result(), schema: 1 })).toThrow(/schema 1/);
  });
});

describe("readChecked and getRun: the addresses and the page's data", () => {
  it("getRun carries them beside the result", async () => {
    const checked = checkedOf({
      requests: [request({ status: 301, location: "https://shop.example/b" })],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(200, { ...doneRun("a", "https://shop.example/", result()), checked }),
      ),
    );
    expect((await getRun("a")).checked).toEqual(checked);
  });

  it("a run from a server that sends none has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, doneRun("a", "https://shop.example/", result()))),
    );
    expect((await getRun("a")).checked).toBeUndefined();
  });

  it("keeps the shape it knows and drops the rest", () => {
    const c = readChecked({ ...checkedOf(), extra: 1, requests: [{ ...request(), extra: 1 }] });
    expect(c).toEqual(checkedOf());
  });

  it.each([
    ["not an object", 7],
    ["a request with an unknown kind", { ...checkedOf(), requests: [{ ...request(), kind: "x" }] }],
    ["a status that is text", { ...checkedOf(), requests: [{ ...request(), status: "200" }] }],
    ["no page", { requests: [] }],
    [
      "a block that is neither",
      { ...checkedOf(), page: { ...checkedOf().page, blocks: [{ ok: 1 }] } },
    ],
    ["words that are text", { ...checkedOf(), page: { ...checkedOf().page, words: "3" } }],
  ])("%s is not read", (_name, value) => {
    expect(readChecked(value)).toBeUndefined();
  });

  it("a page without a list of requests is read, with none", () => {
    const { requests: _r, ...rest } = checkedOf();
    expect(readChecked(rest)?.requests).toBeUndefined();
  });
});

describe("watchRun", () => {
  beforeEach(() => installEventSource());

  it("opens the run's event stream and reports steps, then done, and closes", () => {
    const seen: WatchEvent[] = [];
    watchRun("run-1", (e) => seen.push(e));
    const source = FakeEventSource.sources[0]!;
    expect(source.url).toBe("/api/runs/run-1/events");
    source.emit("step", 1, { text: "Loading the page without JavaScript" });
    source.emit("done", 2, { counts: { high: 1, medium: 0, low: 0 } });
    expect(seen).toEqual([
      { kind: "step", id: 1, text: "Loading the page without JavaScript" },
      { kind: "done", id: 2, counts: { high: 1, medium: 0, low: 0 } },
    ]);
    expect(source.closed).toBe(true);
  });

  it("reports failed with the reason and closes", () => {
    const seen: WatchEvent[] = [];
    watchRun("run-1", (e) => seen.push(e));
    const source = FakeEventSource.sources[0]!;
    source.emit("failed", 3, { reason: "The site did not answer." });
    expect(seen).toEqual([{ kind: "failed", id: 3, reason: "The site did not answer." }]);
    expect(source.closed).toBe(true);
  });

  it("stop() closes the stream and silences it", () => {
    const seen: WatchEvent[] = [];
    const stop = watchRun("run-1", (e) => seen.push(e));
    stop();
    expect(FakeEventSource.sources[0]!.closed).toBe(true);
    FakeEventSource.sources[0]!.emit("step", 1, { text: "late" });
    expect(seen).toEqual([]);
  });

  it("when the stream drops, reads the run again and reopens it while it is still running", async () => {
    const run = {
      id: "run-1",
      url: "https://a.example/",
      state: "running",
      startedAt: "2026-11-09T10:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, run)),
    );
    const seen: WatchEvent[] = [];
    watchRun("run-1", (e) => seen.push(e), { retryMs: 0 });
    FakeEventSource.sources[0]!.drop();
    await vi.waitFor(() => expect(FakeEventSource.sources).toHaveLength(2));
    expect(seen).toEqual([{ kind: "sync", run }]);
    expect(FakeEventSource.sources[0]!.closed).toBe(true);
  });

  it("when the run ended while the stream was down, reports it and does not reopen", async () => {
    const run = doneRun("run-1", "https://a.example/", result());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, run)),
    );
    const seen: WatchEvent[] = [];
    watchRun("run-1", (e) => seen.push(e), { retryMs: 0 });
    FakeEventSource.sources[0]!.drop();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ kind: "sync", run: { state: "done" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeEventSource.sources).toHaveLength(1);
  });

  it("stop() during the recovery cancels the reopen", async () => {
    const run = {
      id: "run-1",
      url: "https://a.example/",
      state: "running",
      startedAt: "2026-11-09T10:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, run)),
    );
    const stop = watchRun("run-1", () => {}, { retryMs: 0 });
    FakeEventSource.sources[0]!.drop();
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeEventSource.sources).toHaveLength(1);
  });
});
