/**
 * The privacy gate on the AG-09 harness (AG-23): the golden cases pass with the real gate, every known-bad case
 * is caught by the assertion written for it, and taking a guard out of the gate turns a golden case red.
 * Offline: the replay and the gate itself, no network, no key, no real clock.
 */
import { describe, expect, it } from "vitest";
import { runEvals } from "../../evals/run.js";
import type { EvalModel } from "../../evals/types.js";
import { EVAL_SETS } from "../../evals/registry.js";
import {
  DEFAULT_PAYLOAD_PARTS,
  DEFAULT_REDACTION_RULES,
  REDACTION_KINDS,
  buildPayloadWith,
} from "../privacy.js";
import { evalInputToModelInput } from "../eval-bridge.js";
import {
  MODEL_PRIVACY_GATE_ID,
  createModelPrivacyGateModel,
  modelPrivacyGateAgent,
  modelPrivacyGateCases,
} from "../privacy-evals.js";

const run = () =>
  runEvals(modelPrivacyGateAgent, modelPrivacyGateCases, createModelPrivacyGateModel());

describe("the gate's eval set", () => {
  it("passes every golden case with the real gate and catches every known-bad case", async () => {
    const report = await run();
    expect(report.problems).toEqual([]);
    expect(report.golden).toEqual({ total: 5, passed: 5 });
    expect(report.knownBad).toEqual({ total: 11, caught: 11 });
    expect(report.ok).toBe(true);
    expect(report.costMicros).toBe(60_000);
  });

  it("catches each known-bad case with the assertion written for it", async () => {
    const report = await run();
    for (const c of modelPrivacyGateCases) {
      if (c.kind !== "known-bad") continue;
      const r = report.results.find((x) => x.caseId === c.id)!;
      expect(r.status, c.id).toBe("caught");
      const failed = r.assertions.filter((a) => a.status === "fail").map((a) => a.id);
      for (const id of c.catches) expect(failed, c.id).toContain(id);
    }
  });

  it("is in the suite `gaugeline evals` runs", () => {
    expect(EVAL_SETS.map((s) => s.agentId)).toContain(MODEL_PRIVACY_GATE_ID);
  });

  it("has a golden case that refuses a whole page, and its answer sends nothing", async () => {
    const model = createModelPrivacyGateModel();
    const a = await model.complete({
      caseId: "golden-whole-page-is-refused",
      agentId: MODEL_PRIVACY_GATE_ID,
      prompt: "",
    });
    expect(JSON.parse(a.text)).toEqual({ refused: true, payload: "" });
  });

  it("covers every kind of redaction in the golden cases: none of them is left in the payload", async () => {
    const seen = new Set<string>();
    for (const c of modelPrivacyGateCases.filter((x) => x.kind === "golden")) {
      const r = buildPayloadWith(evalInputToModelInput(c.input), DEFAULT_PAYLOAD_PARTS);
      if (r.ok) for (const k of REDACTION_KINDS) if (r.record.redactions[k] > 0) seen.add(k);
    }
    for (const k of ["hidden-characters", "secret", "iban", "card", "phone"])
      expect(seen.has(k), k).toBe(true);
  });
});

describe("mutation-style: a gate with a guard removed turns the golden cases red", () => {
  /** The shipped model, except that golden cases are answered by a gate built from `parts`. */
  const gateWith = (parts: Parameters<typeof buildPayloadWith>[1]): EvalModel => {
    const shipped = createModelPrivacyGateModel();
    return {
      async complete(req) {
        const c = modelPrivacyGateCases.find((x) => x.id === req.caseId)!;
        if (c.kind !== "golden") return shipped.complete(req);
        const r = buildPayloadWith(evalInputToModelInput(c.input), parts);
        return {
          text: JSON.stringify(
            r.ok ? { refused: false, payload: r.payload } : { refused: true, payload: "" },
          ),
          usage: { inputTokens: 0, outputTokens: 0, costMicros: 0, latencyMs: 1 },
        };
      },
    };
  };
  const cases = modelPrivacyGateCases;

  it("is green with the real parts", async () => {
    const r = await runEvals(modelPrivacyGateAgent, cases, gateWith(DEFAULT_PAYLOAD_PARTS));
    expect(r.golden).toEqual({ total: 5, passed: 5 });
    expect(r.ok).toBe(true);
  });

  // The iban rule is left out here: its digits are also taken by the phone rule, so a payload without it still
  // looks clean to the harness's leak check. privacy.test.ts proves the iban rule on its own, with a fixture
  // that survives only when that rule is gone.
  it.each(["hidden-characters", "secret", "card", "email", "phone"])(
    "is red with the %s rule removed",
    async (kind) => {
      const r = await runEvals(
        modelPrivacyGateAgent,
        cases,
        gateWith({
          ...DEFAULT_PAYLOAD_PARTS,
          // The allowlist is a layer of its own: it is off, so that the rule under test is the only guard.
          allowed: () => true,
          redactions: DEFAULT_REDACTION_RULES.filter((x) => x.kind !== kind),
        }),
      );
      expect(r.golden.passed, kind).toBeLessThan(5);
      expect(r.ok, kind).toBe(false);
    },
  );

  it("is red with the page check removed", async () => {
    const r = await runEvals(
      modelPrivacyGateAgent,
      cases,
      gateWith({
        ...DEFAULT_PAYLOAD_PARTS,
        allowed: () => true,
        pageCheck: () => ({ reason: null, tags: 0 }),
      }),
    );
    expect(r.golden.passed).toBeLessThan(5);
    expect(r.ok).toBe(false);
  });
});
