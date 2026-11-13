/**
 * Routing and escalation (AG-21): which tier a task uses, one escalation on a failed check, one fallback to a
 * second provider on an outage, a stop on budget, and an outcome that is never "pass". Gateways here are over
 * recorded or scripted adapters: no network, no key, no real clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { triage } from "../../evals/example/triage.js";
import type { EvalRecording } from "../../evals/types.js";
import { ModelGatewayError, type FailureClass, type GatewayErrorCode } from "../errors.js";
import { NO_BUDGET, createGateway } from "../gateway.js";
import { recordGateway } from "../recorded.js";
import { createBudgetLedger } from "../budget.js";
import {
  MAX_CALLS_PER_ROUTE,
  DEFAULT_ROUTE_DEADLINE_MS,
  FALLBACK_FAILURES,
  MODEL_TASKS,
  TASK_TIERS,
  agentAnswerCheck,
  createRouter as buildRouter,
  type AnswerCheck,
  type RouterOptions,
  type RouteRequest,
} from "../router.js";
import type { BudgetHooks, ModelAdapter, ModelGateway } from "../types.js";

/**
 * A router for the tests that have no budget to speak of: it says so with `unmetered`, which the router allows
 * only when no gateway has a budget. Tests of a metered router pass their budget and get the plain router.
 */
const createRouter = (gateways: Parameters<typeof buildRouter>[0], options: RouterOptions = {}) =>
  buildRouter(
    gateways,
    gateways.primary.budget === NO_BUDGET ? { unmetered: true, ...options } : options,
  );

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

type Step = EvalRecording | { fail: GatewayErrorCode | "plain" } | { error: () => unknown };
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
      if ("error" in step) throw step.error();
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
/** An adapter error of a class, the way the sender throws one: the code is provider-error, the class says what it was. */
const failing = (failure: FailureClass, message = "the provider answered.") => ({
  error: () => new ModelGatewayError("provider-error", message, [], failure),
});
const outage = (message = "api.example.test answered 503.") => failing("outage", message);
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
  it.each([
    ["a timeout", { fail: "timeout" } as Step],
    ["an outage the adapter classed (a 5xx, a lost connection)", outage()],
  ])("goes to the second provider on %s, with the same task, tier and prompt", async (_n, step) => {
    const a = provider("a", [step]);
    const b = provider("b", [rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "advisory", provider: "b", tier: "fast" });
    expect(b.calls[0]).toEqual({ model: "b-fast", callId: "route-1", prompt: REQ.prompt });
    if (r.kind === "advisory")
      expect(r.attempts.map((x) => [x.provider, x.outcome])).toEqual([
        ["a", "outage"],
        ["b", "accepted"],
      ]);
  });

  it("is unsure when both providers are out, after exactly two calls", async () => {
    const a = provider("a", [{ fail: "timeout" }]);
    const b = provider("b", [outage()]);
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

  it("can fall back during an escalation too: that is three calls, the most there is", async () => {
    const a = provider("a", [BAD, { fail: "timeout" }]);
    const b = provider("b", [rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "advisory", provider: "b", tier: "strong" });
    expect(a.calls.length + b.calls.length).toBe(MAX_CALLS_PER_ROUTE);
  });
});

describe("which failures fall back: by class, never by words (the payload goes to a second provider only after an outage)", () => {
  const code = (c: GatewayErrorCode, failure: FailureClass, message: string) => ({
    error: () => new ModelGatewayError(c, message, [], failure),
  });
  /** What the sender says for each status or error, by the class it gives it (docs/model-gateway.md). */
  const FALLS_BACK: Array<[string, Step]> = [
    ["a timeout", { fail: "timeout" }],
    ["a 500", failing("outage", "api.example.test answered 500.")],
    ["a 502", failing("outage", "api.example.test answered 502.")],
    ["a 503", failing("outage", "api.example.test answered 503.")],
    ["a 504", failing("outage", "api.example.test answered 504.")],
    [
      "a refused connection (ECONNREFUSED)",
      failing("outage", "could not be reached (ECONNREFUSED)"),
    ],
    ["a reset connection (ECONNRESET)", failing("outage", "could not be reached (ECONNRESET)")],
    [
      "a name that does not resolve (ENOTFOUND)",
      failing("outage", "could not be reached (ENOTFOUND)"),
    ],
    ["an outage whose words say 401", failing("outage", "401 unauthorized")],
    ["an outage whose words say content policy", failing("outage", "content policy refusal")],
  ];
  const STAYS: Array<[string, Step]> = [
    [
      "a 301 redirect",
      failing("redirect", "api.example.test answered a redirect, which is not followed."),
    ],
    ["a 400", failing("bad-request", "api.example.test answered 400.")],
    ["a 401", failing("bad-key", "api.example.test answered 401.")],
    ["a 403", failing("bad-key", "api.example.test answered 403.")],
    ["a 404", failing("refused", "api.example.test answered 404.")],
    ["a 408", failing("refused", "api.example.test answered 408.")],
    ["a 422", failing("bad-request", "api.example.test answered 422.")],
    ["a 429 rate limit", failing("rate-limited", "api.example.test answered 429.")],
    [
      "a private address",
      failing("blocked-address", "api.example.test is not a public address: nothing was sent"),
    ],
    ["a refusal whose words say 503 timeout", failing("refused", "503 timeout")],
    [
      "a provider body that contains 503",
      failing("refused", "api.example.test answered 400 and the body said 503"),
    ],
    [
      "a provider-error with no class and the words 'timeout'",
      code("provider-error", "unclassified", "timeout"),
    ],
    ["a plain Error", { fail: "plain" }],
    ["a plain Error whose message is '503 timeout'", { error: () => new Error("503 timeout") }],
    ["something thrown that is not an Error", { error: () => "503" }],
    [
      "an object that says it is an outage",
      { error: () => ({ failure: "outage", code: "timeout" }) },
    ],
  ];

  it.each(FALLS_BACK)("%s goes to the second provider, once", async (_n, step) => {
    const a = provider("a", [step, rec(GOOD)]);
    const b = provider("b", [rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(REQ, check);
    expect(r).toMatchObject({ kind: "advisory", provider: "b" });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it.each(STAYS)(
    "%s is refused: the payload is not sent to the second provider",
    async (_n, step) => {
      const a = provider("a", [step, rec(GOOD)]);
      const b = provider("b", [rec(GOOD)]);
      const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(
        REQ,
        check,
      );
      expect(r).toMatchObject({ kind: "unsure", reason: "refused" });
      expect(b.calls).toHaveLength(0);
      expect(a.calls).toHaveLength(1);
      if (r.kind === "unsure") expect(r.attempts.map((x) => x.outcome)).toEqual(["stopped"]);
    },
  );

  it("falls back on exactly one class, and on no other", () => {
    expect([...FALLBACK_FAILURES]).toEqual(["outage"]);
  });

  it("a malformed answer (not JSON, wrong shape) is a failed answer: strong tier on the same provider, never a fallback", async () => {
    for (const failure of ["not-json", "bad-answer"] as const) {
      const a = provider("a", [code("bad-answer", failure, "not JSON"), rec(GOOD)]);
      const b = provider("b", [rec(GOOD)]);
      const r = await createRouter({ primary: a.gateway(), fallback: b.gateway() }).route(
        REQ,
        check,
      );
      expect(r).toMatchObject({ kind: "advisory", provider: "a", tier: "strong" });
      expect(a.calls.map((c) => c.model)).toEqual(["a-fast", "a-strong"]);
      expect(b.calls).toHaveLength(0);
      if (r.kind === "advisory")
        expect(r.attempts.map((x) => x.outcome)).toEqual(["failed-checks", "accepted"]);
    }
  });

  it("a second malformed answer, or one from a strong task, is unsure and goes nowhere else", async () => {
    const twice = provider("a", [
      code("bad-answer", "not-json", "x"),
      code("bad-answer", "not-json", "x"),
    ]);
    const b = provider("b", [rec(GOOD)]);
    const r = await createRouter({ primary: twice.gateway(), fallback: b.gateway() }).route(
      REQ,
      check,
    );
    expect(r).toMatchObject({ kind: "unsure", reason: "failed-checks" });
    const strong = provider("a", [code("bad-answer", "not-json", "x"), rec(GOOD)]);
    const s = await createRouter({ primary: strong.gateway(), fallback: b.gateway() }).route(
      { ...REQ, task: "miner" },
      check,
    );
    expect(s).toMatchObject({ kind: "unsure", reason: "failed-checks" });
    expect(strong.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it("never reads the message: the same words fall back or not by class alone", async () => {
    for (const words of ["503", "timeout", "ECONNRESET", "401 unauthorized", "all is well"]) {
      const yes = provider("a", [failing("outage", words)]);
      const no = provider("a", [failing("refused", words)]);
      const b1 = provider("b", [rec(GOOD)]);
      const b2 = provider("b", [rec(GOOD)]);
      await createRouter({ primary: yes.gateway(), fallback: b1.gateway() }).route(REQ, check);
      await createRouter({ primary: no.gateway(), fallback: b2.gateway() }).route(REQ, check);
      expect([words, b1.calls.length, b2.calls.length]).toEqual([words, 1, 0]);
    }
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
    const r = await createRouter({
      primary: a.gateway(deny),
      fallback: b.gateway(deny),
    }).route(REQ, check);
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
    const a = provider("a", [outage("api.example.test answered 503 with a body")]);
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

describe("one budget for both gateways: a fallback cannot skip the ceilings", () => {
  const ledger = () =>
    createBudgetLedger({
      config: {
        ceilings: { perRunMicros: 5_000, perDayMicros: 100_000, perWorkspaceMicros: 100_000 },
        prices: {
          "a-fast": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 },
          "b-fast": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 },
          "a-strong": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 },
          "b-strong": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 },
        },
      },
      now: () => Date.UTC(2026, 10, 13, 12, 0, 0),
    });

  it("exposes the budget a gateway uses, and NO_BUDGET when it has none", () => {
    expect(provider("a", []).gateway().budget).toBe(NO_BUDGET);
    const mine = ledger().forRun("workspace-a");
    expect(provider("a", []).gateway(mine).budget).toBe(mine);
  });

  it("refuses to build a router whose fallback has no budget while the primary has one (the bypass)", () => {
    const run = ledger().forRun("workspace-a");
    const a = provider("a", [rec(GOOD)]);
    const b = provider("b", [rec(GOOD)]);
    expect(() => createRouter({ primary: a.gateway(run), fallback: b.gateway() })).toThrow(
      ModelGatewayError,
    );
    expect(() => createRouter({ primary: a.gateway(), fallback: b.gateway(run) })).toThrow(
      /the same budget/,
    );
    expect(a.calls.length + b.calls.length).toBe(0);
  });

  it("refuses two different budgets, even two runs of one ledger: they would each count only their own calls", () => {
    const l = ledger();
    const a = provider("a", []);
    const b = provider("b", []);
    expect(() =>
      createRouter({
        primary: a.gateway(l.forRun("workspace-a")),
        fallback: b.gateway(l.forRun("workspace-a")),
      }),
    ).toThrow(/the same budget/);
    expect(() =>
      createRouter({
        primary: a.gateway(ledger().forRun("workspace-a")),
        fallback: b.gateway(ledger().forRun("workspace-a")),
      }),
    ).toThrow(ModelGatewayError);
  });

  it("refuses a budget that only looks the same: a wrapper around the hooks is a different object", () => {
    const run = ledger().forRun("workspace-a");
    const wrapped = { before: (e: never) => run.before(e), after: (e: never) => run.after(e) };
    const a = provider("a", []);
    const b = provider("b", []);
    expect(() =>
      createRouter({ primary: a.gateway(run), fallback: b.gateway(wrapped as BudgetHooks) }),
    ).toThrow(ModelGatewayError);
  });

  it("builds when both gateways were made from the one budget object", () => {
    const run = ledger().forRun("workspace-a");
    const a = provider("a", []);
    const b = provider("b", []);
    expect(() => createRouter({ primary: a.gateway(run), fallback: b.gateway(run) })).not.toThrow();
  });

  it("refuses, by default, a router whose gateways have no budget at all: a budget is required unless said otherwise", () => {
    const a = provider("a", []);
    const b = provider("b", []);
    expect(() => buildRouter({ primary: a.gateway() })).toThrow(/needs a budget/);
    expect(() => buildRouter({ primary: a.gateway(), fallback: b.gateway() })).toThrow(
      /needs a budget/,
    );
    const run = ledger().forRun("workspace-a");
    expect(() => buildRouter({ primary: a.gateway(run), fallback: b.gateway(run) })).not.toThrow();
  });

  it("allows no budget only with `unmetered: true`, and refuses that when any budget is configured", () => {
    const a = provider("a", []);
    const b = provider("b", []);
    expect(() =>
      buildRouter({ primary: a.gateway(), fallback: b.gateway() }, { unmetered: true }),
    ).not.toThrow();
    const run = ledger().forRun("workspace-a");
    expect(() =>
      buildRouter({ primary: a.gateway(run), fallback: b.gateway(run) }, { unmetered: true }),
    ).toThrow(/unmetered.*budget/);
    expect(() => buildRouter({ primary: a.gateway(run) }, { unmetered: true })).toThrow(
      /unmetered.*budget/,
    );
    expect(() => buildRouter({ primary: a.gateway() }, { unmetered: true })).not.toThrow();
    for (const unmetered of [false, "yes" as never, 1 as never])
      expect(() => buildRouter({ primary: a.gateway() }, { unmetered })).toThrow(/needs a budget/);
  });

  describe("only a gateway made by createGateway is accepted: a hand-built one could be metered in name only", () => {
    const run = () => ledger().forRun("workspace-a");
    const free = () => provider("free", [rec(GOOD)]);

    it("refuses an object that borrows the real budget and brings its own, free, complete (the bypass)", async () => {
      const r = run();
      const real = provider("a", []).gateway(r);
      const f = free();
      const handBuilt = { provider: "a", budget: real.budget, complete: f.gateway().complete };
      expect(() => buildRouter({ primary: real, fallback: handBuilt })).toThrow(
        /made by createGateway/,
      );
      expect(() => buildRouter({ primary: handBuilt })).toThrow(ModelGatewayError);
      expect(f.calls).toHaveLength(0);
    });

    it.each([
      ["a copy by spread", (g: ModelGateway) => ({ ...g })],
      ["an object that inherits from it", (g: ModelGateway) => Object.create(g) as ModelGateway],
      ["a proxy of it", (g: ModelGateway) => new Proxy(g, {})],
      [
        "a wrapper that calls it",
        (g: ModelGateway) => ({ ...g, complete: (r: never) => g.complete(r) }),
      ],
      ["something that is not an object", () => "gateway" as never],
      ["null", () => null as never],
    ])("refuses %s", (_n, make) => {
      const r = run();
      const real = provider("a", []).gateway(r);
      expect(() => buildRouter({ primary: make(real) })).toThrow(ModelGatewayError);
      expect(() => buildRouter({ primary: real, fallback: make(real) })).toThrow(ModelGatewayError);
    });

    it("accepts the gateways createGateway made, and the recorded gateway's own wrapper is not one of them", () => {
      const r = run();
      const a = provider("a", []).gateway(r);
      const b = provider("b", []).gateway(r);
      expect(() => buildRouter({ primary: a, fallback: b })).not.toThrow();
      expect(() => buildRouter({ primary: recordGateway(a).gateway })).toThrow(
        /made by createGateway/,
      );
    });
  });

  it("counts the fallback's call against the same run: an outage then a fallback spends one ceiling", async () => {
    const run = ledger().forRun("workspace-a");
    const a = provider("a", [{ fail: "timeout" }]);
    const b = provider("b", [rec(GOOD), rec(GOOD)]);
    const prompt = "x".repeat(8_000);
    const r = await createRouter({ primary: a.gateway(run), fallback: b.gateway(run) }).route(
      { ...REQ, prompt },
      check,
    );
    expect(r.kind).toBe("advisory");
    // The failed call's worst case (1750) stays held, and the fallback's answer is charged beside it.
    expect(run.committedMicros()).toBeGreaterThan(1_750);
  });

  it("stops the fallback when the shared ceiling is spent by the call that failed", async () => {
    // Each call can cost up to 1780 (2000 tokens in, 1024 out at these prices): two do not fit in 2000.
    const run = createBudgetLedger({
      config: {
        ceilings: { perRunMicros: 2_000, perDayMicros: 100_000, perWorkspaceMicros: 100_000 },
        prices: {
          "a-fast": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 },
          "b-fast": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 },
        },
      },
      now: () => Date.UTC(2026, 10, 13, 12, 0, 0),
    }).forRun("workspace-a");
    const a = provider("a", [{ fail: "timeout" }]);
    const b = provider("b", [rec(GOOD)]);
    const out = await createRouter({ primary: a.gateway(run), fallback: b.gateway(run) }).route(
      { ...REQ, prompt: "x".repeat(8_000) },
      check,
    );
    expect(out).toMatchObject({ kind: "unsure", reason: "budget" });
    expect(b.calls).toHaveLength(0);
  });
});

describe("the most calls and the most time one task may take", () => {
  const GOODS = [rec(GOOD), rec(GOOD), rec(GOOD)];
  /** Every script of up to three steps for each provider, from a small alphabet of what a provider can do. */
  const ALPHABET: Array<[string, Step]> = [
    ["good", rec(GOOD)],
    ["bad", BAD],
    ["outage", outage()],
    ["refused", failing("bad-key")],
    ["malformed", { error: () => new ModelGatewayError("bad-answer", "x", [], "not-json") }],
  ];
  function* scripts(): Generator<[Array<[string, Step]>, Array<[string, Step]>]> {
    const per = (n: number): Array<[string, Step]>[] =>
      n === 0
        ? [[]]
        : ALPHABET.flatMap((x) => per(n - 1).map((rest) => [x, ...rest] as Array<[string, Step]>));
    for (const a of per(3)) for (const b of per(3)) yield [a, b];
  }
  const run = async (maxCalls?: number) => {
    let most = 0;
    let n = 0;
    for (const [sa, sb] of scripts()) {
      const a = provider(
        "a",
        sa.map(([, st]) => st),
      );
      const b = provider(
        "b",
        sb.map(([, st]) => st),
      );
      const r = await createRouter(
        { primary: a.gateway(), fallback: b.gateway() },
        maxCalls === undefined ? {} : { maxCalls },
      ).route(REQ, check);
      most = Math.max(most, a.calls.length + b.calls.length);
      n += 1;
      expect(["advisory", "unsure"]).toContain(r.kind);
    }
    return { most, n };
  };

  it("is three calls, and no script of answers and failures ever makes a fourth (15625 scripts)", async () => {
    expect(MAX_CALLS_PER_ROUTE).toBe(3);
    const { most, n } = await run();
    expect(n).toBe(15_625);
    expect(most).toBe(MAX_CALLS_PER_ROUTE);
  });

  it("can be set lower, and then the same worst case stops there with its own reason", async () => {
    for (const cap of [1, 2]) {
      const { most } = await run(cap);
      expect(most).toBe(cap);
    }
    const a = provider("a", [BAD, rec(GOOD)]);
    const r = await createRouter({ primary: a.gateway() }, { maxCalls: 1 }).route(REQ, check);
    expect(r).toMatchObject({ kind: "unsure", reason: "calls" });
    expect(a.calls).toHaveLength(1);
    expect(r.attempts).toHaveLength(1);
  });

  it("cannot be set higher than three, below one, or to anything but a whole number", () => {
    const a = provider("a", GOODS);
    for (const maxCalls of [
      0,
      4,
      1000,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "3" as never,
    ])
      expect(() => createRouter({ primary: a.gateway() }, { maxCalls }), String(maxCalls)).toThrow(
        ModelGatewayError,
      );
  });

  describe("the deadline: the time all the calls of a task may take together", () => {
    /** A clock the scripted providers move: call number i of a provider takes ms[i] milliseconds. */
    const world = () => {
      const t = { now: 1_000_000 };
      const make = (name: string, ms: number[], steps: Step[]) => {
        let i = 0;
        const calls: string[] = [];
        const adapter: ModelAdapter = {
          provider: name,
          needsKey: false,
          async complete(call) {
            calls.push(call.callId);
            t.now += ms[i] ?? 0;
            const step = steps[i++]!;
            if ("error" in step) throw step.error();
            return step as EvalRecording;
          },
        };
        const gateway = createGateway({
          config: { provider: name, tiers: { fast: `${name}-fast`, strong: `${name}-strong` } },
          adapters: [adapter],
          env: () => ({}),
        });
        return { gateway, calls };
      };
      return { t, make };
    };

    it("is two minutes by default", () => {
      expect(DEFAULT_ROUTE_DEADLINE_MS).toBe(120_000);
    });

    it("stops before the next call once the time spent reaches it, with its own reason", async () => {
      const w = world();
      const a = w.make("a", [30_000], [outage()]);
      const b = w.make("b", [30_000], [BAD, rec(GOOD)]);
      const r = await createRouter(
        { primary: a.gateway, fallback: b.gateway },
        { deadlineMs: 60_000, now: () => w.t.now },
      ).route(REQ, check);
      // The outage took 30s and the fallback 30s more, to the instant: the escalation never starts.
      expect(a.calls).toEqual(["route-1"]);
      expect(b.calls).toEqual(["route-1"]);
      expect(r).toMatchObject({ kind: "unsure", reason: "deadline" });
      expect(r.attempts.map((x) => x.outcome)).toEqual(["outage", "failed-checks"]);
    });

    it("lets the next call run while there is time left", async () => {
      const w = world();
      const a = w.make("a", [20_000, 20_000], [BAD, rec(GOOD)]);
      const r = await createRouter(
        { primary: a.gateway },
        { deadlineMs: 60_000, now: () => w.t.now },
      ).route(REQ, check);
      expect(r).toMatchObject({ kind: "advisory", tier: "strong" });
    });

    it("counts a fallback's time too: an outage that takes a minute leaves the second provider no time", async () => {
      const w = world();
      const a = w.make("a", [61_000], [outage()]);
      const b = w.make("b", [0], [rec(GOOD)]);
      const r = await createRouter(
        { primary: a.gateway, fallback: b.gateway },
        { deadlineMs: 60_000, now: () => w.t.now },
      ).route(REQ, check);
      expect(r).toMatchObject({ kind: "unsure", reason: "deadline" });
      expect(b.calls).toHaveLength(0);
      expect(r.attempts.map((x) => x.outcome)).toEqual(["outage"]);
    });

    it("measures from when the task started, not from the clock's own zero", async () => {
      const w = world();
      w.t.now = 9_000_000_000;
      const a = w.make("a", [10, 10], [BAD, rec(GOOD)]);
      const r = await createRouter(
        { primary: a.gateway },
        { deadlineMs: 60_000, now: () => w.t.now },
      ).route(REQ, check);
      expect(r.kind).toBe("advisory");
    });

    it("uses two minutes when none is given", async () => {
      const w = world();
      const a = w.make("a", [130_000], [outage()]);
      const b = w.make("b", [0], [rec(GOOD)]);
      const r = await createRouter(
        { primary: a.gateway, fallback: b.gateway },
        { now: () => w.t.now },
      ).route(REQ, check);
      expect(r).toMatchObject({ kind: "unsure", reason: "deadline" });
      expect(b.calls).toHaveLength(0);
    });

    it("fails closed when the clock gives nothing usable", async () => {
      const a = provider("a", [rec(GOOD)]);
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const r = await createRouter({ primary: a.gateway() }, { now: () => bad }).route(
          REQ,
          check,
        );
        expect(r).toMatchObject({ kind: "unsure", reason: "deadline" });
      }
      expect(a.calls).toHaveLength(0);
    });

    it("fails closed when the clock runs backwards: it does not give a task more time", async () => {
      const w = world();
      const a = w.make("a", [-500_000, 0], [BAD, rec(GOOD)]);
      const r = await createRouter(
        { primary: a.gateway },
        { deadlineMs: 60_000, now: () => w.t.now },
      ).route(REQ, check);
      expect(r).toMatchObject({ kind: "unsure", reason: "deadline" });
      expect(a.calls).toHaveLength(1);
    });

    describe("the deadline holds inside a call too, not only between calls", () => {
      afterEach(() => vi.useRealTimers());

      it("an answer that arrives after the deadline is not accepted (a 3 second call under a 1 second deadline), and its cost is kept", async () => {
        const w = world();
        const a = w.make("a", [3_000], [rec(GOOD, 777)]);
        const r = await createRouter(
          { primary: a.gateway },
          { deadlineMs: 1_000, now: () => w.t.now },
        ).route(REQ, check);
        expect(r).toMatchObject({ kind: "unsure", reason: "deadline", costMicros: 777 });
        expect(r.attempts.map((x) => x.outcome)).toEqual(["stopped"]);
      });

      it("accepts an answer that arrives exactly at the deadline, and refuses one a millisecond later", async () => {
        for (const [took, kind] of [
          [1_000, "advisory"],
          [1_001, "unsure"],
        ] as const) {
          const w = world();
          const a = w.make("a", [took], [rec(GOOD)]);
          const r = await createRouter(
            { primary: a.gateway },
            { deadlineMs: 1_000, now: () => w.t.now },
          ).route(REQ, check);
          expect([took, r.kind]).toEqual([took, kind]);
        }
      });

      it("starts no call at the instant the deadline is reached (the boundary is included)", async () => {
        const w = world();
        const a = w.make("a", [30_000, 0], [BAD, rec(GOOD)]);
        const r = await createRouter(
          { primary: a.gateway },
          { deadlineMs: 30_000, now: () => w.t.now },
        ).route(REQ, check);
        expect(r).toMatchObject({ kind: "unsure", reason: "deadline" });
        expect(a.calls).toHaveLength(1);
        // One millisecond short of it, the escalation still runs.
        const w2 = world();
        const a2 = w2.make("a", [29_999, 0], [BAD, rec(GOOD)]);
        const r2 = await createRouter(
          { primary: a2.gateway },
          { deadlineMs: 30_000, now: () => w2.t.now },
        ).route(REQ, check);
        expect(r2.kind).toBe("advisory");
      });

      /** A provider that takes `ms` to answer or to fail, and stops when told to (as the sender does). */
      const timed = (name: string, steps: Array<{ ms: number; then: Step }>) => {
        let i = 0;
        const started: number[] = [];
        const adapter: ModelAdapter = {
          provider: name,
          needsKey: false,
          complete: ({ signal }) => {
            const step = steps[i++]!;
            started.push(Date.now());
            return new Promise((resolve, reject) => {
              const t = setTimeout(() => {
                if ("error" in step.then) reject(step.then.error());
                else resolve(step.then);
              }, step.ms);
              signal.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new ModelGatewayError("timeout", `${name} did not answer in time.`));
              });
            });
          },
        };
        const gateway = createGateway({
          config: {
            provider: name,
            tiers: { fast: `${name}-fast`, strong: `${name}-strong` },
            timeoutMs: 120_000,
          },
          adapters: [adapter],
          env: () => ({}),
        });
        return { gateway, started };
      };

      it("cuts each call at the time left: three 60 second calls take 120 seconds, not 180", async () => {
        vi.useFakeTimers({ now: 5_000_000 });
        const a = timed("a", [{ ms: 60_000, then: outage() }]);
        const b = timed("b", [
          { ms: 59_000, then: BAD },
          { ms: 60_000, then: rec(GOOD) },
        ]);
        const t0 = Date.now();
        let at = -1;
        const done = createRouter(
          { primary: a.gateway, fallback: b.gateway },
          { deadlineMs: 120_000, now: () => Date.now() },
        )
          .route(REQ, check)
          .then((r) => ((at = Date.now() - t0), r));
        await vi.advanceTimersByTimeAsync(200_000);
        const r = await done;
        // Outage at 60s, the fallback fails the check at 119s, and the escalation has 1s left and is cut there.
        expect(r).toMatchObject({ kind: "unsure", reason: "deadline" });
        expect(at).toBe(120_000);
        expect(b.started.map((x) => x - t0)).toEqual([60_000, 119_000]);
        expect(r.attempts.map((x) => x.outcome)).toEqual(["outage", "failed-checks", "stopped"]);
      });

      it("ends the task at the deadline, to the millisecond, whatever each call would take", async () => {
        vi.useFakeTimers({ now: 5_000_000 });
        const a = timed("a", [{ ms: 600_000, then: rec(GOOD) }]);
        const t0 = Date.now();
        let at = -1;
        const done = createRouter(
          { primary: a.gateway },
          { deadlineMs: 2_000, now: () => Date.now() },
        )
          .route(REQ, check)
          .then((r) => ((at = Date.now() - t0), r));
        await vi.advanceTimersByTimeAsync(1_999);
        expect(at).toBe(-1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await done).toMatchObject({ kind: "unsure", reason: "deadline" });
        expect(at).toBe(2_000);
      });

      it("ends a gateway that never settles as unsure at the deadline: the router does not wait for it", async () => {
        vi.useFakeTimers({ now: 5_000_000 });
        const real = provider("a", [rec(GOOD)]).gateway();
        // Test only: a gateway whose own limit does not work, to show the router does not rely on it.
        Object.assign(real, { complete: () => new Promise<never>(() => undefined) });
        const t0 = Date.now();
        let at = -1;
        const done = createRouter({ primary: real }, { deadlineMs: 5_000, now: () => Date.now() })
          .route(REQ, check)
          .then((r) => ((at = Date.now() - t0), r));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await done).toMatchObject({ kind: "unsure", reason: "deadline" });
        expect(at).toBe(5_000);
      });

      it("passes the time left to the gateway, so the sender's own limit is the shorter of the two", async () => {
        const w = world();
        const spy = createGateway({
          config: { provider: "s", tiers: { fast: "s-fast", strong: "s-strong" } },
          adapters: [
            {
              provider: "s",
              needsKey: false,
              async complete() {
                w.t.now += 10_000;
                return BAD;
              },
            },
          ],
          env: () => ({}),
        });
        const limits: number[] = [];
        const inner = spy.complete;
        Object.assign(spy, {
          complete: (req: Parameters<typeof inner>[0]) => {
            limits.push(req.timeoutMs ?? -1);
            return inner(req);
          },
        });
        await createRouter({ primary: spy }, { deadlineMs: 60_000, now: () => w.t.now }).route(
          REQ,
          check,
        );
        expect(limits).toEqual([60_000, 50_000]);
      });
    });

    it.each([0, 999, 600_001, 1.5, Number.NaN, "60000" as never])(
      "refuses a deadline of %s",
      (deadlineMs) => {
        expect(() =>
          createRouter({ primary: provider("a", []).gateway() }, { deadlineMs }),
        ).toThrow(ModelGatewayError);
      },
    );

    it("has a default clock that works, so a router needs no option to have a deadline", async () => {
      const a = provider("a", [rec(GOOD)]);
      const r = await createRouter({ primary: a.gateway() }).route(REQ, check);
      expect(r.kind).toBe("advisory");
    });
  });
});
