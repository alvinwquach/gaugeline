/**
 * The class of a model-call failure (AG-21 review, finding 1). What a failure IS is carried by its type, never
 * read from its message: only an outage (a timeout, a lost connection, a 5xx) may be tried on a second
 * provider. The gateway keeps the class the adapter gave, and a failure with no class is not an outage.
 */
import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES, GATEWAY_ERROR_CODES, ModelGatewayError } from "../errors.js";
import { createGateway } from "../gateway.js";
import type { ModelAdapter } from "../types.js";
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
