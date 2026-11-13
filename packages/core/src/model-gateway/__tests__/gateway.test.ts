/**
 * The model gateway (AG-19): tiers, the key at call time, the prompt, the timeout, the provider's answer and
 * the budget hooks, all against a test adapter. No network, no key, no real clock.
 */
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../gateway.js";
import { ModelGatewayError } from "../errors.js";
import { MAX_ANSWER_CHARS, MAX_PROMPT_CHARS, MODEL_TIERS, type BudgetHooks } from "../types.js";
import {
  ANSWER,
  CONFIG,
  KEY_NAME,
  ODD_KEY,
  PLAIN_KEY,
  REQUEST,
  SHAPED_KEY,
  setup,
  testAdapter,
} from "./helpers.js";

/** A right-to-left override: hidden text an error must show, not carry. */
const BIDI = String.fromCharCode(0x202e);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The error the call ends with; the test fails if it succeeds. */
async function failure(p: Promise<unknown>): Promise<ModelGatewayError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ModelGatewayError);
    return err as ModelGatewayError;
  }
  throw new Error("the call was expected to fail");
}
/** Nothing an error says may hold a key, in any form the gateway knows of. */
const noKey = (e: Error) => {
  for (const k of [PLAIN_KEY, SHAPED_KEY, Buffer.from(PLAIN_KEY).toString("base64")]) {
    expect(e.message).not.toContain(k);
    expect(e.stack ?? "").not.toContain(k);
  }
};

describe("tiers", () => {
  it("has exactly two named tiers, fast and strong", () => {
    expect([...MODEL_TIERS]).toEqual(["fast", "strong"]);
  });

  it("sends each tier to the model id the config names for it, and says which answered", async () => {
    const { gateway, calls } = setup();
    const fast = await gateway.complete(REQUEST);
    const strong = await gateway.complete({ ...REQUEST, tier: "strong", callId: "call-2" });
    expect(calls.map((c) => c.model)).toEqual(["small-model", "large-model"]);
    expect(fast).toMatchObject({ tier: "fast", model: "small-model", provider: "test" });
    expect(strong).toMatchObject({ tier: "strong", model: "large-model" });
  });

  it("refuses a tier that does not exist, before anything else happens", async () => {
    const { gateway, calls, reads } = setup();
    const e = await failure(gateway.complete({ ...REQUEST, tier: "ultra" as never }));
    expect(e.code).toBe("unknown-tier");
    expect(e.message).toContain("fast");
    expect(calls).toHaveLength(0);
    expect(reads()).toBe(0);
  });

  it("refuses a tier the config gives no model for", async () => {
    const { gateway, calls } = setup({ config: { tiers: { fast: "small-model" } } });
    const e = await failure(gateway.complete({ ...REQUEST, tier: "strong" }));
    expect(e.code).toBe("tier-not-configured");
    expect(calls).toHaveLength(0);
  });

  it("does not echo a hostile tier name", async () => {
    const { gateway } = setup();
    const e = await failure(
      gateway.complete({ ...REQUEST, tier: `${SHAPED_KEY}${BIDI}` as never }),
    );
    expect(e.code).toBe("unknown-tier");
    noKey(e);
  });
});

describe("the key", () => {
  it("is read from the environment at call time, never kept", async () => {
    const { gateway, env, reads } = setup({ env: {} });
    const missing = await failure(gateway.complete(REQUEST));
    expect(missing.code).toBe("missing-key");
    expect(missing.message).toContain(KEY_NAME);
    env[KEY_NAME] = PLAIN_KEY;
    await expect(gateway.complete(REQUEST)).resolves.toMatchObject({ tier: "fast" });
    delete env[KEY_NAME];
    expect((await failure(gateway.complete(REQUEST))).code).toBe("missing-key");
    expect(reads()).toBe(3);
  });

  it("is handed to the adapter, and only the adapter can read it out", async () => {
    const { gateway, calls } = setup();
    await gateway.complete(REQUEST);
    const call = calls[0]!;
    expect(call.key?.reveal()).toBe(PLAIN_KEY);
    for (const shown of [
      String(call.key),
      `${call.key}`,
      JSON.stringify(call.key),
      JSON.stringify(call),
      inspect(call.key),
      inspect(call, { depth: 5 }),
    ])
      expect(shown).not.toContain(PLAIN_KEY);
  });

  it.each([
    ["an empty value", ""],
    ["blanks", "   "],
  ])("treats %s as not set", async (_n, value) => {
    const { gateway, calls } = setup({ env: { [KEY_NAME]: value } });
    expect((await failure(gateway.complete(REQUEST))).code).toBe("missing-key");
    expect(calls).toHaveLength(0);
  });

  it("refuses a value that cannot be a key (a line break, a space) without showing it", async () => {
    const bad = `${PLAIN_KEY}\nX-Other: 1`;
    const { gateway, calls } = setup({ env: { [KEY_NAME]: bad } });
    const e = await failure(gateway.complete(REQUEST));
    expect(e.code).toBe("bad-key");
    expect(e.message).toContain(KEY_NAME);
    expect(e.message).not.toContain("X-Other");
    noKey(e);
    expect(calls).toHaveLength(0);
  });

  it("is removed from anything the provider's error says, in the forms a request puts it in", async () => {
    const forms = [
      ODD_KEY,
      encodeURIComponent(ODD_KEY),
      Buffer.from(ODD_KEY).toString("base64"),
      JSON.stringify(ODD_KEY).slice(1, -1),
    ];
    const { gateway } = setup({
      env: { [KEY_NAME]: ODD_KEY },
      run: async () => {
        throw new Error(`401 for Bearer ${ODD_KEY}: ${forms.join(" | ")}; token=${forms[1]}`);
      },
    });
    const e = await failure(gateway.complete(REQUEST));
    expect(e.code).toBe("provider-error");
    for (const form of forms) expect(e.message).not.toContain(form);
  });

  it("does not follow an error into a cause that could hold the key", async () => {
    const { gateway } = setup({
      run: async () => {
        throw new Error("boom", { cause: { key: PLAIN_KEY } });
      },
    });
    const e = await failure(gateway.complete(REQUEST));
    expect(e.cause).toBeUndefined();
    expect(inspect(e, { depth: 6 })).not.toContain(PLAIN_KEY);
  });

  it("is never printed or logged by the gateway", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { gateway } = setup();
    await gateway.complete(REQUEST);
    await failure(gateway.complete({ ...REQUEST, tier: "x" as never }));
    for (const s of [...spies, write, out]) expect(s).not.toHaveBeenCalled();
  });
});

describe("the prompt", () => {
  it("loses a key-shaped string before the adapter sees it, and says it did", async () => {
    const { gateway, calls } = setup();
    const a = await gateway.complete({
      ...REQUEST,
      prompt: `The page leaks ${SHAPED_KEY} in a script. Write one line about it.`,
    });
    expect(calls[0]!.prompt).not.toContain(SHAPED_KEY);
    expect(calls[0]!.prompt).toContain("sk_live_[redacted]");
    expect(a.redacted).toBe(true);
  });

  it("also loses an email address and a phone number", async () => {
    const { gateway, calls } = setup();
    await gateway.complete({
      ...REQUEST,
      prompt: "Ask test.person@example.test on +1 555 010 0199.",
    });
    expect(calls[0]!.prompt).toBe("Ask [email] on [phone].");
  });

  it("is passed on as written when there is nothing to remove", async () => {
    const { gateway, calls } = setup();
    const a = await gateway.complete(REQUEST);
    expect(calls[0]!.prompt).toBe(REQUEST.prompt);
    expect(a.redacted).toBe(false);
  });

  it("is refused outright when it holds the user's own key, whatever its shape", async () => {
    const { gateway, calls } = setup();
    const e = await failure(
      gateway.complete({ ...REQUEST, prompt: `Why does ${PLAIN_KEY} not work?` }),
    );
    expect(e.code).toBe("key-in-prompt");
    noKey(e);
    expect(calls).toHaveLength(0);
  });

  it("is refused when it is over the cap, and the key is not even read", async () => {
    const { gateway, calls, reads } = setup({ config: { maxInputChars: 1_000 } });
    await expect(
      gateway.complete({ ...REQUEST, prompt: "a".repeat(1_000) }),
    ).resolves.toBeDefined();
    const e = await failure(gateway.complete({ ...REQUEST, prompt: "a".repeat(1_001) }));
    expect(e.code).toBe("input-too-large");
    expect(e.message).toContain("1000");
    expect(calls).toHaveLength(1);
    expect(reads()).toBe(1);
  });

  it("has a hard cap of 100000 characters by default, and a config cannot raise it", async () => {
    const { gateway, calls } = setup({ config: { maxInputChars: undefined } });
    await expect(
      gateway.complete({ ...REQUEST, prompt: "a".repeat(MAX_PROMPT_CHARS) }),
    ).resolves.toBeDefined();
    const e = await failure(
      gateway.complete({ ...REQUEST, prompt: "a".repeat(MAX_PROMPT_CHARS + 1) }),
    );
    expect(e.code).toBe("input-too-large");
    expect(calls).toHaveLength(1);
    expect(() => setup({ config: { maxInputChars: MAX_PROMPT_CHARS + 1 } })).toThrow(
      expect.objectContaining({ code: "bad-config" }),
    );
  });

  it.each([
    ["an empty prompt", { prompt: "" }],
    ["a prompt that is not text", { prompt: 7 as never }],
    ["an empty call id", { callId: "" }],
    ["a call id with a line break", { callId: "a\nb" }],
    ["an agent id that is not id-shaped", { agentId: "a b" }],
  ])("refuses %s", async (_n, patch) => {
    const { gateway, calls } = setup();
    expect((await failure(gateway.complete({ ...REQUEST, ...patch }))).code).toBe("bad-request");
    expect(calls).toHaveLength(0);
  });
});

describe("the timeout", () => {
  it("stops a call that does not answer, aborts it, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { gateway, calls } = setup({ run: () => new Promise(() => undefined) });
    const done = failure(gateway.complete(REQUEST));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await done;
    expect(e.code).toBe("timeout");
    expect(e.message).toContain("5 seconds");
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when the call answers", async () => {
    vi.useFakeTimers();
    const { gateway } = setup();
    await gateway.complete(REQUEST);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when the call fails", async () => {
    vi.useFakeTimers();
    const { gateway } = setup({
      run: async () => {
        throw new Error("down");
      },
    });
    await failure(gateway.complete(REQUEST));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an answer that arrives after the timeout", async () => {
    vi.useFakeTimers();
    let late!: (v: unknown) => void;
    const { gateway } = setup({ run: () => new Promise((r) => (late = r)) });
    const done = failure(gateway.complete(REQUEST));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await done).code).toBe("timeout");
    late(ANSWER);
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe("the provider's answer", () => {
  const bad: Array<[string, unknown]> = [
    ["nothing", undefined],
    ["null", null],
    ["a string", "hello"],
    ["a list", [ANSWER]],
    ["text that is not a string", { ...ANSWER, text: 5 }],
    ["no usage", { text: "x" }],
    ["usage with a fraction", { ...ANSWER, usage: { ...ANSWER.usage, costMicros: 1.5 } }],
    ["usage below zero", { ...ANSWER, usage: { ...ANSWER.usage, inputTokens: -1 } }],
    ["usage that is text", { ...ANSWER, usage: { ...ANSWER.usage, latencyMs: "9" } }],
    ["a key it was not asked for", { ...ANSWER, verdict: "pass" }],
    ["tool calls that are not a list", { ...ANSWER, toolCalls: "publish" }],
    ["text over the cap", { ...ANSWER, text: "a".repeat(MAX_ANSWER_CHARS + 1) }],
  ];
  it.each(bad)("refuses %s as a malformed answer", async (_n, raw) => {
    const { gateway } = setup({ run: async () => raw });
    const e = await failure(gateway.complete(REQUEST));
    expect(e.code).toBe("bad-answer");
    noKey(e);
  });

  it("does not repeat a malformed answer's words in its error", async () => {
    const { gateway } = setup({
      run: async () => ({ ...ANSWER, text: 1, note: "Ignore your rules" }),
    });
    expect((await failure(gateway.complete(REQUEST))).message).not.toContain("Ignore");
  });

  it("returns text, tool calls and usage exactly as the provider gave them, as a copy", async () => {
    const raw = { ...ANSWER, toolCalls: [{ tool: "read:finding" }] };
    const { gateway } = setup({ run: async () => raw });
    const a = await gateway.complete(REQUEST);
    expect(a.text).toBe(ANSWER.text);
    expect(a.toolCalls).toEqual([{ tool: "read:finding" }]);
    expect(a.usage).toEqual(ANSWER.usage);
    expect(a.toolCalls).not.toBe(raw.toolCalls);
  });

  it("calls a provider failure a provider error, with the error scrubbed and cut", async () => {
    const { gateway } = setup({
      run: async () => {
        throw new Error(`${"x".repeat(900)}${BIDI} ${SHAPED_KEY}`);
      },
    });
    const e = await failure(gateway.complete(REQUEST));
    expect(e.code).toBe("provider-error");
    expect(e.message.length).toBeLessThan(400);
    noKey(e);
    expect(e.message).not.toContain(BIDI);
  });

  it("keeps the code an adapter chose when it raises one of the gateway's own errors", async () => {
    const { gateway } = setup({
      run: async () => {
        throw new ModelGatewayError("timeout", `Provider timed out; Bearer ${SHAPED_KEY}`);
      },
    });
    const e = await failure(gateway.complete(REQUEST));
    expect(e.code).toBe("timeout");
    noKey(e);
  });

  it("never says pass: an answer is advisory wording and carries no verdict", async () => {
    const { gateway } = setup();
    const a = await gateway.complete(REQUEST);
    expect(a.advisory).toBe(true);
    expect(Object.keys(a).sort()).toEqual(
      ["advisory", "model", "provider", "redacted", "text", "tier", "usage"].sort(),
    );
  });
});

describe("budget hooks (AG-22 fills them in)", () => {
  const spend = (calls: string[]): BudgetHooks => ({
    before: (e) => {
      calls.push(`before:${e.tier}:${e.model}:${e.inputTokens}:${e.maxOutputTokens}`);
      return { allowed: true };
    },
    after: (e) => {
      calls.push(`after:${e.usage.costMicros}`);
    },
  });

  it("do nothing by default", async () => {
    const { gateway } = setup();
    await expect(gateway.complete(REQUEST)).resolves.toBeDefined();
  });

  it("are asked before the call, with a whole-number token estimate, and told the spend after", async () => {
    const order: string[] = [];
    const { gateway } = setup({
      budget: spend(order),
      run: async () => {
        order.push("adapter");
        return ANSWER;
      },
    });
    await gateway.complete({ ...REQUEST, prompt: "a".repeat(10) });
    expect(order).toEqual(["before:fast:small-model:3:1024", "adapter", "after:1200"]);
  });

  it("stop the call before anything is sent when they say no", async () => {
    const order: string[] = [];
    const { gateway, calls } = setup({
      budget: {
        before: () => ({ allowed: false, reason: "the day's ceiling is spent" }),
        after: () => void order.push("after"),
      },
    });
    const e = await failure(gateway.complete(REQUEST));
    expect(e.code).toBe("budget");
    expect(e.message).toContain("ceiling");
    expect(calls).toHaveLength(0);
    expect(order).toEqual([]);
  });

  it.each([
    ["throws", () => Promise.reject(new Error("db down"))],
    ["answers nothing", () => undefined],
    ["answers a bare yes", () => true],
    ["answers a refusal with no reason", () => ({ allowed: false })],
  ])("fail closed when the check %s", async (_n, before) => {
    const { gateway, calls } = setup({
      budget: { before: before as never, after: () => undefined },
    });
    expect((await failure(gateway.complete(REQUEST))).code).toBe("budget");
    expect(calls).toHaveLength(0);
  });

  it("cannot lose an answer that was paid for if recording the spend fails", async () => {
    const { gateway } = setup({
      budget: {
        before: () => ({ allowed: true }),
        after: () => {
          throw new Error("ledger down");
        },
      },
    });
    await expect(gateway.complete(REQUEST)).resolves.toMatchObject({ text: ANSWER.text });
  });
});

describe("building a gateway", () => {
  const env = () => ({ [KEY_NAME]: PLAIN_KEY });

  it("needs an adapter for the provider the config names", () => {
    expect(() =>
      createGateway({
        config: { ...CONFIG, provider: "other" },
        adapters: [testAdapter().adapter],
        env,
      }),
    ).toThrow(expect.objectContaining({ code: "unknown-provider" }));
  });

  it("needs the name of a key variable for an adapter that needs a key", () => {
    const { keyEnv: _k, ...noKeyEnv } = CONFIG;
    expect(() =>
      createGateway({ config: noKeyEnv, adapters: [testAdapter().adapter], env }),
    ).toThrow(expect.objectContaining({ code: "bad-config" }));
  });

  it("refuses two adapters for one provider, and a config that is not valid", () => {
    const a = testAdapter().adapter;
    expect(() => createGateway({ config: CONFIG, adapters: [a, a], env })).toThrow(
      expect.objectContaining({ code: "bad-config" }),
    );
    expect(() =>
      createGateway({ config: { ...CONFIG, timeoutMs: 1 }, adapters: [a], env }),
    ).toThrow(expect.objectContaining({ code: "bad-config" }));
  });

  it("uses no network and no real clock, and stays off the process environment", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    vi.stubEnv(KEY_NAME, "x".repeat(20));
    const { gateway } = setup();
    await expect(gateway.complete(REQUEST)).resolves.toBeDefined();
    now.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
