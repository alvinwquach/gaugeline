/**
 * The class of a model-call failure (AG-21 review, finding 1). What a failure IS is carried by its type, never
 * read from its message: only an outage (a timeout, a lost connection, a 5xx) may be tried on a second
 * provider. The gateway keeps the class the adapter gave, and a failure with no class is not an outage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CLASSES, GATEWAY_ERROR_CODES, ModelGatewayError } from "../errors.js";
import { createGateway } from "../gateway.js";
import type { BudgetHooks, ModelAdapter } from "../types.js";
import { CONFIG, KEY_NAME, PLAIN_KEY, REQUEST } from "./helpers.js";

describe("the failure class of an error", () => {
  it("is a closed list", () => {
    expect([...FAILURE_CLASSES]).toEqual([
      "outage",
      "rate-limited",
      "refused",
      "bad-key",
      "bad-request",
      "blocked-address",
      "redirect",
      "not-json",
      "bad-answer",
      "unclassified",
    ]);
  });

  it("is what the thrower said", () => {
    for (const f of FAILURE_CLASSES)
      expect(new ModelGatewayError("provider-error", "x", [], f).failure).toBe(f);
  });

  it("is an outage by default only for a timeout, and a bad answer for a bad answer", () => {
    for (const code of GATEWAY_ERROR_CODES) {
      const f = new ModelGatewayError(code, "x").failure;
      expect(f === "outage", code).toBe(code === "timeout");
      if (code === "bad-answer") expect(f).toBe("bad-answer");
      if (code === "provider-error") expect(f).toBe("unclassified");
    }
  });

  it("is never taken from the words of the message", () => {
    for (const words of ["503 timeout", "outage", "connection reset", "answered 502."])
      expect(new ModelGatewayError("provider-error", words).failure).toBe("unclassified");
  });
});

describe("the gateway keeps the class of what the adapter threw", () => {
  const through = async (thrown: () => unknown) => {
    const adapter: ModelAdapter = {
      provider: "test",
      needsKey: true,
      async complete() {
        throw thrown();
      },
    };
    const gateway = createGateway({
      config: CONFIG,
      adapters: [adapter],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    try {
      await gateway.complete(REQUEST);
    } catch (e) {
      return e as ModelGatewayError;
    }
    throw new Error("the call was expected to fail");
  };

  it.each(FAILURE_CLASSES)("passes %s through, with the same code", async (f) => {
    const e = await through(() => new ModelGatewayError("provider-error", "answered 401.", [], f));
    expect(e.code).toBe("provider-error");
    expect(e.failure).toBe(f);
  });

  it("makes a plain Error unclassified, whatever its message says", async () => {
    for (const words of ["503 timeout", "ETIMEDOUT", "service unavailable"]) {
      const e = await through(() => new Error(words));
      expect(e.code).toBe("provider-error");
      expect(e.failure).toBe("unclassified");
    }
  });

  it("makes something that is not an Error unclassified too", async () => {
    expect((await through(() => "503")).failure).toBe("unclassified");
    expect((await through(() => ({ failure: "outage" }))).failure).toBe("unclassified");
  });

  it("calls its own timeout an outage and its own bad answer a bad answer", async () => {
    const slow: ModelAdapter = {
      provider: "test",
      needsKey: true,
      complete: () => new Promise(() => undefined),
    };
    const g = createGateway({
      config: { ...CONFIG, timeoutMs: 100 },
      adapters: [slow],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    const t = await g.complete(REQUEST).catch((e: ModelGatewayError) => e);
    expect(t).toMatchObject({ code: "timeout", failure: "outage" });
    const odd: ModelAdapter = { provider: "test", needsKey: true, complete: async () => 5 };
    const g2 = createGateway({
      config: CONFIG,
      adapters: [odd],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    const b = await g2.complete(REQUEST).catch((e: ModelGatewayError) => e);
    expect(b).toMatchObject({ code: "bad-answer", failure: "bad-answer" });
  });
});

describe("a request's own time limit", () => {
  afterEach(() => vi.useRealTimers());
  /** A provider that never answers, but stops when it is told to, as the sender does. */
  const stuck: ModelAdapter = {
    provider: "test",
    needsKey: true,
    complete: ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(new ModelGatewayError("timeout", "the provider did not answer in time.")),
        ),
      ),
  };
  const gateway = (timeoutMs: number) =>
    createGateway({
      config: { ...CONFIG, timeoutMs },
      adapters: [stuck],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });

  it("shortens the call: the gateway stops it at the request's limit, not the config's", async () => {
    vi.useFakeTimers();
    const g = gateway(30_000);
    const done = g.complete({ ...REQUEST, timeoutMs: 2_000 }).catch((e: ModelGatewayError) => e);
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toMatchObject({ code: "timeout", failure: "outage" });
  });

  it("never lengthens it: a request limit over the config's is the config's", async () => {
    vi.useFakeTimers();
    const g = gateway(1_000);
    const done = g.complete({ ...REQUEST, timeoutMs: 60_000 }).catch((e: ModelGatewayError) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toMatchObject({ code: "timeout" });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5" as never])(
    "refuses a limit of %s before anything is sent",
    async (timeoutMs) => {
      const e = await gateway(1_000)
        .complete({ ...REQUEST, timeoutMs })
        .catch((x: ModelGatewayError) => x);
      expect(e).toMatchObject({ code: "bad-request" });
    },
  );
});

describe("the call's time covers the budget check, and an abort stops it before anything is sent", () => {
  afterEach(() => vi.useRealTimers());
  const adapterThatCounts = () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "test",
      needsKey: true,
      async complete() {
        calls += 1;
        return {
          text: "ok",
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 1, latencyMs: 1 },
        };
      },
    };
    return { adapter, calls: () => calls };
  };
  const gatewayWith = (adapter: ModelAdapter, budget?: BudgetHooks, timeoutMs = 30_000) =>
    createGateway({
      config: { ...CONFIG, timeoutMs },
      adapters: [adapter],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
      ...(budget ? { budget } : {}),
    });

  it("a budget check that outlasts the limit ends the call at the limit, and the adapter is never called, even late", async () => {
    vi.useFakeTimers();
    const slow: BudgetHooks = {
      before: () => new Promise((res) => setTimeout(() => res({ allowed: true }), 1_500)),
      after: () => undefined,
    };
    const { adapter, calls } = adapterThatCounts();
    const done = gatewayWith(adapter, slow)
      .complete({ ...REQUEST, timeoutMs: 1_000 })
      .catch((e: ModelGatewayError) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toMatchObject({ code: "timeout", failure: "outage" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toBe(0);
  });

  it("the config's own limit covers the budget check too", async () => {
    vi.useFakeTimers();
    const slow: BudgetHooks = {
      before: () => new Promise((res) => setTimeout(() => res({ allowed: true }), 5_000)),
      after: () => undefined,
    };
    const { adapter, calls } = adapterThatCounts();
    const done = gatewayWith(adapter, slow, 1_000)
      .complete(REQUEST)
      .catch((e: ModelGatewayError) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls()).toBe(0);
  });

  it("the budget check is told the call's limit", async () => {
    let seen: number | undefined;
    const { adapter } = adapterThatCounts();
    await gatewayWith(adapter, {
      before: (e) => ((seen = e.timeoutMs), { allowed: true }),
      after: () => undefined,
    }).complete({ ...REQUEST, timeoutMs: 4_000 });
    expect(seen).toBe(4_000);
  });

  it("a signal that is already aborted sends nothing", async () => {
    const { adapter, calls } = adapterThatCounts();
    const ctl = new AbortController();
    ctl.abort();
    const e = await gatewayWith(adapter)
      .complete({ ...REQUEST, signal: ctl.signal })
      .catch((x: ModelGatewayError) => x);
    expect(e).toMatchObject({ code: "timeout", failure: "outage" });
    expect(calls()).toBe(0);
  });

  it("a signal aborted while the budget check runs, and then allowed, still sends nothing (checked after the await)", async () => {
    const { adapter, calls } = adapterThatCounts();
    const ctl = new AbortController();
    const hook: BudgetHooks = {
      before: () => (ctl.abort(), { allowed: true }),
      after: () => undefined,
    };
    const e = await gatewayWith(adapter, hook)
      .complete({ ...REQUEST, signal: ctl.signal })
      .catch((x: ModelGatewayError) => x);
    expect(e).toMatchObject({ code: "timeout" });
    expect(calls()).toBe(0);
  });

  it("a signal aborted during the adapter call stops the adapter's own signal and ends the call", async () => {
    let theirs: AbortSignal | undefined;
    const adapter: ModelAdapter = {
      provider: "test",
      needsKey: true,
      complete: ({ signal }) => ((theirs = signal), new Promise(() => undefined)),
    };
    const ctl = new AbortController();
    const done = gatewayWith(adapter)
      .complete({ ...REQUEST, signal: ctl.signal })
      .catch((x: ModelGatewayError) => x);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    expect(await done).toMatchObject({ code: "timeout" });
    expect(theirs?.aborted).toBe(true);
  });

  it("refuses a signal that is not one", async () => {
    const { adapter, calls } = adapterThatCounts();
    for (const signal of ["x", {}, 5, { aborted: false }] as never[]) {
      const e = await gatewayWith(adapter)
        .complete({ ...REQUEST, signal })
        .catch((x: ModelGatewayError) => x);
      expect(e).toMatchObject({ code: "bad-request" });
    }
    expect(calls()).toBe(0);
  });

  it("leaves no timer and no listener behind after a call", async () => {
    vi.useFakeTimers();
    const { adapter } = adapterThatCounts();
    const ctl = new AbortController();
    await gatewayWith(adapter).complete({ ...REQUEST, signal: ctl.signal });
    expect(vi.getTimerCount()).toBe(0);
    ctl.abort(); // nothing is listening any more: no unhandled rejection
    await vi.advanceTimersByTimeAsync(1);
  });
});
