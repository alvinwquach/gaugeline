/**
 * The eval suite report (AG-11): pass rate, refusal rate and cost per agent from the recorded replay, and
 * whether the suite is green. Offline: no network, no key, no clock. The recordings are the invented triage
 * example's, altered here to make a golden case fail, a known-bad case slip through, or a recording go missing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../errors.js";
import { triage } from "../example/triage.js";
import { createReplayModel } from "../replay.js";
import { runEvals } from "../run.js";
import { EVAL_SETS } from "../registry.js";
import { defineEvalSet } from "../sets.js";
import {
  EVAL_SUITE_SCHEMA,
  evalFailureCount,
  formatEvalSuite,
  runEvalSets,
  summariseEval,
} from "../suite.js";
import type { EvalRecording } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const triageSet = (recordings: ReadonlyMap<string, EvalRecording> = triage.recordings) =>
  defineEvalSet({
    agent: triage.agent,
    cases: triage.cases,
    model: () => createReplayModel(recordings),
  });
/** A clean answer to the missing-id case, so nothing fails and the known-bad case slips through. */
const slipsThrough: EvalRecording = {
  usage: triage.recordings.get("golden-one-urgent")!.usage,
  text: JSON.stringify({
    groups: [
      {
        cause: "Missing canonical link",
        priority: "fix-soon",
        findingIds: ["f-101"],
        summary: "One page has no canonical link.",
      },
    ],
  }),
};
const without = (id: string): Map<string, EvalRecording> => {
  const m = new Map(triage.recordings);
  m.delete(id);
  return m;
};

describe("the registry", () => {
  it("holds the real agents' sets, one per agent, in the order they are reported", () => {
    expect(EVAL_SETS.map((s) => s.agentId)).toEqual(["approvals-digest", "triage"]);
  });
});

describe("summariseEval: the numbers", () => {
  it("counts a golden pass and a known-bad catch as a pass, and says what a refusal is", async () => {
    const report = await runEvals(triage.agent, triage.cases, createReplayModel(triage.recordings));
    const s = summariseEval(report);
    expect(s.agentId).toBe("triage");
    expect(s.ok).toBe(true);
    expect(s.cases).toEqual({ total: 11, passed: 11 });
    expect(s.golden).toEqual({ total: 3, passed: 3 });
    expect(s.knownBad).toEqual({ total: 8, caught: 8 });
    expect(s.passRatePercent).toBe(100);
    // Stopped by a guard: schema (1), limits (4: cost, time, rate, oversized) and no-write-call (1).
    expect(s.refused).toBe(6);
    expect(s.refusalRatePercent).toBe(55);
    // The oversized case never reached the model, so ten of the eleven have a recorded cost.
    expect(s.cost).toEqual({ measured: true, micros: 1_008_000, cases: 10 });
  });

  it("lists each case with its failed assertions, and a cost only where the model answered", async () => {
    const s = summariseEval(
      await runEvals(triage.agent, triage.cases, createReplayModel(triage.recordings)),
    );
    const row = (id: string) => s.results.find((r) => r.caseId === id)!;
    expect(row("golden-two-causes")).toMatchObject({
      kind: "golden",
      status: "pass",
      failed: [],
      refused: false,
      costMicros: 12_000,
    });
    expect(row("bad-write-call")).toMatchObject({
      status: "caught",
      failed: ["no-write-call"],
      refused: true,
    });
    expect(row("bad-missing-id")).toMatchObject({ failed: ["cited-ids"], refused: false });
    expect(row("bad-oversized-input")).toMatchObject({
      status: "caught",
      failed: ["limits"],
      refused: true,
      costMicros: null,
      latencyMs: null,
    });
    expect(row("bad-malformed-output").costMicros).toBe(12_000);
  });

  it("rounds a rate to a whole percent from whole counts (no floats are stored)", async () => {
    const s = summariseEval(
      await runEvals(triage.agent, triage.cases, createReplayModel(triage.recordings)),
    );
    for (const n of [s.passRatePercent, s.refusalRatePercent])
      expect(Number.isInteger(n)).toBe(true);
    expect(Number.isInteger(s.cost.micros)).toBe(true);
  });

  it("a set that could not be run has no rates and no cost, never zero", async () => {
    const bad = { ...triage.agent, tools: ["publish_page"] };
    const s = summariseEval(
      await runEvals(bad, triage.cases, createReplayModel(triage.recordings)),
    );
    expect(s.ok).toBe(false);
    expect(s.problems.join(" ")).toContain("write tool");
    expect(s.passRatePercent).toBeNull();
    expect(s.refusalRatePercent).toBeNull();
    expect(s.cost).toEqual({ measured: false, micros: null, cases: 0 });
    expect(s.results).toEqual([]);
  });
});

describe("runEvalSets: what turns the suite red", () => {
  it("is green for the shipped sets", async () => {
    const suite = await runEvalSets(EVAL_SETS);
    expect(suite.schema).toBe(EVAL_SUITE_SCHEMA);
    expect(suite.ok).toBe(true);
    expect(evalFailureCount(suite)).toBe(0);
    expect(suite.agents.map((a) => a.agentId)).toEqual(["approvals-digest", "triage"]);
    for (const a of suite.agents) {
      expect(a.problems, a.agentId).toEqual([]);
      expect(a.golden.total, a.agentId).toBeGreaterThan(0);
      expect(a.knownBad.total, a.agentId).toBeGreaterThan(0);
      expect(a.passRatePercent, a.agentId).toBe(100);
    }
  });

  it("a known-bad case nothing catches is a failure", async () => {
    const recordings = new Map(triage.recordings);
    recordings.set("bad-missing-id", slipsThrough);
    const suite = await runEvalSets([triageSet(recordings)]);
    const a = suite.agents[0]!;
    expect(a.results.find((r) => r.caseId === "bad-missing-id")!.status).toBe("missed");
    expect(a.knownBad).toEqual({ total: 8, caught: 7 });
    expect(a.passRatePercent).toBe(91);
    expect(suite.ok).toBe(false);
    expect(evalFailureCount(suite)).toBe(1);
  });

  it("a golden case that fails is a failure", async () => {
    const recordings = new Map(triage.recordings);
    recordings.set("golden-one-urgent", triage.recordings.get("bad-missing-id")!);
    const suite = await runEvalSets([triageSet(recordings)]);
    const row = suite.agents[0]!.results.find((r) => r.caseId === "golden-one-urgent")!;
    expect(row.status).toBe("fail");
    expect(row.failed).toContain("cited-ids");
    expect(suite.ok).toBe(false);
    expect(evalFailureCount(suite)).toBe(1);
  });

  it("a missing recording is an error row, named, and a failure; the other cases still run", async () => {
    const suite = await runEvalSets([triageSet(without("golden-two-causes"))]);
    const a = suite.agents[0]!;
    const row = a.results.find((r) => r.caseId === "golden-two-causes")!;
    expect(row.status).toBe("error");
    expect(row.detail).toContain('No recording for case "golden-two-causes"');
    expect(row.costMicros).toBeNull();
    expect(a.results.filter((r) => r.status === "pass" || r.status === "caught")).toHaveLength(10);
    expect(suite.ok).toBe(false);
    expect(evalFailureCount(suite)).toBe(1);
    // The cost is what the recorded cases cost; the one with no recording adds nothing.
    expect(a.cost).toEqual({ measured: true, micros: 1_008_000 - 12_000, cases: 9 });
  });

  it("every recording missing: cost is 'not measured', not zero", async () => {
    const suite = await runEvalSets([triageSet(new Map())]);
    const a = suite.agents[0]!;
    // The oversized input is refused before any model is asked, so it needs no recording and is still caught.
    expect(a.results.filter((r) => r.status === "error")).toHaveLength(10);
    expect(a.results.find((r) => r.status === "caught")!.caseId).toBe("bad-oversized-input");
    expect(a.cost).toEqual({ measured: false, micros: null, cases: 0 });
    expect(a.passRatePercent).toBe(9);
    expect(suite.ok).toBe(false);
    expect(formatEvalSuite(suite)).toContain("cost          not measured");
  });

  it("a recording that is not well formed stops that agent's set, and says so", async () => {
    const recordings = new Map(triage.recordings);
    recordings.set("bad-over-cost", { text: "x", usage: { costMicros: -1 } } as never);
    const suite = await runEvalSets([triageSet(recordings)]);
    const a = suite.agents[0]!;
    expect(a.ok).toBe(false);
    expect(a.problems).toEqual(['The recording for case "bad-over-cost" is not well formed.']);
    expect(a.results).toEqual([]);
    expect(a.passRatePercent).toBeNull();
    expect(evalFailureCount(suite)).toBe(1);
  });

  it("an agent that throws while running is a problem, not a crash of the others", async () => {
    const boom = {
      agentId: "boom",
      run: async () => {
        throw new Error("the replay broke");
      },
    };
    const suite = await runEvalSets([boom, triageSet()]);
    expect(suite.agents.map((a) => [a.agentId, a.ok])).toEqual([
      ["boom", false],
      ["triage", true],
    ]);
    expect(suite.agents[0]!.problems).toEqual(["the replay broke"]);
    expect(suite.ok).toBe(false);
  });

  it("--agent picks sets by id, in the registry's order, and refuses an unknown one", async () => {
    const other = { ...triageSet(), agentId: "digest" };
    const suite = await runEvalSets([other, triageSet()], { agents: ["triage"] });
    expect(suite.agents.map((a) => a.agentId)).toEqual(["triage"]);
    await expect(runEvalSets([triageSet()], { agents: ["nobody"] })).rejects.toThrow(
      /no eval set for agent "nobody"/i,
    );
    await expect(runEvalSets([triageSet()], { agents: ["nobody"] })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("no eval sets at all is refused, not passed", async () => {
    await expect(runEvalSets([])).rejects.toBeInstanceOf(ConfigError);
    await expect(runEvalSets([])).rejects.toThrow(/no eval sets/i);
  });

  it("two sets for one agent are refused", async () => {
    await expect(runEvalSets([triageSet(), triageSet()])).rejects.toThrow(
      /more than one eval set/i,
    );
  });

  it("runs offline: no network, no key, no clock; and the same twice, byte for byte", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    for (const k of ["OPENAI_API_KEY", "GAUGELINE_MODEL_KEY"]) vi.stubEnv(k, "not-a-real-key");
    const a = JSON.stringify(await runEvalSets(EVAL_SETS));
    const b = JSON.stringify(await runEvalSets(EVAL_SETS));
    now.mockRestore();
    expect(a).toBe(b);
    expect(a).not.toContain("not-a-real-key");
  });

  it("a model's opinion never appears: there is no judge and no 'pass' verdict in the report", async () => {
    const text = JSON.stringify(await runEvalSets(EVAL_SETS));
    expect(text).not.toContain("judged");
  });
});

describe("formatEvalSuite", () => {
  it("prints pass rate, refusal rate and cost per agent, one block each", async () => {
    const shipped = formatEvalSuite(await runEvalSets(EVAL_SETS));
    expect(shipped.split("\n").filter((l) => l.startsWith("agent "))).toEqual([
      "agent approvals-digest",
      "agent triage",
    ]);
    expect(
      shipped.endsWith("Result: every golden case passed and every known-bad case was caught."),
    ).toBe(true);
    expect(formatEvalSuite(await runEvalSets([triageSet()]))).toBe(
      [
        "agent triage",
        "  pass rate     11 of 11 cases (100%): golden 3 of 3 pass, known-bad 8 of 8 caught",
        "  refusal rate  6 of 11 cases (55%): the answer was stopped by schema, limits or no-write-call",
        "  cost          1008000 micro-units over 10 cases with a recorded answer",
        "",
        "Result: every golden case passed and every known-bad case was caught.",
      ].join("\n"),
    );
  });

  it("names each failure under its agent, and the count in the last line", async () => {
    const recordings = without("golden-two-causes");
    recordings.set("bad-missing-id", slipsThrough);
    const text = formatEvalSuite(await runEvalSets([triageSet(recordings)]));
    expect(text).toContain(
      '  ERROR   golden-two-causes: No recording for case "golden-two-causes".',
    );
    expect(text).toContain("  MISSED  bad-missing-id: no assertion caught it");
    expect(text).toContain("Result: FAILED (2 problems: 1 known-bad case not caught, 1 error).");
  });

  it("prints only ASCII, so a terminal and a docs page show the same thing", async () => {
    const recordings = without("golden-two-causes");
    expect(formatEvalSuite(await runEvalSets([triageSet(recordings)]))).toMatch(/^[\x20-\x7e\n]*$/);
  });
});
