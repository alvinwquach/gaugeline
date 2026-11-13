/** With no request function given, the sender uses node:https: checked against a stand-in, so nothing connects. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { KEY_NAME, PLAIN_KEY, REQUEST } from "./helpers.js";

const { calls, FakeAgent } = vi.hoisted(() => ({
  calls: [] as Array<{ url: URL; method?: string; agent?: unknown }>,
  FakeAgent: class {},
}));
vi.mock("node:https", () => ({
  Agent: FakeAgent,
  globalAgent: { global: true },
  request: (
    url: URL,
    options: { method?: string; agent?: unknown },
    cb: (res: unknown) => void,
  ) => {
    calls.push({ url, method: options.method, agent: options.agent });
    const req = new EventEmitter() as EventEmitter & { end(b: Buffer): void; destroy(): void };
    req.destroy = () => undefined;
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: object;
        destroy(): void;
      };
      res.statusCode = 200;
      res.headers = { "content-type": "application/json" };
      res.destroy = () => undefined;
      cb(res);
      res.emit(
        "data",
        Buffer.from(JSON.stringify({ text: "ok", usage: { input_tokens: 1, output_tokens: 1 } })),
      );
      res.emit("end");
    };
    return req;
  },
}));

describe("the default transport", () => {
  it("is node:https, to the allowlisted address, as a POST", async () => {
    const { createGateway } = await import("../gateway.js");
    const { createProviderAdapter } = await import("../send.js");
    const g = createGateway({
      config: { provider: "example", keyEnv: KEY_NAME, tiers: { fast: "small-model" } },
      adapters: [createProviderAdapter("example")],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    expect((await g.complete(REQUEST)).text).toBe("ok");
    expect(calls.map((c) => `${c.method} ${c.url.href}`)).toEqual([
      "POST https://api.example.test/v1/complete",
    ]);
  });

  it("gives the request its own agent, never the global one that carries Node's env proxy", () => {
    expect(calls[0]!.agent).toBeInstanceOf(FakeAgent);
  });
});
