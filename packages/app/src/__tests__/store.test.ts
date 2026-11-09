import { describe, expect, it } from "vitest";
import { initialSession, reducer, type Session } from "../store";
import type { RunSummary } from "../types";
import { doneRun, finding, result } from "./helpers";

const row = (id: string, state: RunSummary["state"] = "done"): RunSummary => ({
  id,
  url: `https://${id}.example/`,
  state,
  startedAt: "2026-11-09T10:00:00.000Z",
});

const started = (s: Session, id: string): Session =>
  reducer(s, { type: "started", run: row(id, "running") });

describe("the session reducer", () => {
  it("starts empty and not loaded", () => {
    expect(initialSession.runs.size).toBe(0);
    expect(initialSession.activeId).toBeNull();
    expect(initialSession.loaded).toBe(false);
  });

  it("listed: keeps the server's order, marks the session loaded, selects nothing", () => {
    const s = reducer(initialSession, { type: "listed", runs: [row("a"), row("b"), row("c")] });
    expect([...s.runs.keys()]).toEqual(["a", "b", "c"]);
    expect(s.loaded).toBe(true);
    expect(s.activeId).toBeNull();
  });

  it("started: adds the run last, running, with no steps, and selects it", () => {
    let s = reducer(initialSession, { type: "listed", runs: [row("a")] });
    s = started(s, "b");
    expect([...s.runs.keys()]).toEqual(["a", "b"]);
    expect(s.activeId).toBe("b");
    expect(s.runs.get("b")).toMatchObject({ state: "running", steps: [], lastEventId: 0 });
  });

  it("started twice for one id keeps one run", () => {
    const s = started(started(initialSession, "a"), "a");
    expect(s.runs.size).toBe(1);
  });

  it("step: appends text in order, and shows each event id only once", () => {
    let s = started(initialSession, "a");
    const step = (id: number, text: string) =>
      reducer(s, { type: "event", runId: "a", event: { kind: "step", id, text } });
    s = step(1, "Loading the page without JavaScript");
    s = step(2, "Reading robots.txt and the sitemap");
    // The stream reconnected and replayed from the start.
    s = step(1, "Loading the page without JavaScript");
    s = step(2, "Reading robots.txt and the sitemap");
    s = step(3, "Checking 4 links on the page");
    expect(s.runs.get("a")?.steps.map((x) => x.text)).toEqual([
      "Loading the page without JavaScript",
      "Reading robots.txt and the sitemap",
      "Checking 4 links on the page",
    ]);
    expect(s.runs.get("a")?.lastEventId).toBe(3);
  });

  it("done: sets the state and the counts", () => {
    let s = started(initialSession, "a");
    s = reducer(s, {
      type: "event",
      runId: "a",
      event: { kind: "done", id: 5, counts: { high: 2, medium: 1, low: 0 } },
    });
    expect(s.runs.get("a")).toMatchObject({
      state: "done",
      counts: { high: 2, medium: 1, low: 0 },
    });
  });

  it("failed: sets the state and keeps the reason", () => {
    let s = started(initialSession, "a");
    s = reducer(s, {
      type: "event",
      runId: "a",
      event: { kind: "failed", id: 2, reason: "The site did not answer." },
    });
    expect(s.runs.get("a")).toMatchObject({ state: "failed", reason: "The site did not answer." });
  });

  it("an event for an unknown run is ignored (the same state object comes back)", () => {
    const s = started(initialSession, "a");
    const next = reducer(s, {
      type: "event",
      runId: "nope",
      event: { kind: "step", id: 1, text: "x" },
    });
    expect(next).toBe(s);
    expect(next.runs.has("nope")).toBe(false);
  });

  it("select: changes the active run; an unknown id is ignored; null clears", () => {
    let s = reducer(initialSession, { type: "listed", runs: [row("a"), row("b")] });
    s = reducer(s, { type: "select", id: "a" });
    expect(s.activeId).toBe("a");
    expect(reducer(s, { type: "select", id: "zzz" })).toBe(s);
    expect(reducer(s, { type: "select", id: null }).activeId).toBeNull();
  });

  it("detail: adds the result to a finished run, and never takes a run back to running", () => {
    const r = result({ findings: [finding()] });
    let s = reducer(initialSession, { type: "listed", runs: [row("a", "running")] });
    s = reducer(s, { type: "detail", run: doneRun("a", "https://a.example/", r) });
    expect(s.runs.get("a")).toMatchObject({ state: "done", result: r });
    s = reducer(s, { type: "detail", run: { ...row("a", "running") } });
    expect(s.runs.get("a")?.state).toBe("done");
    expect(s.runs.get("a")?.result).toBe(r);
  });

  it("detail-failed: records why the result could not be read", () => {
    let s = reducer(initialSession, { type: "listed", runs: [row("a")] });
    s = reducer(s, { type: "detail-failed", runId: "a", message: "Not found." });
    expect(s.runs.get("a")?.loadError).toBe("Not found.");
  });

  it("refreshed: updates state and counts of runs the app is not watching, keeps steps, skips the active run", () => {
    let s = reducer(initialSession, {
      type: "listed",
      runs: [row("a", "running"), row("b", "running")],
    });
    s = reducer(s, { type: "select", id: "b" });
    s = reducer(s, { type: "event", runId: "a", event: { kind: "step", id: 1, text: "kept" } });
    s = reducer(s, {
      type: "refreshed",
      runs: [
        { ...row("a", "done"), counts: { high: 1, medium: 0, low: 0 } },
        { ...row("b", "done"), counts: { high: 9, medium: 9, low: 9 } },
      ],
    });
    expect(s.runs.get("a")).toMatchObject({
      state: "done",
      counts: { high: 1, medium: 0, low: 0 },
    });
    expect(s.runs.get("a")?.steps).toHaveLength(1);
    expect(s.runs.get("b")?.state).toBe("running");
  });

  it("listed after a start keeps what the app already knows about a run", () => {
    let s = started(initialSession, "b");
    s = reducer(s, { type: "event", runId: "b", event: { kind: "step", id: 1, text: "kept" } });
    s = reducer(s, { type: "listed", runs: [row("a"), row("b", "running")] });
    expect([...s.runs.keys()]).toEqual(["a", "b"]);
    expect(s.runs.get("b")?.steps).toHaveLength(1);
    expect(s.activeId).toBe("b");
  });

  it("never mutates the state it was given", () => {
    const s = started(initialSession, "a");
    const before = [...s.runs.keys()];
    reducer(s, { type: "started", run: row("b", "running") });
    expect([...s.runs.keys()]).toEqual(before);
  });
});
