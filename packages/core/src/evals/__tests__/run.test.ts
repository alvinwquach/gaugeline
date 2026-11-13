/**
 * The harness end to end with a tiny agent (AG-09): golden cases, known-bad cases, replay, judge.
 * No real clock, no network, no key: the model is a recorded fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplayModel } from "../replay.js";
import { formatEvalReport, runEvals, validateEvalSet } from "../run.js";
import type { EvalAgent, EvalCase, EvalModel, EvalRecording, EvalAssertionId } from "../types.js";

interface Mini {
  ids: string[];
  note: string;
}
const agent: EvalAgent<Mini> = {
  id: "mini",
  tools: ["read:finding"],
  limits: { callsPerWindow: 3, windowMs: 60_000, costCeilingMicros: 10_000, timeoutMs: 1_000 },
  buildPrompt: (i) => `FINDINGS ${i.findings.map((f) => f.id).join(",")}`,
  parse: (raw) => {
    const o = raw as Partial<Mini> | null;
    return o !== null &&
      typeof o === "object" &&
      Array.isArray(o.ids) &&
      o.ids.every((x) => typeof x === "string") &&
      typeof o.note === "string"
      ? { ok: true, value: { ids: o.ids, note: o.note } }
      : { ok: false, issues: ["expected { ids: string[], note: string }"] };
  },
  citedIds: (o) => o.ids,
  prose: (o) => [o.note],
};

const usage = { inputTokens: 10, outputTokens: 5, costMicros: 100, latencyMs: 50 };
const rec = (out: unknown, over: Partial<EvalRecording> = {}): EvalRecording => ({
  text: typeof out === "string" ? out : JSON.stringify(out),
  usage,
  ...over,
});
const finding = { id: "f-1", checkId: "x", title: "Title with 4 words", evidence: "" };
const input = { findings: [finding] };
const golden = (id: string, extra: Partial<EvalCase> = {}): EvalCase =>
  ({ id, kind: "golden", title: id, input, ...extra }) as EvalCase;
const bad = (id: string, catches: EvalAssertionId[], inp = input): EvalCase => ({
  id,
  kind: "known-bad",
  title: id,
  input: inp,
  catches,
});
const fine = rec({ ids: ["f-1"], note: "ok" });

/** A suite that is valid on its own: one golden, one known-bad. */
function suite(extraCases: EvalCase[] = [], recs: [string, EvalRecording][] = []) {
  return {
    cases: [golden("g"), bad("b", ["cited-ids"]), ...extraCases],
    model: createReplayModel(
      new Map<string, EvalRecording>([
        ["g", fine],
        ["b", rec({ ids: ["f-404"], note: "ok" })],
        ...recs,
      ]),
    ),
  };
}
const status = (r: { assertions: { id: string; status: string }[] }, id: string) =>
  r.assertions.find((a) => a.id === id)?.status;

afterEach(() => vi.unstubAllEnvs());

describe("runEvals: golden and known-bad", () => {
  it("passes a golden case on all six assertions and catches a known-bad one", async () => {
    const { cases, model } = suite();
    const report = await runEvals(agent, cases, model);
    expect(report.ok).toBe(true);
    const [g, b] = report.results;
    expect(g!.status).toBe("pass");
    expect(g!.assertions.map((a) => [a.id, a.status])).toEqual([
      ["schema", "pass"],
      ["cited-ids", "pass"],
      ["no-write-call", "pass"],
      ["no-invented-numbers", "pass"],
      ["limits", "pass"],
      ["must-cite", "pass"],
    ]);
    expect(b!.status).toBe("caught");
    expect(status(b!, "cited-ids")).toBe("fail");
    expect(report.golden).toEqual({ total: 1, passed: 1 });
    expect(report.knownBad).toEqual({ total: 1, caught: 1 });
    expect(report.costMicros).toBe(200);
  });

  it("marks a known-bad case that nothing caught as missed, and the report not ok", async () => {
    const { cases, model } = suite([bad("sneaky", ["no-write-call"])], [["sneaky", fine]]);
    const report = await runEvals(agent, cases, model);
    expect(report.results.find((r) => r.caseId === "sneaky")!.status).toBe("missed");
    expect(report.ok).toBe(false);
  });

  it("requires every assertion a known-bad case names to fail", async () => {
    const both = bad("both", ["cited-ids", "no-invented-numbers"]);
    const r1 = await runEvals(
      agent,
      [golden("g"), both],
      createReplayModel(
        new Map([
          ["g", fine],
          ["both", rec({ ids: ["f-9"], note: "ok" })],
        ]),
      ),
    );
    expect(r1.results[1]!.status).toBe("missed");
    const r2 = await runEvals(
      agent,
      [golden("g"), both],
      createReplayModel(
        new Map([
          ["g", fine],
          ["both", rec({ ids: ["f-9"], note: "up 37 percent" })],
        ]),
      ),
    );
    expect(r2.results[1]!.status).toBe("caught");
  });

  it("fails a golden case that breaks an assertion", async () => {
    const report = await runEvals(
      agent,
      [golden("g"), bad("b", ["cited-ids"])],
      createReplayModel(
        new Map([
          ["g", rec({ ids: ["f-2"], note: "ok" })],
          ["b", rec({ ids: ["f-404"], note: "ok" })],
        ]),
      ),
    );
    expect(report.results[0]!.status).toBe("fail");
    expect(report.golden.passed).toBe(0);
    expect(report.ok).toBe(false);
  });

  it("fails a golden case that leaves out a finding it must cite", async () => {
    const two = { findings: [finding, { ...finding, id: "f-2" }] };
    const g = golden("g", { input: two, mustCite: ["f-1", "f-2"] } as Partial<EvalCase>);
    const report = await runEvals(
      agent,
      [g, bad("b", ["cited-ids"])],
      createReplayModel(
        new Map([
          ["g", rec({ ids: ["f-1"], note: "ok" })],
          ["b", rec({ ids: ["f-404"], note: "ok" })],
        ]),
      ),
    );
    expect(status(report.results[0]!, "must-cite")).toBe("fail");
    expect(report.results[0]!.status).toBe("fail");
  });

  it("an error in one case (no recording) does not stop the others", async () => {
    const { cases, model } = suite([golden("lost")]);
    const report = await runEvals(agent, cases, model);
    const lost = report.results.find((r) => r.caseId === "lost")!;
    expect(lost.status).toBe("error");
    expect(lost.detail).toContain("lost");
    expect(report.results[0]!.status).toBe("pass");
    expect(report.ok).toBe(false);
  });

  it("an unreadable answer from the model fails the case, never throws", async () => {
    const odd: EvalModel = { complete: async () => ({ text: 1 }) as never };
    const report = await runEvals(agent, [golden("g"), bad("b", ["schema"])], odd);
    expect(report.results.map((r) => r.status)).toEqual(["error", "error"]);
  });
});

describe("runEvals: each assertion", () => {
  const caught = async (catches: EvalAssertionId, r: EvalRecording, inp = input) => {
    const report = await runEvals(
      agent,
      [golden("g"), bad("b", [catches], inp)],
      createReplayModel(
        new Map([
          ["g", fine],
          ["b", r],
        ]),
      ),
    );
    return report.results[1]!;
  };

  it("schema: a malformed answer fails it and the checks that need the output are skipped", async () => {
    const r = await caught("schema", rec("Sure! Here are the groups: [oops"));
    expect(r.status).toBe("caught");
    expect(status(r, "cited-ids")).toBe("skipped");
    expect(status(r, "no-invented-numbers")).toBe("skipped");
    expect(status(r, "must-cite")).toBe("skipped");
    expect(status(r, "no-write-call")).toBe("pass");
    expect(status(r, "limits")).toBe("pass");
  });
  it("schema: JSON that is not the shape fails it", async () => {
    expect((await caught("schema", rec({ ids: "f-1" }))).status).toBe("caught");
    expect((await caught("schema", rec(null))).status).toBe("caught");
  });
  it("no-write-call: a write tool, or any tool off the allowlist, is caught", async () => {
    expect(
      (
        await caught(
          "no-write-call",
          rec({ ids: ["f-1"], note: "ok" }, { toolCalls: [{ tool: "publish_site" }] }),
        )
      ).status,
    ).toBe("caught");
    expect(
      (
        await caught(
          "no-write-call",
          rec({ ids: ["f-1"], note: "ok" }, { toolCalls: [{ tool: "read:other" }] }),
        )
      ).status,
    ).toBe("caught");
  });
  it("no-invented-numbers: 4 is in the title, 37 is not", async () => {
    expect(
      (await caught("no-invented-numbers", rec({ ids: ["f-1"], note: "37 pages" }))).status,
    ).toBe("caught");
    const ok = await runEvals(
      agent,
      [golden("g"), bad("b", ["cited-ids"])],
      createReplayModel(
        new Map([
          ["g", rec({ ids: ["f-1"], note: "a title of 4 words" })],
          ["b", rec({ ids: ["f-0"], note: "ok" })],
        ]),
      ),
    );
    expect(ok.results[0]!.status).toBe("pass");
  });
  it("no-invented-numbers: a number the agent derives is allowed", async () => {
    const derived: EvalAgent<Mini> = { ...agent, derivedNumbers: (i) => [i.findings.length] };
    const report = await runEvals(
      derived,
      [golden("g"), bad("b", ["cited-ids"])],
      createReplayModel(
        new Map([
          ["g", rec({ ids: ["f-1"], note: "1 finding" })],
          ["b", rec({ ids: ["f-0"], note: "ok" })],
        ]),
      ),
    );
    expect(report.results[0]!.status).toBe("pass");
  });
  it("limits: cost over the ceiling, a slow answer and too many calls are each caught", async () => {
    const cost = await caught(
      "limits",
      rec({ ids: ["f-1"], note: "ok" }, { usage: { ...usage, costMicros: 10_001 } }),
    );
    expect(cost.status).toBe("caught");
    expect(cost.assertions.find((a) => a.id === "limits")!.detail).toContain("cost-ceiling");
    const slow = await caught(
      "limits",
      rec({ ids: ["f-1"], note: "ok" }, { usage: { ...usage, latencyMs: 1_001 } }),
    );
    expect(slow.assertions.find((a) => a.id === "limits")!.detail).toContain("timeout");
    const calls = [{ tool: "read:finding" }, { tool: "read:finding" }, { tool: "read:finding" }];
    const rate = await caught("limits", rec({ ids: ["f-1"], note: "ok" }, { toolCalls: calls }));
    expect(rate.assertions.find((a) => a.id === "limits")!.detail).toContain("rate-limit");
  });
  it("limits: exactly at every limit still passes", async () => {
    const calls = [{ tool: "read:finding" }, { tool: "read:finding" }];
    const report = await runEvals(
      agent,
      [golden("g"), bad("b", ["cited-ids"])],
      createReplayModel(
        new Map([
          [
            "g",
            rec(
              { ids: ["f-1"], note: "ok" },
              { toolCalls: calls, usage: { ...usage, costMicros: 10_000, latencyMs: 1_000 } },
            ),
          ],
          ["b", rec({ ids: ["f-0"], note: "ok" })],
        ]),
      ),
    );
    expect(report.results[0]!.status).toBe("pass");
  });
  it("limits: an input over 100,000 characters never reaches the model", async () => {
    const huge = { findings: [{ ...finding, evidence: "a".repeat(100_001) }] };
    const complete = vi.fn(async () => rec({ ids: ["f-1"], note: "ok" }));
    const report = await runEvals(agent, [golden("g"), bad("b", ["limits"], huge)], {
      complete: (req) => (req.caseId === "g" ? complete() : complete()),
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const b = report.results[1]!;
    expect(b.status).toBe("caught");
    expect(b.assertions.find((a) => a.id === "limits")!.detail).toContain("input-too-long");
    expect(b.assertions.filter((a) => a.id !== "limits").every((a) => a.status === "skipped")).toBe(
      true,
    );
  });
  it("the harness ignores the operator's environment: a kill switch there does not change a replay", async () => {
    vi.stubEnv("GAUGELINE_AGENTS_OFF", "1");
    const { cases, model } = suite();
    expect((await runEvals(agent, cases, model)).ok).toBe(true);
  });
});

describe("runEvals: a model-judged result is advisory or unsure, never a pass", () => {
  it("records an advisory note and leaves the status alone", async () => {
    const { cases, model } = suite();
    const judge = vi.fn(async () => ({ verdict: "advisory" as const, note: "reads well" }));
    const report = await runEvals(agent, cases, model, { judge });
    expect(report.results[0]!.judged).toEqual({ verdict: "advisory", note: "reads well" });
    expect(report.results[0]!.status).toBe("pass");
  });
  it("turns any other verdict, or a throw, into unsure", async () => {
    const { cases, model } = suite();
    for (const judge of [
      async () => ({ verdict: "pass" }) as never,
      async () => ({ verdict: "approve" }) as never,
      async () => null as never,
      async () => {
        throw new Error("judge down");
      },
    ]) {
      const report = await runEvals(agent, cases, model, { judge });
      expect(report.results[0]!.judged!.verdict).toBe("unsure");
      expect(JSON.stringify(report.results)).not.toMatch(/"verdict":"pass"/);
    }
  });
  it("cannot rescue a failing case or sink a passing one", async () => {
    const { cases, model } = suite([bad("sneaky", ["no-write-call"])], [["sneaky", fine]]);
    const report = await runEvals(agent, cases, model, {
      judge: async () => ({ verdict: "advisory", note: "looks fine" }),
    });
    expect(report.results.find((r) => r.caseId === "sneaky")!.status).toBe("missed");
    expect(report.ok).toBe(false);
  });
  it("is not asked about an answer that is not valid", async () => {
    const judge = vi.fn(async () => ({ verdict: "advisory" as const }));
    const { cases, model } = suite([bad("junk", ["schema"])], [["junk", rec("not json")]]);
    const report = await runEvals(agent, cases, model, { judge });
    expect(report.results.find((r) => r.caseId === "junk")!.judged).toBeUndefined();
    expect(judge).toHaveBeenCalledTimes(2);
  });
});

describe("validateEvalSet", () => {
  const issues = (cases: EvalCase[], a: EvalAgent<Mini> = agent) => validateEvalSet(a, cases);
  it("accepts a set with a golden and a known-bad case", () => {
    expect(issues([golden("g"), bad("b", ["schema"])])).toEqual([]);
  });
  it("names every problem", () => {
    expect(issues([bad("b", ["schema"])]).join("\n")).toMatch(/golden/);
    expect(issues([golden("g")]).join("\n")).toMatch(/known-bad/);
    expect(issues([golden("g"), golden("g"), bad("b", ["schema"])]).join("\n")).toMatch(
      /duplicate/,
    );
    expect(issues([golden("g"), bad("b", [])]).join("\n")).toMatch(/catches/);
    expect(issues([golden("g"), bad("b", ["nope" as never])]).join("\n")).toMatch(
      /unknown assertion/,
    );
    expect(
      issues([golden("g"), bad("b", ["schema"])], { ...agent, tools: ["publish_site"] }).join("\n"),
    ).toMatch(/write/);
    expect(
      issues([
        golden("g", { input: { findings: [finding, finding] } } as Partial<EvalCase>),
        bad("b", ["schema"]),
      ]).join("\n"),
    ).toMatch(/finding id/);
    expect(
      issues([golden("g"), bad("b", ["schema"])], {
        ...agent,
        limits: { ...agent.limits, timeoutMs: 1 },
      }).join("\n"),
    ).toMatch(/limit/);
  });
  it("a set with problems is not run: ok is false and the model is never called", async () => {
    const complete = vi.fn(async () => fine);
    const report = await runEvals(agent, [golden("g")], { complete });
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.results).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("runEvals: determinism", () => {
  it("gives the same report twice and reads no clock", async () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    const { cases, model } = suite();
    const a = await runEvals(agent, cases, model);
    const b = await runEvals(agent, cases, model);
    now.mockRestore();
    expect(a).toEqual(b);
  });
});

describe("formatEvalReport", () => {
  it("prints one line per case and a summary, plain text", async () => {
    const { cases, model } = suite([golden("lost")]);
    const text = formatEvalReport(await runEvals(agent, cases, model));
    expect(text).toContain("agent mini: 2 golden, 1 known-bad");
    expect(text).toContain("golden     g");
    expect(text).toMatch(/known-bad {2}b\s+caught \(cited-ids\)/);
    expect(text).toMatch(/lost\s+error/);
    expect(text).toMatch(/golden 1\/2 pass; known-bad 1\/1 caught; cost 200 micro-units/);
    expect(text).not.toMatch(/[^\x20-\x7e\n]/);
  });
});
