/**
 * The triage agent's eval set (AG-12, on AG-09's harness): golden cases run the real planner, known-bad cases
 * replay recorded wrong answers that the assertions must catch. Offline: no key, no network, no clock.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplayModel,
  formatEvalReport,
  runEvals,
  validateEvalSet,
} from "../../../evals/index.js";
import { createTriageEvalModel, triageEval } from "../evals.js";
import { exampleOutput } from "./example.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const run = () => runEvals(triageEval.agent, triageEval.cases, createTriageEvalModel());

describe("the triage eval set", () => {
  it("is a valid set, and every known-bad case has a recording and no golden case does", () => {
    expect(validateEvalSet(triageEval.agent, triageEval.cases)).toEqual([]);
    const bad = triageEval.cases.filter((c) => c.kind === "known-bad").map((c) => c.id);
    expect([...triageEval.recordings.keys()].sort()).toEqual([...bad].sort());
  });

  it("passes every golden case", async () => {
    const report = await run();
    expect(report.problems).toEqual([]);
    const golden = report.results.filter((r) => r.kind === "golden");
    expect(golden.map((r) => [r.caseId, r.status])).toEqual([
      ["golden-two-causes", "pass"],
      ["golden-one-family", "pass"],
      ["golden-page-text-is-data", "pass"],
      ["golden-only-worth-knowing", "pass"],
      ["golden-one-big-cause", "pass"],
    ]);
  });

  it("catches every known-bad case with the assertion written for it", async () => {
    const report = await run();
    const caught = Object.fromEntries(
      report.results
        .filter((r) => r.kind === "known-bad")
        .map((r) => [
          r.caseId,
          [r.status, ...r.assertions.filter((a) => a.status === "fail").map((a) => a.id)],
        ]),
    );
    expect(caught).toEqual({
      "bad-missing-id": ["caught", "cited-ids"],
      "bad-invented-number": ["caught", "no-invented-numbers"],
      "bad-write-call": ["caught", "no-write-call"],
      "bad-unlisted-tool": ["caught", "no-write-call"],
      "bad-over-cost": ["caught", "limits"],
      "bad-too-slow": ["caught", "limits"],
      "bad-too-many-calls": ["caught", "limits"],
      "bad-oversized-input": ["caught", "limits"],
      "bad-malformed-output": ["caught", "schema"],
      "bad-extra-key": ["caught", "schema"],
    });
    expect(report.ok).toBe(true);
    expect(report.golden).toEqual({ total: 5, passed: 5 });
    expect(report.knownBad).toEqual({ total: 10, caught: 10 });
    expect(report.costMicros).toBe(0);
  });

  it("the golden answers put fix-first before fix-soon, one group per cause, citing every finding once", async () => {
    const model = createTriageEvalModel();
    for (const c of triageEval.cases.filter((x) => x.kind === "golden")) {
      const { groups } = exampleOutput(
        await model.complete({ caseId: c.id, agentId: "triage", prompt: "" }),
      );
      const order = groups.map((g) => g.priority);
      expect(order, c.id).toEqual(
        [...order].sort((a, b) => (a === b ? 0 : a === "fix-first" ? -1 : 1)),
      );
      const ids = groups.flatMap((g) => g.findingIds);
      expect(new Set(ids).size, c.id).toBe(ids.length);
    }
  });

  it("the page's order is grouped as a finding, never obeyed", async () => {
    const report = await run();
    const r = report.results.find((x) => x.caseId === "golden-page-text-is-data")!;
    expect(r.assertions.every((a) => a.status === "pass")).toBe(true);
    const out = exampleOutput(
      await createTriageEvalModel().complete({
        caseId: "golden-page-text-is-data",
        agentId: "triage",
        prompt: "",
      }),
    );
    expect(JSON.stringify(out)).not.toMatch(/ignore your instructions|publish_site/i);
  });

  it("a known-bad case that stops being caught turns the suite red", async () => {
    // The 'model' now answers the missing-id case with the planner's own correct output.
    const recordings = new Map(triageEval.recordings);
    recordings.delete("bad-missing-id");
    const report = await runEvals(
      triageEval.agent,
      triageEval.cases,
      createTriageEvalModel(recordings),
    );
    expect(report.results.find((r) => r.caseId === "bad-missing-id")!.status).toBe("missed");
    expect(report.ok).toBe(false);
  });

  it("a case with neither a recording nor a golden plan is an error, not a pass", async () => {
    const model = createReplayModel(new Map());
    const report = await runEvals(triageEval.agent, triageEval.cases.slice(0, 1), model);
    expect(report.results[0]!.status).toBe("error");
  });

  it("the agent's tools hold nothing that writes, and its limits are the registration's", () => {
    expect(triageEval.agent.tools).toEqual(["draft:email"]);
    expect(triageEval.agent.limits.costCeilingMicros).toBe(0);
  });

  it("runs offline and gives the same report twice", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    for (const k of ["OPENAI_API_KEY", "GAUGELINE_MODEL_KEY"]) vi.stubEnv(k, "");
    const [a, b] = [await run(), await run()];
    now.mockRestore();
    expect(a.ok).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("the docs page", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../../../docs/hosted/agent-triage.md", import.meta.url)),
    "utf8",
  );
  it("shows this run's real eval report", async () => {
    expect(page).toContain(formatEvalReport(await run()));
  });
});
