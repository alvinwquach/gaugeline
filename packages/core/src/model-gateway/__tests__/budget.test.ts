/**
 * Budgets and estimates (AG-22): per-run, per-day and per-workspace ceilings checked BEFORE a call, against
 * the worst the call can cost; the cost of an answer from its token counts; a hard stop once a ceiling is hit;
 * and a pre-run estimate from payload size. Plain code with a handed-in clock: no model, no real time.
 */
import { describe, expect, it, vi } from "vitest";
import type { BudgetCeilings, BudgetConfigInput } from "../budget-config.js";
import {
  CHARS_PER_TOKEN,
  callCostMicros,
  createBudgetLedger,
  estimateInputTokens,
  estimateRun,
  traceFieldsOf,
  type SpendEntry,
} from "../budget.js";
import { ModelGatewayError } from "../errors.js";
import type { BudgetEstimate } from "../types.js";

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 10, 13, 12, 0, 0);
/** 1000 input tokens cost 250 micro-units and 1000 output tokens cost 1250 (invented prices). */
const PRICES = {
  "small-model": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 },
  "large-model": { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
};
const config = (
  ceilings: Partial<BudgetCeilings> = {},
  prices: BudgetConfigInput["prices"] = PRICES,
): BudgetConfigInput => ({
  ceilings: { perRunMicros: 10_000, perDayMicros: 20_000, perWorkspaceMicros: 40_000, ...ceilings },
  prices,
});

/** A call of 2000 input tokens and up to 1000 output tokens on the small model: at most 500 + 1250 = 1750. */
const est = (over: Partial<BudgetEstimate> = {}): BudgetEstimate => ({
  agentId: "triage",
  callId: "call-1",
  tier: "fast",
  provider: "test",
  model: "small-model",
  inputTokens: 2_000,
  maxOutputTokens: 1_000,
  ...over,
});
const usage = (inputTokens: number, outputTokens: number, costMicros = 0) => ({
  inputTokens,
  outputTokens,
  costMicros,
  latencyMs: 10,
});

function setup(
  ceilings: Partial<BudgetCeilings> = {},
  opts: { maxWorkspaces?: number; onSpend?: (e: SpendEntry) => void } = {},
) {
  const clock = { now: NOON };
  const ledger = createBudgetLedger({ config: config(ceilings), now: () => clock.now, ...opts });
  return { ledger, clock };
}

describe("what a call costs", () => {
  it("is the token counts times the model's prices, in whole micro-units, rounded up", () => {
    const p = PRICES["small-model"];
    expect(callCostMicros(p, 2_000, 1_000)).toBe(500 + 1_250);
    expect(callCostMicros(p, 1, 0)).toBe(1); // a fraction of a micro-unit is a whole one
    expect(callCostMicros(p, 0, 0)).toBe(0);
    expect(callCostMicros(p, 4, 4)).toBe(1 + 5);
  });

  it("is exact for very large counts (BigInt inside), and capped at the largest ceiling", () => {
    const big = { inputMicrosPerMTok: 10_000_000_000, outputMicrosPerMTok: 10_000_000_000 };
    expect(callCostMicros(big, 1_000_000, 0)).toBe(10_000_000_000);
    expect(callCostMicros(big, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(
      1_000_000_000_000,
    );
  });

  it("counts four characters to a token, rounded up", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect([0, 1, 4, 5, 8_000].map(estimateInputTokens)).toEqual([0, 1, 1, 2, 2_000]);
  });
});

describe("a ceiling is checked before the call, against the worst the call can cost", () => {
  it("allows a call whose worst case fits, and refuses one that would pass the ceiling by 1", async () => {
    const { ledger } = setup({ perRunMicros: 1_750 });
    const run = ledger.forRun("workspace-a");
    expect(await run.before(est())).toEqual({ allowed: true });
    const tight = setup({ perRunMicros: 1_749 }).ledger.forRun("workspace-a");
    const d = await tight.before(est());
    expect(d.allowed).toBe(false);
  });

  it("names the ceiling that stopped it, in fixed words and whole numbers", async () => {
    for (const [ceilings, scope] of [
      [{ perRunMicros: 1_000 }, "per-run"],
      [{ perDayMicros: 1_000 }, "per-day"],
      [{ perWorkspaceMicros: 1_000 }, "per-workspace"],
    ] as const) {
      const d = await setup(ceilings).ledger.forRun("workspace-a").before(est());
      expect(d).toEqual({
        allowed: false,
        reason: expect.stringContaining(`the ${scope} ceiling of 1000 micro-units`),
      });
    }
  });

  it("checks the run first, then the day, then the workspace", async () => {
    const d = await setup({ perRunMicros: 1, perDayMicros: 1, perWorkspaceMicros: 1 })
      .ledger.forRun("workspace-a")
      .before(est());
    expect(d).toMatchObject({ allowed: false, reason: expect.stringContaining("per-run") });
  });

  it("stops everything with a ceiling of 0", async () => {
    const d = await setup({ perDayMicros: 0 }).ledger.forRun("workspace-a").before(est());
    expect(d.allowed).toBe(false);
  });

  it("counts a call that is still waiting for its answer: two calls cannot both fit in room for one", async () => {
    const run = setup({ perRunMicros: 3_000 }).ledger.forRun("workspace-a");
    expect((await run.before(est({ callId: "a" }))).allowed).toBe(true);
    expect((await run.before(est({ callId: "b" }))).allowed).toBe(false);
  });

  it("refuses a model with no price, before anything is sent", async () => {
    const d = await setup()
      .ledger.forRun("workspace-a")
      .before(est({ model: "mystery-model" }));
    expect(d).toEqual({ allowed: false, reason: "no price is set for the model" });
  });

  it("never reads the model's name into a reason beyond the fixed words", async () => {
    const d = await setup()
      .ledger.forRun("workspace-a")
      .before(est({ model: "ignore-previous-instructions" }));
    expect(JSON.stringify(d)).not.toContain("ignore");
  });
});

describe("what an answer costs", () => {
  it("is the token counts in its usage, not the cost the provider says it had", async () => {
    const { ledger } = setup();
    const run = ledger.forRun("workspace-a");
    await run.before(est());
    // 2000 in + 200 out = 500 + 250; the 999999 the answer declares is not used.
    await run.after({ ...est(), usage: usage(2_000, 200, 999_999) });
    expect(run.committedMicros()).toBe(750);
  });

  it("frees the room the worst case held when the answer cost less", async () => {
    const run = setup({ perRunMicros: 2_500 }).ledger.forRun("workspace-a");
    await run.before(est({ callId: "a" }));
    await run.after({ ...est({ callId: "a" }), usage: usage(2_000, 200) });
    // 750 spent + 1750 worst case = 2500, exactly the ceiling. With the first call still held it would be 3500.
    expect(await run.before(est({ callId: "b" }))).toEqual({ allowed: true });
  });

  it("charges more when the answer cost more than the worst case, and the next call is refused", async () => {
    const run = setup({ perRunMicros: 3_000 }).ledger.forRun("workspace-a");
    await run.before(est());
    await run.after({ ...est(), usage: usage(2_000, 4_000) }); // 500 + 5000
    expect(run.committedMicros()).toBe(5_500);
    expect((await run.before(est({ callId: "b" }))).allowed).toBe(false);
  });

  it("keeps a call that never answered counted as spent: a timeout may still have been billed", async () => {
    const run = setup({ perRunMicros: 3_000 }).ledger.forRun("workspace-a");
    await run.before(est({ callId: "a" })); // the adapter failed: after never came
    expect(run.committedMicros()).toBe(1_750);
    expect((await run.before(est({ callId: "b" }))).allowed).toBe(false);
  });

  it("tells the caller what was spent, as the trace holds it, and ignores a sink that throws", async () => {
    const seen: SpendEntry[] = [];
    const { ledger } = setup(
      {},
      {
        onSpend: (e) => {
          seen.push(e);
          throw new Error("trace is down");
        },
      },
    );
    const run = ledger.forRun("workspace-a");
    await run.before(est());
    expect(() => run.after({ ...est(), usage: usage(2_000, 200) })).not.toThrow();
    expect(seen).toEqual([
      {
        agentId: "triage",
        callId: "call-1",
        tier: "fast",
        // Neither the provider nor the model is on the known list, so neither is shown, not even in part.
        provider: "[not on the known list]",
        model: "[not on the known list]",
        inputTokens: 2_000,
        outputTokens: 200,
        tokens: 2_200,
        costMicros: 750,
      },
    ]);
    expect(traceFieldsOf(seen[0]!)).toEqual({ tokens: 2_200, costMicros: 750 });
  });

  it("charges an answer that had no matching before, from its tokens", async () => {
    const run = setup().ledger.forRun("workspace-a");
    await run.after({ ...est(), usage: usage(2_000, 200) });
    expect(run.committedMicros()).toBe(750);
  });
});

describe("a hard stop", () => {
  it("stops a run at its first refusal: a later, cheaper call is refused too", async () => {
    const run = setup({ perRunMicros: 2_000 }).ledger.forRun("workspace-a");
    await run.before(est({ callId: "a" }));
    await run.after({ ...est({ callId: "a" }), usage: usage(2_000, 1_000) });
    expect((await run.before(est({ callId: "b" }))).allowed).toBe(false);
    expect(run.stopped()).toBe(true);
    const tiny = await run.before(est({ callId: "c", inputTokens: 1, maxOutputTokens: 1 }));
    expect(tiny).toEqual({
      allowed: false,
      reason: "the run was already stopped by a ceiling",
    });
  });

  it("stops only that run: another run in the same workspace starts fresh", async () => {
    const { ledger } = setup({ perRunMicros: 1_000 });
    const one = ledger.forRun("workspace-a");
    expect((await one.before(est())).allowed).toBe(false);
    expect(
      (await ledger.forRun("workspace-a").before(est({ inputTokens: 1, maxOutputTokens: 1 })))
        .allowed,
    ).toBe(true);
  });

  it("is not a stop for a model with no price: that is a setting to fix, not a ceiling", async () => {
    const run = setup().ledger.forRun("workspace-a");
    await run.before(est({ model: "mystery-model" }));
    expect(run.stopped()).toBe(false);
  });
});

describe("the three ceilings keep separate books", () => {
  it("the day is shared by every workspace and every run", async () => {
    const { ledger } = setup({ perDayMicros: 3_000 });
    expect((await ledger.forRun("workspace-a").before(est({ callId: "a" }))).allowed).toBe(true);
    const d = await ledger.forRun("workspace-b").before(est({ callId: "b" }));
    expect(d).toMatchObject({ allowed: false, reason: expect.stringContaining("per-day") });
  });

  it("the workspace is shared by its runs and not by other workspaces", async () => {
    const { ledger } = setup({ perWorkspaceMicros: 3_000 });
    expect((await ledger.forRun("workspace-a").before(est({ callId: "a" }))).allowed).toBe(true);
    const again = await ledger.forRun("workspace-a").before(est({ callId: "b" }));
    expect(again).toMatchObject({ allowed: false, reason: expect.stringContaining("workspace") });
    expect((await ledger.forRun("workspace-b").before(est({ callId: "c" }))).allowed).toBe(true);
  });

  it("the run counts only its own calls", async () => {
    const { ledger } = setup({ perRunMicros: 2_000 });
    expect((await ledger.forRun("workspace-a").before(est({ callId: "a" }))).allowed).toBe(true);
    expect((await ledger.forRun("workspace-a").before(est({ callId: "b" }))).allowed).toBe(true);
  });

  it("reports what each book holds", async () => {
    const { ledger } = setup();
    const a = ledger.forRun("workspace-a");
    await a.before(est());
    await a.after({ ...est(), usage: usage(2_000, 200) });
    await ledger.forRun("workspace-b").before(est({ callId: "b" }));
    expect(ledger.snapshot("workspace-a")).toEqual({
      day: "2026-11-13",
      dayMicros: 750 + 1_750,
      workspaceMicros: 750,
    });
    expect(ledger.snapshot("workspace-never-seen").workspaceMicros).toBe(0);
  });
});

describe("the day", () => {
  it("is a UTC day: the day's total starts again at midnight, the workspace's does not", async () => {
    const { ledger, clock } = setup({ perDayMicros: 2_000, perWorkspaceMicros: 4_000 });
    clock.now = Date.UTC(2026, 10, 13, 23, 59, 59, 999);
    const a = ledger.forRun("workspace-a");
    await a.before(est({ callId: "a" }));
    await a.after({ ...est({ callId: "a" }), usage: usage(2_000, 1_000) });
    expect((await ledger.forRun("workspace-a").before(est({ callId: "b" }))).allowed).toBe(false);
    clock.now = Date.UTC(2026, 10, 14, 0, 0, 0, 0);
    expect((await ledger.forRun("workspace-a").before(est({ callId: "c" }))).allowed).toBe(true);
    expect(ledger.snapshot("workspace-a")).toMatchObject({
      day: "2026-11-14",
      dayMicros: 1_750,
      workspaceMicros: 3_500,
    });
  });

  it("charges an answer that arrives after midnight to the new day, from its tokens", async () => {
    const { ledger, clock } = setup();
    clock.now = Date.UTC(2026, 10, 13, 23, 59, 59, 0);
    const run = ledger.forRun("workspace-a");
    await run.before(est());
    clock.now = Date.UTC(2026, 10, 14, 0, 0, 1, 0);
    await run.after({ ...est(), usage: usage(2_000, 200) });
    expect(ledger.snapshot("workspace-a")).toMatchObject({ day: "2026-11-14", dayMicros: 750 });
  });

  it("does not go back a day when the clock does: spend never vanishes", async () => {
    const { ledger, clock } = setup({ perDayMicros: 2_000 });
    const run = ledger.forRun("workspace-a");
    await run.before(est({ callId: "a" }));
    clock.now -= 3 * DAY;
    expect((await run.before(est({ callId: "b" }))).allowed).toBe(false);
    expect(ledger.snapshot("workspace-a").dayMicros).toBe(1_750);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "refuses when the clock gives %s",
    async (t) => {
      const { ledger, clock } = setup();
      clock.now = t;
      const d = await ledger.forRun("workspace-a").before(est());
      expect(d).toEqual({ allowed: false, reason: "the clock gave no usable time" });
    },
  );
});

describe("the ledger's own limits", () => {
  it("refuses a workspace id that is not an id", () => {
    const { ledger } = setup();
    for (const id of ["", " ", "a b", "x".repeat(200), "../etc", 5 as never]) {
      try {
        ledger.forRun(id);
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(ModelGatewayError);
        expect((e as ModelGatewayError).code).toBe("bad-request");
      }
    }
  });

  it("tracks a bounded number of workspaces and refuses the next, with the budget code", () => {
    const { ledger } = setup({}, { maxWorkspaces: 2 });
    ledger.forRun("workspace-a");
    ledger.forRun("workspace-b");
    ledger.forRun("workspace-a"); // a known one is fine
    try {
      ledger.forRun("workspace-c");
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ModelGatewayError).code).toBe("budget");
    }
  });

  it("holds at most 64 unanswered calls per run, then refuses", async () => {
    const run = setup({
      perRunMicros: 10 ** 9,
      perDayMicros: 10 ** 9,
      perWorkspaceMicros: 10 ** 9,
    }).ledger.forRun("workspace-a");
    for (let i = 0; i < 64; i += 1)
      expect((await run.before(est({ callId: `c${i}`, inputTokens: 1 }))).allowed).toBe(true);
    expect(await run.before(est({ callId: "one-more", inputTokens: 1 }))).toEqual({
      allowed: false,
      reason: "too many calls are waiting for an answer",
    });
  });

  it("refuses a config that is not valid when the ledger is built", () => {
    expect(() => createBudgetLedger({ config: { nope: 1 } as never, now: () => NOON })).toThrow(
      ModelGatewayError,
    );
  });

  it("uses no real clock: the time is the one handed in", async () => {
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    const { ledger } = setup();
    await ledger.forRun("workspace-a").before(est());
    spy.mockRestore();
  });
});

describe("the estimate before a run", () => {
  const plan = [
    { tier: "fast", model: "small-model", inputChars: 8_000, maxOutputTokens: 1_000 },
    { tier: "fast", model: "small-model", inputChars: 8_000, maxOutputTokens: 1_000 },
    { tier: "strong", model: "large-model", inputChars: 4_000, maxOutputTokens: 500 },
  ] as const;

  it("adds up the worst case of each planned call from the size of its payload", () => {
    const e = estimateRun(config(), plan);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.calls).toEqual([
      // A public field: a model that is not on the known list is the fixed text, never the configured id.
      {
        model: "[not on the known list]",
        inputTokens: 2_000,
        maxOutputTokens: 1_000,
        costMicros: 1_750,
      },
      {
        model: "[not on the known list]",
        inputTokens: 2_000,
        maxOutputTokens: 1_000,
        costMicros: 1_750,
      },
      {
        model: "[not on the known list]",
        inputTokens: 1_000,
        maxOutputTokens: 500,
        costMicros: 10_500,
      },
    ]);
    expect(e.inputTokens).toBe(5_000);
    expect(e.outputTokens).toBe(2_500);
    expect(e.costMicros).toBe(14_000);
  });

  it("is the same number the gateway will ask the budget about for the same payload", () => {
    const e = estimateRun(config(), [plan[0]]);
    expect(e.ok && e.calls[0]!.inputTokens).toBe(estimateInputTokens(8_000));
  });

  it("says which models have no price, and gives no cost", () => {
    const e = estimateRun(config(), [{ ...plan[0], model: "mystery-model" }]);
    expect(e).toEqual({ ok: false, unpriced: ["[not on the known list]"] });
    const known = estimateRun(config(), [{ ...plan[0], model: "example-large" }]);
    expect(known).toEqual({ ok: false, unpriced: ["example-large"] });
  });

  it("is zero for a run with no model call (deterministic agents cost nothing)", () => {
    expect(estimateRun(config(), [])).toMatchObject({ ok: true, calls: [], costMicros: 0 });
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses a payload size of %s",
    (n) => {
      expect(() => estimateRun(config(), [{ ...plan[0], inputChars: n }])).toThrow(
        ModelGatewayError,
      );
    },
  );
});

describe("starting a run: the hard stop before the first call", () => {
  const planned = (n: number) =>
    estimateRun(
      config(),
      Array.from({ length: n }, () => ({
        tier: "fast" as const,
        model: "small-model",
        inputChars: 8_000,
        maxOutputTokens: 1_000,
      })),
    );
  const ok = (n: number) => {
    const e = planned(n);
    if (!e.ok) throw new Error("unpriced");
    return e;
  };

  it("allows a run whose worst case fits every ceiling", () => {
    expect(setup().ledger.canStart("workspace-a", ok(2))).toEqual({ allowed: true });
  });

  it("refuses a run whose estimate is over the per-run ceiling, naming the figures", () => {
    const d = setup({ perRunMicros: 3_000 }).ledger.canStart("workspace-a", ok(2));
    expect(d).toEqual({
      allowed: false,
      reason: "the per-run ceiling of 3000 micro-units is below the estimate of 3500",
    });
  });

  it("refuses a run that would pass the day's or the workspace's room, counting what is spent", async () => {
    const { ledger } = setup({ perDayMicros: 5_000, perWorkspaceMicros: 4_000 });
    const a = ledger.forRun("workspace-a");
    await a.before(est());
    expect(ledger.canStart("workspace-b", ok(2))).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("per-day"),
    });
    expect(ledger.canStart("workspace-a", ok(1))).toMatchObject({ allowed: true });
    expect(ledger.canStart("workspace-a", ok(2))).toMatchObject({ allowed: false });
  });

  it("reserves nothing and records nothing", () => {
    const { ledger } = setup();
    ledger.canStart("workspace-a", ok(2));
    expect(ledger.snapshot("workspace-a")).toMatchObject({ dayMicros: 0, workspaceMicros: 0 });
  });

  it("refuses an estimate that has a model with no price", () => {
    const e = estimateRun(config(), [
      { tier: "fast", model: "mystery-model", inputChars: 1, maxOutputTokens: 1 },
    ]);
    expect(setup().ledger.canStart("workspace-a", e)).toEqual({
      allowed: false,
      reason: "the estimate has a model with no price",
    });
  });

  it("allows a run with no model call even when every ceiling is 0", () => {
    const { ledger } = setup({ perRunMicros: 0, perDayMicros: 0, perWorkspaceMicros: 0 });
    expect(ledger.canStart("workspace-a", ok(0))).toEqual({ allowed: true });
  });
});

describe("what the trace holds", () => {
  it("is the tokens and the cost of the call, whole numbers", () => {
    expect(
      traceFieldsOf({
        agentId: "triage",
        callId: "c",
        tier: "fast",
        provider: "test",
        model: "small-model",
        inputTokens: 10,
        outputTokens: 5,
        tokens: 15,
        costMicros: 3,
      }),
    ).toEqual({ tokens: 15, costMicros: 3 });
  });
});
