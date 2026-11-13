/**
 * Routing and escalation (AG-21): which tier a task uses, one escalation on a failed check, one fallback to a
 * second provider on an outage, a stop on budget, and an outcome that is never "pass". Gateways here are over
 * recorded or scripted adapters: no network, no key, no real clock.
 */
import { describe, expect, it } from "vitest";
import { triage } from "../../evals/example/triage.js";
import type { EvalRecording } from "../../evals/types.js";
import { ModelGatewayError, type GatewayErrorCode } from "../errors.js";
import { createGateway } from "../gateway.js";
import {
  MAX_CALLS_PER_ROUTE,
  MODEL_TASKS,
  OUTAGE_CODES,
  TASK_TIERS,
  agentAnswerCheck,
  createRouter,
  type AnswerCheck,
  type RouteRequest,
} from "../router.js";
import type { BudgetHooks, ModelAdapter } from "../types.js";

const usage = (costMicros = 100) => ({
  inputTokens: 10,
  outputTokens: 5,
  costMicros,
  latencyMs: 50,
});
const GOOD = JSON.stringify({
  groups: [
    {
      cause: "No canonical link",
      priority: "fix-first",
      findingIds: ["f-101", "f-103"],
      summary: "Add a canonical link.",
    },
  ],
});
const CASE = triage.cases.find((c) => c.id === "bad-missing-id")!;
const BAD = triage.recordings.get("bad-missing-id")!;

type Step = EvalRecording | { fail: GatewayErrorCode | "plain" };
/** A scripted provider: one step per call, in order. Records the tier's model, call id and prompt of each call. */
function provider(name: string, steps: Step[]) {
  const calls: Array<{ model: string; callId: string; prompt: string }> = [];
  const adapter: ModelAdapter = {
    provider: name,
    needsKey: false,
    async complete(call) {
      calls.push({ model: call.model, callId: call.callId, prompt: call.prompt });
      const step = steps[calls.length - 1];
      if (!step) throw new Error("the script ran out");
      if ("fail" in step) {
        if (step.fail === "plain") throw new Error("down");
        throw new ModelGatewayError(step.fail, `scripted ${step.fail}`);
      }
      return step;
    },
  };
  const gateway = (budget?: BudgetHooks) =>
    createGateway({
      config: { provider: name, tiers: { fast: `${name}-fast`, strong: `${name}-strong` } },
      adapters: [adapter],
      env: () => ({}),
      ...(budget ? { budget } : {}),
    });
  return { calls, gateway };
}
const rec = (text: string, cost = 100): EvalRecording => ({ text, usage: usage(cost) });
const REQ: RouteRequest = {
  task: "wording",
  agentId: "triage",
  callId: "route-1",
  prompt: "Group these findings.",
};
const check = agentAnswerCheck(triage.agent, CASE.input);

describe("the tier for a task", () => {
  it("is fast for wording and strong for the check writer and the miner", () => {
    expect({ ...TASK_TIERS }).toEqual({
      wording: "fast",
      "check-writer": "strong",
      miner: "strong",
    });
    expect([...MODEL_TASKS]).toEqual(["wording", "check-writer", "miner"]);
    expect(Object.isFrozen(TASK_TIERS)).toBe(true);
  });

  it.each([
    ["wording", "p-fast"],
    ["check-writer", "p-strong"],
    ["miner", "p-strong"],
  ] as const)("sends %s to the %s model", async (task, model) => {
    const p = provider("p", [rec(GOOD)]);
    const r = await createRouter({ primary: p.gateway() }).route({ ...REQ, task }, check);
    expect(r.kind).toBe("advisory");
    expect(p.calls.map((c) => c.model)).toEqual([model]);
  });

  it("refuses a task that is not on the list, without a call", async () => {
    const p = provider("p", [rec(GOOD)]);
    const r = await createRouter({ primary: p.gateway() }).route(
      { ...REQ, task: "decide" as never },
      check,
    );
    expect(r).toMatchObject({ kind: "unsure", reason: "refused" });
    expect(p.calls).toHaveLength(0);
  });
});

describe("an answer that passes the checks", () => {
  it("is advisory, with the typed value, the cost and one attempt", async () => {
    const p = provider("p", [rec(GOOD, 250)]);
    const r = await createRouter({ primary: p.gateway() }).route(REQ, check);
    expect(r).toMatchObject({
      kind: "advisory",
      tier: "fast",
      provider: "p",
      costMicros: 250,
      attempts: [{ tier: "fast", provider: "p", outcome: "accepted", costMicros: 250 }],
    });
    if (r.kind === "advisory") expect(r.value).toEqual({ groups: expect.any(Array) });
  });

  it("never says pass: the only outcomes are advisory and unsure", async () => {
    const p = provider("p", [rec(GOOD)]);
    const r = await createRouter({ primary: p.gateway() }).route(REQ, check);
    expect(["advisory", "unsure"]).toContain(r.kind);
    expect(JSON.stringify(r)).not.toMatch(/"(pass|ok|passed|verdict)"/);
  });
});

describe("escalation: once, from fast to strong, on a failed check", () => {
  it("retries the same task on the strong tier with the plain reasons, and accepts a good answer", async () => {
    const p = provider("p", [BAD, rec(GOOD)]);
    const r = await createRouter({ primary: p.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "advisory", tier: "strong" });
    expect(p.calls.map((c) => [c.model, c.callId])).toEqual([
      ["p-fast", "route-1"],
      ["p-strong", "route-1:escalated"],
    ]);
    if (r.kind === "advisory")
      expect(r.attempts.map((a) => a.outcome)).toEqual(["failed-checks", "accepted"]);
  });

  it("puts the failed checks in the second prompt as data, and never the model's first answer", async () => {
    const p = provider("p", [
      { ...BAD, text: `${BAD.text.slice(0, -1)} ,"note":"FIRST-ANSWER-WORDS"}` },
      rec(GOOD),
    ]);
    await createRouter({ primary: p.gateway() }).route(REQ, check);
    const second = p.calls[1]!.prompt;
    expect(second.startsWith(REQ.prompt)).toBe(true);
    expect(second).toMatch(/failed these checks/);
    expect(second).toMatch(/cited-ids|schema/);
    expect(second).not.toContain("FIRST-ANSWER-WORDS");
    expect(second.length).toBeLessThan(REQ.prompt.length + 1_000);
  });

  it("stops after one escalation: a second failure is unsure, with both costs counted", async () => {
    const p = provider("p", [BAD, rec("not json", 300)]);
    const r = await createRouter({ primary: p.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "unsure", reason: "failed-checks" });
    expect(p.calls).toHaveLength(2);
    expect(r.costMicros).toBe(BAD.usage.costMicros + 300);
  });

  it("does not escalate a strong task: there is no higher tier, so one failed answer is unsure", async () => {
    const p = provider("p", [BAD, rec(GOOD)]);
    const r = await createRouter({ primary: p.gateway() }).route({ ...REQ, task: "miner" }, check);
    expect(r).toMatchObject({ kind: "unsure", reason: "failed-checks" });
    expect(p.calls).toHaveLength(1);
  });

  it("is unsure when the strong tier is not configured, rather than guessing", async () => {
    const only = provider("q", [BAD]);
    const g = createGateway({
      config: { provider: "q", tiers: { fast: "q-fast" } },
      adapters: [
        { provider: "q", needsKey: false, complete: async (c) => (only.calls.push(c), BAD) },
      ],
      env: () => ({}),
    });
    const r = await createRouter({ primary: g }).route(REQ, check);
    expect(r).toMatchObject({ kind: "unsure", reason: "refused" });
    expect(only.calls).toHaveLength(1);
  });

  it("treats a check that throws as a failed check, not a crash", async () => {
    const p = provider("p", [rec(GOOD), rec(GOOD)]);
    const boom: AnswerCheck<unknown> = () => {
      throw new Error("check broke");
    };
    const r = await createRouter({ primary: p.gateway() }).route(REQ, boom);
    expect(r).toMatchObject({ kind: "unsure", reason: "failed-checks" });
    expect(JSON.stringify(r)).not.toContain("check broke");
  });

  it("cleans and bounds the reasons it passes on: at most five, 120 characters each", async () => {
    const many: AnswerCheck<unknown> = () => ({
      ok: false,
      issues: Array.from({ length: 9 }, (_, i) => `issue ${i} \u0007 ${"x".repeat(300)}`),
    });
    const p = provider("p", [rec(GOOD), rec(GOOD)]);
    await createRouter({ primary: p.gateway() }).route(REQ, many);
    const lines = p.calls[1]!.prompt.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(5);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(124);
      expect(l).not.toContain("\u0007");
    }
  });
});

describe("fallback: once, to a second provider, on an outage", () => {
  it.each(OUTAGE_CODES)(
    "goes to the second provider on %s, with the same task, tier and prompt",
    async (code) => {
      const a = provider("a", [{ fail: code === "provider-error" ? "plain" : code }]);
      const b = provider("b", [rec(GOOD)]);
      const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(
        REQ,
        check,
      );
      expect(r).toMatchObject({ kind: "advisory", provider: "b", tier: "fast" });
      expect(b.calls[0]).toEqual({ model: "b-fast", callId: "route-1", prompt: REQ.prompt });
      if (r.kind === "advisory")
        expect(r.attempts.map((x) => [x.provider, x.outcome])).toEqual([
          ["a", "outage"],
          ["b", "accepted"],
        ]);
    },
  );

  it("is unsure when both providers are out, after exactly two calls", async () => {
    const a = provider("a", [{ fail: "timeout" }]);
    const b = provider("b", [{ fail: "plain" }]);
    const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "unsure", reason: "outage" });
    expect(a.calls.length + b.calls.length).toBe(2);
  });

  it("is unsure on an outage with no second provider, and does not retry the first", async () => {
    const a = provider("a", [{ fail: "timeout" }, rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "unsure", reason: "outage" });
    expect(a.calls).toHaveLength(1);
  });

  it.each([
    "missing-key",
    "bad-key",
    "key-in-prompt",
    "input-too-large",
    "bad-request",
    "tier-not-configured",
  ] as const)(
    "does not fall back on %s: a second provider would hit the same problem, or the person's own key",
    async (code) => {
      const a = provider("a", [{ fail: code }]);
      const b = provider("b", [rec(GOOD)]);
      const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(
        REQ,
        check,
      );
      expect(r).toMatchObject({ kind: "unsure", reason: "refused" });
      expect(b.calls).toHaveLength(0);
    },
  );

  it("escalates on the provider that answered: after a fallback, a failed check goes to the second provider's strong model", async () => {
    const a = provider("a", [{ fail: "timeout" }]);
    const b = provider("b", [BAD, rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "advisory", provider: "b", tier: "strong" });
    expect(b.calls.map((c) => c.model)).toEqual(["b-fast", "b-strong"]);
  });

  it("can fall back during an escalation too, and never makes more than four calls", async () => {
    const a = provider("a", [BAD, { fail: "timeout" }]);
    const b = provider("b", [rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "advisory", provider: "b", tier: "strong" });
    expect(MAX_CALLS_PER_ROUTE).toBe(4);
    expect(a.calls.length + b.calls.length).toBeLessThanOrEqual(MAX_CALLS_PER_ROUTE);
  });
});

describe("budget: a stop, not a retry (AG-22 fills the hook in)", () => {
  const deny: BudgetHooks = {
    before: () => ({ allowed: false, reason: "the ceiling is spent" }),
    after: () => undefined,
  };

  it("stops at once, with no fallback and no escalation", async () => {
    const a = provider("a", [rec(GOOD)]);
    const b = provider("b", [rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway(deny), fallback: b.gateway() }).route(
      REQ,
      check,
    );
    expect(r).toMatchObject({ kind: "unsure", reason: "budget" });
    expect(a.calls.length + b.calls.length).toBe(0);
  });

  it("stops an escalation that the budget refuses, keeping the first answer's cost", async () => {
    let n = 0;
    const second: BudgetHooks = {
      before: () =>
        ++n > 1 ? { allowed: false, reason: "the ceiling is spent" } : { allowed: true },
      after: () => undefined,
    };
    const a = provider("a", [BAD, rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway(second) }).route(REQ, check);
    expect(r).toMatchObject({ kind: "unsure", reason: "budget", costMicros: BAD.usage.costMicros });
    expect(a.calls).toHaveLength(1);
  });
});

describe("the outcome carries no key and no provider words", () => {
  it("an outage's detail is fixed words, not the provider's error", async () => {
    const a = provider("a", [{ fail: "plain" }]);
    const r = await createRouter({ primary: a.gateway() }).route(REQ, check);
    expect(r.kind === "unsure" && r.detail).toBe(
      "The provider could not be reached or did not answer in time.",
    );
  });

  it("is deterministic: the same script gives the same outcome twice", async () => {
    const run = async () =>
      JSON.stringify(
        await createRouter({ primary: provider("p", [BAD, rec(GOOD)]).gateway() }).route(
          REQ,
          check,
        ),
      );
    expect(await run()).toBe(await run());
  });
});

describe("agentAnswerCheck: the AG-09 assertions on a live answer", () => {
  const verdict = (text: string, calls?: Array<{ tool: string }>) =>
    agentAnswerCheck(
      triage.agent,
      CASE.input,
    )({
      text,
      ...(calls ? { toolCalls: calls } : {}),
      usage: usage(),
      provider: "p",
      model: "m",
      tier: "fast",
      advisory: true,
      redacted: false,
    });

  it("accepts an answer in the schema that cites real ids and invents no number", async () => {
    expect(await verdict(GOOD)).toMatchObject({ ok: true });
  });

  it.each([
    ["not JSON", "oops", /JSON/],
    ["a bad schema", '{"groups":"x"}', /groups/],
    ["a finding id that is not in the input", BAD.text, /cited-ids/],
    [
      "an invented number",
      JSON.stringify({
        groups: [
          {
            cause: "Traffic",
            priority: "fix-soon",
            findingIds: ["f-101"],
            summary: "Costs 4821 visits a month.",
          },
        ],
      }),
      /no-invented-numbers/,
    ],
  ])("refuses %s, with the reason", async (_n, text, why) => {
    const v = await verdict(text);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.issues.join(" ")).toMatch(why);
  });

  it("refuses a tool call that writes or is not allowed", async () => {
    const v = await verdict(GOOD, [{ tool: "publish_site" }]);
    expect(v.ok === false && v.issues.join(" ")).toMatch(/no-write-call/);
  });
});
