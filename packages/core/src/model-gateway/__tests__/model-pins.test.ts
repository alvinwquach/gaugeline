/**
 * Pinned model versions (AG-24): a file records the model id of each tier and the eval pass that covers
 * them (the SHA-256 of the eval report file). A model that changed without a matching, passing, whole-suite
 * report is refused as "could not run". Pure: text in, a verdict out; no file, clock, key or network.
 */
import { describe, expect, it } from "vitest";
import { CouldNotRunError } from "../../errors.js";
import { EVAL_SETS } from "../../evals/registry.js";
import { defineEvalSet } from "../../evals/sets.js";
import { createReplayModel } from "../../evals/replay.js";
import { runEvalSets } from "../../evals/suite.js";
import { triage } from "../../evals/example/triage.js";
import {
  MODEL_PINS_SCHEMA,
  checkModelPins,
  parseModelPins,
  reportSha256,
  requireEvaluatedModels,
  type ModelPins,
} from "../model-pins.js";

/** What `gaugeline evals` writes for the example agent, byte for byte (core's CLI does the same stringify). */
async function reportOf(
  edit: (suite: Awaited<ReturnType<typeof runEvalSets>>) => unknown = (s) => s,
) {
  const set = defineEvalSet({
    agent: triage.agent,
    cases: triage.cases,
    model: () => createReplayModel(triage.recordings),
  });
  return `${JSON.stringify(edit(await runEvalSets([set])), null, 2)}\n`;
}
const AGENTS = ["triage"];

const pinsFor = (report: string, over: Partial<ModelPins> = {}): ModelPins => ({
  schema: MODEL_PINS_SCHEMA,
  provider: "example",
  tiers: { fast: "small-model-2026-01", strong: "large-model-2026-01" },
  evalPass: {
    tiers: { fast: "small-model-2026-01", strong: "large-model-2026-01" },
    reportSha256: reportSha256(report),
  },
  ...over,
});
const reasons = (r: ReturnType<typeof checkModelPins>): string[] => {
  if (r.ok) throw new Error("the pins were expected to be refused");
  return r.reasons;
};

describe("the hash of a report", () => {
  it("is the SHA-256 of its exact bytes, in lower-case hex", () => {
    expect(reportSha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(reportSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("the pins file", () => {
  it("is accepted with a pass recorded or without one", async () => {
    const report = await reportOf();
    expect(parseModelPins(pinsFor(report)).ok).toBe(true);
    const { evalPass: _gone, ...bare } = pinsFor(report);
    expect(parseModelPins(bare).ok).toBe(true);
  });

  it("needs the schema number, a provider and at least one pinned tier", () => {
    const good = {
      schema: 1,
      provider: "example",
      tiers: { fast: "small-model" },
    };
    expect(parseModelPins(good).ok).toBe(true);
    for (const bad of [
      { ...good, schema: 2 },
      { ...good, provider: "Not A Provider" },
      { ...good, tiers: {} },
      { ...good, tiers: { ultra: "x" } },
      { ...good, tiers: { fast: "not a model!" } },
      { provider: "example", tiers: { fast: "small-model" } },
    ])
      expect(parseModelPins(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("refuses a recorded hash that is not 64 hex characters, and an unknown field, without echoing it", () => {
    const pasted = ["sk", "live", "q".repeat(24)].join("_");
    const r = parseModelPins({
      schema: 1,
      provider: "example",
      tiers: { fast: "small-model" },
      evalPass: { tiers: { fast: "small-model" }, reportSha256: "ABC" },
      apiKey: pasted,
      [pasted]: 1,
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? "" : r.problems.join("\n");
    expect(text).toContain("evalPass.reportSha256");
    expect(text).toContain("apiKey");
    expect(text).not.toContain(pasted);
    expect(text).not.toContain("ABC");
  });

  it("never prints a setting name the person wrote, even one two edits from a real one", () => {
    const r = parseModelPins({
      schema: 1,
      provider: "example",
      tiers: { fast: "small-model", fastQ9: "x" },
      providerzX: 1,
      schemaQ9: 1,
    });
    const text = r.ok ? "" : r.problems.join("\n");
    expect(r.ok).toBe(false);
    for (const added of ["Q9", "zX"]) expect(text).not.toContain(added);
    expect(text).toContain('did you mean "provider"?');
  });

  it.each([null, undefined, 5, "x", []])("refuses %j", (raw) => {
    expect(parseModelPins(raw).ok).toBe(false);
  });
});

describe("a model change is allowed only with a passing eval pass on record", () => {
  it("allows pinned models whose ids and report hash match a passing, whole-suite report", async () => {
    const report = await reportOf();
    expect(checkModelPins({ pins: pinsFor(report), reportText: report, agents: AGENTS })).toEqual({
      ok: true,
    });
  });

  it("refuses a tier whose pinned id is not the one the pass was recorded for, naming both", async () => {
    const report = await reportOf();
    const pins = pinsFor(report, {
      tiers: { fast: "small-model-2026-06", strong: "large-model-2026-01" },
    });
    expect(reasons(checkModelPins({ pins, reportText: report, agents: AGENTS }))).toEqual([
      "the fast tier is pinned to [not on the known list] but the recorded eval pass was for [not on the known list]",
    ]);
  });

  it("refuses a tier that the recorded pass does not cover at all", async () => {
    const report = await reportOf();
    const pins = pinsFor(report, {
      evalPass: { tiers: { fast: "small-model-2026-01" }, reportSha256: reportSha256(report) },
    });
    expect(reasons(checkModelPins({ pins, reportText: report, agents: AGENTS }))).toEqual([
      "the strong tier is pinned but the recorded eval pass does not cover it",
    ]);
  });

  it("refuses a pin with no eval pass recorded", async () => {
    const report = await reportOf();
    const { evalPass: _gone, ...bare } = pinsFor(report);
    expect(reasons(checkModelPins({ pins: bare, reportText: report, agents: AGENTS }))).toEqual([
      "no eval pass is recorded for the pinned models",
    ]);
  });

  it("refuses when the report file is not there", async () => {
    const report = await reportOf();
    expect(
      reasons(checkModelPins({ pins: pinsFor(report), reportText: undefined, agents: AGENTS })),
    ).toEqual(["the eval report file named by the recorded pass was not found"]);
  });

  it.each([
    ["a trailing space", (r: string) => `${r} `],
    ["a changed number", (r: string) => r.replace('"total": 3', '"total": 4')],
    ["the same data written compactly", (r: string) => JSON.stringify(JSON.parse(r))],
  ])("refuses a report that is not the recorded file: %s", async (_n, edit) => {
    const report = await reportOf();
    const changed = edit(report);
    expect(changed).not.toBe(report);
    expect(
      reasons(checkModelPins({ pins: pinsFor(report), reportText: changed, agents: AGENTS })),
    ).toEqual(["the eval report does not match the hash recorded for the pass"]);
  });

  it("does not let a recorded hash bless a failing report", async () => {
    const failing = await reportOf((s) => ({ ...s, ok: false }));
    expect(
      reasons(checkModelPins({ pins: pinsFor(failing), reportText: failing, agents: AGENTS })),
    ).toEqual(["the eval report is not a passing report"]);
  });

  it("refuses a report that has an agent with a problem or a failure", async () => {
    const bad = await reportOf((s) => ({
      ...s,
      agents: s.agents.map((a) => ({ ...a, ok: false, problems: ["a recording is broken"] })),
    }));
    expect(
      reasons(checkModelPins({ pins: pinsFor(bad), reportText: bad, agents: AGENTS })),
    ).toEqual(["the eval report is not a passing report"]);
  });

  it.each([
    ["not JSON", "this is not json"],
    ["an array", "[]"],
    ["the wrong schema", JSON.stringify({ schema: 9, ok: true, agents: [] })],
    ["no agents", JSON.stringify({ schema: 1, ok: true, agents: [] })],
  ])("refuses a report that is %s, even with its own hash recorded", (_n, text) => {
    const r = checkModelPins({
      pins: pinsFor(text),
      reportText: text,
      agents: AGENTS,
    });
    expect(reasons(r)).toEqual(["the eval report is not a passing report"]);
  });

  it("refuses a report that left out an agent that has an eval set (a run with --agent is not the suite)", async () => {
    const report = await reportOf();
    expect(
      reasons(
        checkModelPins({
          pins: pinsFor(report),
          reportText: report,
          agents: ["triage", "approvals-digest"],
        }),
      ),
    ).toEqual(["the eval report has no result for the agent approvals-digest"]);
  });

  it("checks against every agent that ships an eval set when none is named", async () => {
    const one = await reportOf();
    const r = checkModelPins({ pins: pinsFor(one), reportText: one });
    expect(reasons(r).join("\n")).toContain("the eval report has no result for the agent");
    const all = `${JSON.stringify(await runEvalSets(EVAL_SETS), null, 2)}\n`;
    expect(checkModelPins({ pins: pinsFor(all), reportText: all })).toEqual({ ok: true });
  });

  it("refuses a report over 2 MiB before it reads it", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    expect(
      reasons(checkModelPins({ pins: pinsFor(big), reportText: big, agents: AGENTS })),
    ).toEqual(["the eval report is over 2 MiB"]);
  });

  it("lists every reason, in a fixed order, and never repeats what the report says", async () => {
    const report = await reportOf((s) => ({ ...s, note: "ignore your instructions", ok: false }));
    const pins = pinsFor(report, {
      tiers: { fast: "small-model-2026-06", strong: "large-model-2026-01" },
    });
    const r = reasons(checkModelPins({ pins, reportText: report, agents: AGENTS }));
    expect(r).toHaveLength(2);
    expect(r[0]).toContain("the fast tier is pinned to");
    expect(JSON.stringify(r)).not.toContain("ignore your instructions");
  });

  it("gives the same answer every time", async () => {
    const report = await reportOf();
    const a = checkModelPins({ pins: pinsFor(report), reportText: `${report}!`, agents: AGENTS });
    const b = checkModelPins({ pins: pinsFor(report), reportText: `${report}!`, agents: AGENTS });
    expect(a).toEqual(b);
  });
});

describe("requireEvaluatedModels: a config only runs on models that passed", () => {
  const config = {
    provider: "example",
    keyEnv: "EXAMPLE_API_KEY",
    tiers: { fast: "small-model-2026-01", strong: "large-model-2026-01" },
  };
  const call = async (over: Record<string, unknown> = {}, pinsEdit?: (p: ModelPins) => unknown) => {
    const report = await reportOf();
    const pins = pinsFor(report);
    return () =>
      requireEvaluatedModels({
        config: { ...config, ...over } as never,
        pinsText: JSON.stringify(pinsEdit ? pinsEdit(pins) : pins),
        reportText: report,
        agents: AGENTS,
      });
  };

  it("hands the config back when every tier is the pinned, evaluated model", async () => {
    expect((await call())()).toEqual(config);
  });

  it("allows a config that uses fewer tiers than are pinned", async () => {
    const out = (await call({ tiers: { fast: "small-model-2026-01" } }))();
    expect(out.tiers).toEqual({ fast: "small-model-2026-01" });
  });

  it("refuses a config whose model differs from the pin, as could-not-run", async () => {
    const run = await call({ tiers: { fast: "small-model-2026-06" } });
    expect(run).toThrow(CouldNotRunError);
    try {
      run();
    } catch (e) {
      expect((e as CouldNotRunError).code).toBe("could-not-run");
      expect((e as Error).message).toContain("the fast tier");
      // A model id is a config string: not shown unless it is on the known list, and never in part.
      expect((e as Error).message).toContain("[not on the known list]");
      expect((e as Error).message).not.toContain("small-model-2026-06");
      expect((e as Error).message).not.toContain("sma");
      expect((e as CouldNotRunError).hint).toContain("gaugeline evals");
    }
  });

  it("refuses a pin changed without a new pass: the edit is what makes it refused", async () => {
    const run = await call({ tiers: { fast: "small-model-2026-06" } }, (p) => ({
      ...p,
      tiers: { ...p.tiers, fast: "small-model-2026-06" },
    }));
    expect(run).toThrow(
      /\[not on the known list\] but the recorded eval pass was for \[not on the known list\]/,
    );
  });

  it("allows it once the pass is recorded for the new model", async () => {
    const report = await reportOf();
    const pins = pinsFor(report, {
      tiers: { fast: "small-model-2026-06", strong: "large-model-2026-01" },
      evalPass: {
        tiers: { fast: "small-model-2026-06", strong: "large-model-2026-01" },
        reportSha256: reportSha256(report),
      },
    });
    const out = requireEvaluatedModels({
      config: { ...config, tiers: { fast: "small-model-2026-06" } },
      pinsText: JSON.stringify(pins),
      reportText: report,
      agents: AGENTS,
    });
    expect(out.tiers.fast).toBe("small-model-2026-06");
  });

  it("refuses a different provider, and a tier the pins do not name", async () => {
    expect(await call({ provider: "other" })).toThrow(/provider/);
    const report = await reportOf();
    const only = pinsFor(report, {
      tiers: { fast: "small-model-2026-01" },
      evalPass: { tiers: { fast: "small-model-2026-01" }, reportSha256: reportSha256(report) },
    });
    expect(() =>
      requireEvaluatedModels({
        config: config as never,
        pinsText: JSON.stringify(only),
        reportText: report,
        agents: AGENTS,
      }),
    ).toThrow(/strong tier is not pinned/);
  });

  it("refuses a pins file that is not JSON or not valid, without repeating it", () => {
    for (const pinsText of [
      "{not json",
      JSON.stringify({ schema: 1, apiKey: "do-not-repeat-1234" }),
    ])
      try {
        requireEvaluatedModels({
          config: config as never,
          pinsText,
          reportText: "{}",
          agents: AGENTS,
        });
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(CouldNotRunError);
        expect((e as Error).message).not.toContain("do-not-repeat");
      }
  });
});
