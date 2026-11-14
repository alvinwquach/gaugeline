/** With no request function given, the sender uses node:https: checked against a stand-in, so nothing connects. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

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
      res.statusCode = 201;
      res.headers = {};
      res.destroy = () => undefined;
      cb(res);
    };
    return req;
  },
}));

describe("the default transport", () => {
  it("is node:https, to api.github.com, as one POST, with the sender's own agent", async () => {
    const { createCommentSender } = await import("../send.js");
    const result = await createCommentSender()({
      token: "demo-token-A1b2C3d4E5f6G7h8I9j0",
      target: { owner: "brightside-studio", repo: "site", pullNumber: 7 },
      body: "hello",
    });
    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url.href}`)).toEqual([
      "POST https://api.github.com/repos/brightside-studio/site/issues/7/comments",
    ]);
    // Not the global agent, which carries Node's env proxy and would skip the address rule.
    expect(calls[0]!.agent).toBeInstanceOf(FakeAgent);
  });
});
