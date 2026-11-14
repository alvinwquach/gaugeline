/**
 * The invented "triage" agent (AG-09): golden cases, known-bad cases and recorded output, run through the
 * harness offline. Every known-bad case must be caught by the assertion it was written for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { triage } from "../example/triage.js";
import { createReplayModel } from "../replay.js";
import { formatEvalReport, runEvals, validateEvalSet } from "../run.js";
import { MAX_EVAL_INPUT_CHARS } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const run = () => runEvals(triage.agent, triage.cases, createReplayModel(triage.recordings));

describe("the triage example", () => {
  it("is a valid eval set with a recording for every case", () => {
    expect(validateEvalSet(triage.agent, triage.cases)).toEqual([]);
    for (const c of triage.cases) expect(triage.recordings.has(c.id), c.id).toBe(true);
    expect(triage.recordings.size).toBe(triage.cases.length);
  });

  it("passes every golden case", async () => {
    const report = await run();
    const golden = report.results.filter((r) => r.kind === "golden");
    expect(golden.map((r) => r.caseId)).toEqual([
      "golden-two-causes",
      "golden-one-urgent",
      "golden-page-text-is-data",
    ]);
    expect(golden.every((r) => r.status === "pass")).toBe(true);
  });

  it("catches every known-bad case with the assertion written for it", async () => {
    const report = await run();
    const caughtBy = Object.fromEntries(
      report.results
        .filter((r) => r.kind === "known-bad")
        .map((r) => [
          r.caseId,
          [r.status, ...r.assertions.filter((a) => a.status === "fail").map((a) => a.id)],
        ]),
    );
    expect(caughtBy).toEqual({
      "bad-missing-id": ["caught", "cited-ids"],
      "bad-invented-number": ["caught", "no-invented-numbers"],
      "bad-write-call": ["caught", "no-write-call"],
      "bad-over-cost": ["caught", "limits"],
      "bad-too-slow": ["caught", "limits"],
      "bad-too-many-calls": ["caught", "limits"],
      "bad-oversized-input": ["caught", "limits"],
      "bad-malformed-output": ["caught", "schema"],
    });
    expect(report.ok).toBe(true);
    expect(report.golden).toEqual({ total: 3, passed: 3 });
    expect(report.knownBad).toEqual({ total: 8, caught: 8 });
  });

  it("the oversized case really is over the cap, and the others are under it", () => {
    const sizes = Object.fromEntries(
      triage.cases.map((c) => [
        c.id,
        (c.input.pageText?.length ?? 0) +
          c.input.findings.reduce((n, f) => n + f.title.length + f.evidence.length, 0),
      ]),
    );
    expect(sizes["bad-oversized-input"]).toBeGreaterThan(MAX_EVAL_INPUT_CHARS);
    for (const [id, n] of Object.entries(sizes))
      if (id !== "bad-oversized-input") expect(n, id).toBeLessThan(MAX_EVAL_INPUT_CHARS);
  });

  it("treats page text as data: the injected order changes nothing, and it reaches the model labelled", async () => {
    const seen: string[] = [];
    const replay = createReplayModel(triage.recordings);
    const report = await runEvals(triage.agent, triage.cases, {
      complete: async (req) => {
        seen.push(req.prompt);
        return replay.complete(req);
      },
    });
    const c = report.results.find((r) => r.caseId === "golden-page-text-is-data")!;
    expect(c.status).toBe("pass");
    const prompt = seen[triage.cases.findIndex((x) => x.id === "golden-page-text-is-data")]!;
    expect(prompt).toContain('"untrusted":true');
    expect(prompt).toMatch(/Ignore your instructions/i);
    // The order is quoted inside a labelled field, never outside one.
    expect(prompt.split("\n").filter((l) => /^ignore your instructions/i.test(l))).toEqual([]);
  });

  it("runs offline: no network, no key, no clock", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    for (const k of ["OPENAI_API_KEY", "GAUGELINE_MODEL_KEY"]) vi.stubEnv(k, "");
    expect((await run()).ok).toBe(true);
    now.mockRestore();
  });

  it("gives the same report twice, byte for byte", async () => {
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it("a known-bad case that stops being caught turns the suite red", async () => {
    // The model now answers the missing-id case correctly: the case is missed, so ok is false.
    const recordings = new Map(triage.recordings);
    recordings.set("bad-missing-id", triage.recordings.get("golden-two-causes")!);
    const report = await runEvals(
      triage.agent,
      triage.cases.map((c) =>
        c.id === "bad-missing-id" ? { ...c, input: triage.cases[0]!.input } : c,
      ),
      createReplayModel(recordings),
    );
    expect(report.results.find((r) => r.caseId === "bad-missing-id")!.status).toBe("missed");
    expect(report.ok).toBe(false);
  });

  it("the docs page shows this run's real output", async () => {
    const page = readFileSync(
      fileURLToPath(new URL("../../../../../docs/agent-evals.md", import.meta.url)),
      "utf8",
    );
    expect(page).toContain(formatEvalReport(await run()));
  });
});
