/**
 * The class of every way the sender can fail (AG-21 review, finding 1), and what the router does about each
 * with two providers. Only a timeout, a lost connection or a 5xx is an outage; everything else is refused and the
 * payload is not sent to a second provider. The class comes from the status or the error code, never from words:
 * a provider body or an Error message that says "503" or "timeout" changes nothing. Local servers only.
 */
import { EventEmitter } from "node:events";
import type { ClientRequest, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelGatewayError, type FailureClass } from "../errors.js";
import { issueGatedPayload } from "../gated.js";
import { ApiKey } from "../key.js";
import { createGateway } from "../gateway.js";
import { createRouter } from "../router.js";
import { createProviderAdapter, type NameResolver } from "../send.js";
import { KEY_NAME, PLAIN_KEY, REQUEST } from "./helpers.js";

const INPUT = { task: { template: "reword-findings" as const }, findings: [] };
import { hangingRequest, routeTo, startServer } from "./send-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CONFIG = {
  provider: "example",
  keyEnv: KEY_NAME,
  tiers: { fast: "small-model", strong: "large-model" },
  timeoutMs: 5_000,
};
const ANSWER = JSON.stringify({ text: "ok", usage: { input_tokens: 4, output_tokens: 2 } });
const reply = (res: ServerResponse, status: number, body = "{}", type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(body);
};
const over = (request: ReturnType<typeof routeTo>["request"]) =>
  createGateway({
    config: CONFIG,
    adapters: [createProviderAdapter("example", { request, now: () => 0 })],
    env: () => ({ [KEY_NAME]: PLAIN_KEY }),
  });
async function failure(p: Promise<unknown>): Promise<ModelGatewayError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelGatewayError);
    return e as ModelGatewayError;
  }
  throw new Error("the call was expected to fail");
}
/** A request function that fails with an error of this code, the way node:https does. */
const failingWith = (code: string | undefined, message = "connect failed") => ({
  request: (() => {
    const req = new EventEmitter() as ClientRequest;
    (req as unknown as { end(): void }).end = () =>
      req.emit("error", Object.assign(new Error(message), code === undefined ? {} : { code }));
    (req as unknown as { destroy(): void }).destroy = () => undefined;
    return req;
  }) as never,
});

/** Every status the sender may be answered with, and the class it gives it. */
const STATUSES: Array<[number, FailureClass]> = [
  [301, "redirect"],
  [302, "redirect"],
  [307, "redirect"],
  [400, "bad-request"],
  [401, "bad-key"],
  [403, "bad-key"],
  [404, "refused"],
  [408, "refused"],
  [409, "refused"],
  [418, "refused"],
  [422, "bad-request"],
  [429, "rate-limited"],
  [500, "outage"],
  [502, "outage"],
  [503, "outage"],
  [504, "outage"],
  [599, "outage"],
];

describe("the class of an HTTP answer, by its status", () => {
  it.each(STATUSES)("a %i is %s", async (status, failure_) => {
    const s = await startServer((_req, res) => {
      if (status >= 300 && status < 400) {
        res.writeHead(status, { location: "http://127.0.0.1:1/x" });
        return res.end();
      }
      reply(res, status);
    });
    const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
    await s.close();
    expect(e.code).toBe("provider-error");
    expect(e.failure).toBe(failure_);
  });

  it.each([
    ["a 400 whose body says 503", 400, "bad-request"],
    ["a 401 whose body says timeout", 401, "bad-key"],
    ["a 429 whose body says service unavailable", 429, "rate-limited"],
    ["a 503 whose body says content policy refusal", 503, "outage"],
    ["a 500 whose body says 401 unauthorized", 500, "outage"],
  ] as const)(
    "%s keeps the class of its status: the body is never read",
    async (_n, status, cls) => {
      const s = await startServer((_req, res) =>
        reply(res, status, JSON.stringify({ error: "503 timeout 401 service unavailable policy" })),
      );
      const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
      await s.close();
      expect(e.failure).toBe(cls);
    },
  );
});

describe("the class of an answer that is not usable", () => {
  it.each([
    ["a 200 with text that is not JSON", "<html>oops</html>", "application/json", "not-json"],
    ["a 200 with a content type that is not JSON", ANSWER, "text/html", "not-json"],
    [
      "a 200 with JSON in the wrong shape",
      JSON.stringify({ text: 4 }),
      "application/json",
      "bad-answer",
    ],
  ] as const)("%s is a bad answer of class %s", async (_n, body, type, cls) => {
    const s = await startServer((_req, res) => reply(res, 200, body, type));
    const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
    await s.close();
    expect(e.code).toBe("bad-answer");
    expect(e.failure).toBe(cls);
  });

  it("an answer that is too long is a bad answer", async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("x".repeat(300_000));
      res.end();
    });
    const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
    await s.close();
    expect(e).toMatchObject({ code: "bad-answer", failure: "bad-answer" });
  });
});

describe("the class of a connection error, by its code", () => {
  it.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
  ])("%s is an outage", async (code) => {
    const g = createGateway({
      config: CONFIG,
      adapters: [createProviderAdapter("example", failingWith(code))],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    const e = await failure(g.complete(REQUEST));
    expect(e).toMatchObject({ code: "provider-error", failure: "outage" });
  });

  it.each([
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "EACCES",
    "SOMETHING_ELSE",
    undefined,
  ])("%s is not an outage: it is unclassified, and not tried on another provider", async (code) => {
    const g = createGateway({
      config: CONFIG,
      adapters: [createProviderAdapter("example", failingWith(code))],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    expect((await failure(g.complete(REQUEST))).failure).toBe("unclassified");
  });

  it("is decided by the code and never by the message", async () => {
    for (const [code, message, cls] of [
      [undefined, "ECONNRESET 503 timeout connection reset", "unclassified"],
      ["CERT_HAS_EXPIRED", "503 timeout ECONNREFUSED", "unclassified"],
      ["ECONNRESET", "401 unauthorized policy refusal", "outage"],
    ] as const) {
      const g = createGateway({
        config: CONFIG,
        adapters: [createProviderAdapter("example", failingWith(code, message))],
        env: () => ({ [KEY_NAME]: PLAIN_KEY }),
      });
      expect((await failure(g.complete(REQUEST))).failure, message).toBe(cls);
    }
  });

  it("a name that resolves to a private address is blocked-address, not an outage", async () => {
    const adapter = createProviderAdapter("example", {
      resolve: ((_h, _o, cb) => cb(null, [{ address: "10.9.8.7", family: 4 }])) as NameResolver,
      request: (_url, options) => {
        const req = new EventEmitter() as ClientRequest;
        (req as unknown as { end(): void }).end = () => {
          (options.lookup as unknown as NameResolver)("api.example.test", {}, (err) =>
            req.emit("error", err),
          );
        };
        (req as unknown as { destroy(): void }).destroy = () => undefined;
        return req;
      },
    });
    const g = createGateway({
      config: CONFIG,
      adapters: [adapter],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    expect((await failure(g.complete(REQUEST))).failure).toBe("blocked-address");
  });

  it("an answer that ends early is an outage", async () => {
    const s = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      res.write("{");
      setTimeout(() => req.socket.destroy(), 5);
    });
    const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
    await s.close();
    expect(e.failure).toBe("outage");
  });

  it("a timeout is an outage", async () => {
    vi.useFakeTimers();
    const { request } = hangingRequest();
    const done = failure(over(request).complete(REQUEST));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await done).toMatchObject({ code: "timeout", failure: "outage" });
  });
});

describe("what the sender refuses before any request", () => {
  it("a prompt over the cap is input-too-large and a whole page is bad-request, never an outage", async () => {
    const adapter = createProviderAdapter("example", failingWith("ECONNRESET"));
    const call = (prompt: string) =>
      adapter.complete({
        model: "m",
        prompt: issueGatedPayload(prompt),
        callId: "c",
        maxOutputTokens: 5,
        signal: new AbortController().signal,
        key: new ApiKey(PLAIN_KEY),
      });
    const big = await call("x".repeat(20_000)).catch((e: ModelGatewayError) => e);
    expect(big).toMatchObject({ code: "input-too-large", failure: "bad-request" });
    const page = await call("<html><body>hi</body></html>").catch((e: ModelGatewayError) => e);
    expect(page).toMatchObject({ code: "bad-request", failure: "bad-request" });
  });
});

describe("two providers: the payload goes to the second one only after an outage", () => {
  /** A router over two local servers, each behind its own sender. Returns how many requests each saw. */
  async function twoProviders(first: (res: ServerResponse) => void, second = ANSWER) {
    const a = await startServer((_req, res) => first(res));
    const b = await startServer((_req, res) => reply(res, 200, second));
    const router = createRouter(
      { primary: over(routeTo(a.port).request), fallback: over(routeTo(b.port).request) },
      { unmetered: true },
    );
    const check = (answer: { text: string }) => ({ ok: true as const, value: answer.text });
    const r = await router.route(
      { task: "wording", agentId: "triage", callId: "route-1", input: INPUT },
      check,
    );
    const seen = { a: a.hits.length, b: b.hits.length };
    await a.close();
    await b.close();
    return { r, seen };
  }

  it.each(STATUSES.filter(([s]) => s < 300 || s >= 400))(
    "a %i from the first provider: the second %s",
    async (status, cls) => {
      const { r, seen } = await twoProviders((res) => reply(res, status));
      expect(seen.a).toBe(1);
      if (cls === "outage") {
        expect(seen.b).toBe(1);
        expect(r.kind).toBe("advisory");
      } else {
        expect(seen.b).toBe(0);
        expect(r).toMatchObject({ kind: "unsure", reason: "refused" });
      }
    },
  );

  it("a redirect from the first provider is not followed and not tried elsewhere", async () => {
    const { r, seen } = await twoProviders((res) => {
      res.writeHead(307, { location: "http://127.0.0.1:1/x" });
      res.end();
    });
    expect(seen).toEqual({ a: 1, b: 0 });
    expect(r).toMatchObject({ kind: "unsure", reason: "refused" });
  });

  it("a 200 that is not JSON is a failed answer: the first provider's strong tier, never the second provider", async () => {
    const { r, seen } = await twoProviders((res) => reply(res, 200, "not json at all"));
    expect(seen.b).toBe(0);
    expect(seen.a).toBe(2); // the fast call and the escalation, both on the first provider
    expect(r).toMatchObject({ kind: "unsure", reason: "failed-checks" });
  });
});

describe("the sender's own time limit is the shorter of its own and the time the task has left", () => {
  it("a request that never answers is cut at the router's deadline, not at the sender's 60 seconds", async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const { request, destroyed } = hangingRequest();
    const g = createGateway({
      config: { ...CONFIG, timeoutMs: 120_000 },
      adapters: [createProviderAdapter("example", { request })],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    const t0 = Date.now();
    let at = -1;
    const done = createRouter({ primary: g }, {
      deadlineMs: 2_000,
      now: () => Date.now(),
      unmetered: true,
    } as never)
      .route(
        { task: "wording", agentId: "triage", callId: "r", input: INPUT },
        (a: { text: string }) => ({ ok: true as const, value: a.text }),
      )
      .then((r) => ((at = Date.now() - t0), r));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await done).toMatchObject({ kind: "unsure", reason: "deadline" });
    expect(at).toBe(2_000);
    expect(destroyed()).toBe(1);
  });
});
