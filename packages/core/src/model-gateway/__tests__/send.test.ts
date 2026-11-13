/**
 * The one module that sends a model request (AG-19 part 2, ADR-0005 as amended). Every test runs against a
 * request function the test hands in: a real client request to a server on a loopback address, or one that
 * never answers. Nothing here reaches a provider, a DNS server or a real key.
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { ClientRequest, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scan } from "../../__tests__/post-scan.js";
import { ModelGatewayError } from "../errors.js";
import { ApiKey } from "../key.js";
import { createGateway } from "../gateway.js";
import {
  HARD_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  MAX_RESPONSE_BYTES,
  PROVIDER_HOSTS,
  createProviderAdapter,
  type NameResolver,
} from "../send.js";
import { KEY_NAME, PLAIN_KEY, REQUEST, SHAPED_KEY } from "./helpers.js";
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
const ANSWER = {
  text: "Point the link at the live menu.",
  usage: { input_tokens: 40, output_tokens: 10 },
};
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/** A gateway over the sender, with the key in a mutable environment. */
function over(
  request: ReturnType<typeof routeTo>["request"],
  env: Record<string, string | undefined> = { [KEY_NAME]: PLAIN_KEY },
) {
  return createGateway({
    config: CONFIG,
    adapters: [createProviderAdapter("example", { request, now: () => 0 })],
    env: () => env,
  });
}
async function failure(p: Promise<unknown>): Promise<ModelGatewayError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelGatewayError);
    return e as ModelGatewayError;
  }
  throw new Error("the call was expected to fail");
}

describe("the host allowlist (ADR-0005: a provider is added by a change here and in this test, never by a setting)", () => {
  it("holds exactly one example entry today, and no real provider", () => {
    expect(PROVIDER_HOSTS.map((e) => `${e.provider} ${e.host}${e.path}`)).toEqual([
      "example api.example.test/v1/complete",
    ]);
  });

  it("holds exact lower-case host names only: no address, no wildcard, no port, no local name", () => {
    for (const e of PROVIDER_HOSTS) {
      expect(e.host, e.host).toMatch(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
      );
      expect(isIP(e.host)).toBe(0);
      expect(e.host).not.toMatch(/(^|\.)(localhost|local|internal|lan|home|corp)$/);
      expect(e.path).toMatch(/^\/[A-Za-z0-9._/-]*$/);
      expect(e.path).not.toContain("..");
      for (const p of [e.inputMicrosPerMillionTokens, e.outputMicrosPerMillionTokens])
        expect(Number.isSafeInteger(p) && p >= 0).toBe(true);
    }
    expect(new Set(PROVIDER_HOSTS.map((e) => e.host)).size).toBe(PROVIDER_HOSTS.length);
    expect(new Set(PROVIDER_HOSTS.map((e) => e.provider)).size).toBe(PROVIDER_HOSTS.length);
  });

  it("is frozen, and a caller names a provider, never a host", () => {
    expect(Object.isFrozen(PROVIDER_HOSTS)).toBe(true);
    expect(() => createProviderAdapter("api.example.test")).toThrow(/no provider/i);
    expect(() => createProviderAdapter("other")).toThrow(/no provider/i);
    expect(createProviderAdapter("example")).toMatchObject({ provider: "example", needsKey: true });
  });
});

describe("one request", () => {
  it("is a POST over https to the allowlisted host and path, with a JSON body of three fields", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    const { request, seen } = routeTo(s.port);
    await over(request).complete({ ...REQUEST, prompt: "Reword: the menu link gives a 404." });
    await s.close();
    expect(seen).toHaveLength(1);
    const { url, options } = seen[0]!;
    expect(url.href).toBe("https://api.example.test/v1/complete");
    expect(options.method).toBe("POST");
    expect(Object.keys(options.headers ?? {}).sort()).toEqual([
      "accept",
      "authorization",
      "content-length",
      "content-type",
      "user-agent",
    ]);
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${PLAIN_KEY}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(s.hits[0]!)).toEqual({
      model: "small-model",
      prompt: "Reword: the menu link gives a 404.",
      max_output_tokens: 1024,
    });
  });

  it("gives back the answer, whole-number usage and a cost worked out in integers", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    const a = await over(routeTo(s.port).request).complete(REQUEST);
    await s.close();
    expect(a).toMatchObject({ text: ANSWER.text, provider: "example", advisory: true });
    expect(a.usage).toEqual({ inputTokens: 40, outputTokens: 10, costMicros: 70, latencyMs: 0 });
  });

  it("measures latency in whole milliseconds with the clock it is given", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    let t = 0;
    const adapter = createProviderAdapter("example", {
      request: routeTo(s.port).request,
      now: () => (t += 250.4),
    });
    const g = createGateway({
      config: CONFIG,
      adapters: [adapter],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    expect((await g.complete(REQUEST)).usage.latencyMs).toBe(250);
    await s.close();
  });

  it("sends nothing but what the caller passed: no environment, no other header, no key in the body", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    const env = { [KEY_NAME]: PLAIN_KEY, OTHER_SECRET_TOKEN: "other-secret-value-1234" };
    await over(routeTo(s.port).request, env).complete(REQUEST);
    await s.close();
    expect(s.hits[0]).not.toContain(PLAIN_KEY);
    expect(s.hits[0]).not.toContain("other-secret");
  });

  it("reads the key when it is called, so unsetting it stops the next call before any request", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    const { request, seen } = routeTo(s.port);
    const env: Record<string, string | undefined> = { [KEY_NAME]: PLAIN_KEY };
    const g = over(request, env);
    await g.complete(REQUEST);
    delete env[KEY_NAME];
    expect((await failure(g.complete(REQUEST))).code).toBe("missing-key");
    expect(seen).toHaveLength(1);
    await s.close();
  });

  it("refuses a call that has no key to send, without a request", async () => {
    const { request, seen } = hangingRequest();
    const adapter = createProviderAdapter("example", { request });
    const controller = new AbortController();
    await expect(
      adapter.complete({
        model: "m",
        prompt: "hi",
        callId: "c",
        maxOutputTokens: 5,
        signal: controller.signal,
        key: undefined,
      }),
    ).rejects.toMatchObject({ code: "missing-key" });
    expect(seen).toHaveLength(0);
  });

  it("prints and logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = await startServer((_req, res) => json(res, 500, "down"));
    const g = over(routeTo(s.port).request);
    await failure(g.complete(REQUEST));
    await s.close();
    for (const sp of [...spies, err]) expect(sp).not.toHaveBeenCalled();
  });
});

describe("the payload cap: findings, ids and snippets, never a whole page", () => {
  it("lets through a prompt of exactly the cap, in bytes", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    await expect(
      over(routeTo(s.port).request).complete({ ...REQUEST, prompt: "a".repeat(MAX_PAYLOAD_BYTES) }),
    ).resolves.toBeDefined();
    await s.close();
  });

  it("refuses one byte more, and sends nothing", async () => {
    const { request, seen } = hangingRequest();
    const e = await failure(
      over(request).complete({ ...REQUEST, prompt: "a".repeat(MAX_PAYLOAD_BYTES + 1) }),
    );
    expect(e.code).toBe("input-too-large");
    expect(e.message).toContain(String(MAX_PAYLOAD_BYTES));
    expect(seen).toHaveLength(0);
  });

  it("counts bytes, not characters", async () => {
    const { request, seen } = hangingRequest();
    const e = await failure(
      over(request).complete({ ...REQUEST, prompt: "é".repeat(MAX_PAYLOAD_BYTES / 2 + 1) }),
    );
    expect(e.code).toBe("input-too-large");
    expect(seen).toHaveLength(0);
  });

  it("is well under the gateway's own character cap, so a long page cannot get through", () => {
    expect(MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(16_000);
  });

  it.each([
    ["a document type line", "<!DOCTYPE html><title>Menu</title>"],
    ["an html element", "Here is the page: <HTML lang=en><body>Menu</body>"],
    ["a head element", "x <head><meta charset=utf-8></head>"],
    ["a body element", "x <body class=home>Hello"],
  ])("refuses text that is a whole page: %s", async (_n, prompt) => {
    const { request, seen } = hangingRequest();
    const e = await failure(over(request).complete({ ...REQUEST, prompt }));
    expect(e.code).toBe("bad-request");
    expect(e.message).toMatch(/whole page/);
    expect(seen).toHaveLength(0);
  });

  it("lets a snippet with one tag in it through: a finding may quote an element", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    await expect(
      over(routeTo(s.port).request).complete({
        ...REQUEST,
        prompt: 'Evidence: <a href="/menu">Menu</a> has no text.',
      }),
    ).resolves.toBeDefined();
    await s.close();
  });
});

describe("what comes back", () => {
  it("does not follow a redirect, to the same host or another: it is an error, and the target is never asked", async () => {
    const other = await startServer((_req, res) => json(res, 200, ANSWER));
    const s = await startServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${other.port}/v1/complete` });
      res.end();
    });
    const { request, seen } = routeTo(s.port);
    const e = await failure(over(request).complete(REQUEST));
    expect(e.code).toBe("provider-error");
    expect(e.message).toMatch(/redirect/);
    expect(seen).toHaveLength(1);
    expect(other.hits).toHaveLength(0);
    await s.close();
    await other.close();
  });

  it.each([401, 429, 500])(
    "turns a %i into an error that says the status and nothing else",
    async (status) => {
      const s = await startServer((_req, res) =>
        json(res, status, {
          error: { message: `bad ${PLAIN_KEY} and the prompt: Reword the menu` },
        }),
      );
      const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
      await s.close();
      expect(e.code).toBe("provider-error");
      expect(e.message).toContain(String(status));
      expect(e.message).toContain("api.example.test");
      expect(e.message).not.toContain("Reword");
      expect(e.message).not.toContain(PLAIN_KEY);
    },
  );

  it("stops reading an answer that is too long, and says so", async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("x".repeat(MAX_RESPONSE_BYTES + 10));
      res.end();
    });
    const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
    await s.close();
    expect(e.code).toBe("bad-answer");
    expect(e.message).toMatch(/too long/);
  });

  it.each([
    ["text/html"],
    ["text/plain"],
    ["text/json"],
    ["application/jsonp"],
    ["application/json-seq"],
    ["application/vnd.api+json"],
    ["application/json; charset=latin1"],
    ["application/json; boundary=x"],
    [""],
  ])(
    "refuses a 2xx answer whose content type is %j, without reading or repeating its body",
    async (type) => {
      const s = await startServer((_req, res) => {
        res.writeHead(200, type === "" ? {} : { "content-type": type });
        res.end(JSON.stringify({ ...ANSWER, text: "BODY-WORDS-THAT-MUST-NOT-APPEAR" }));
      });
      const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
      await s.close();
      expect(e.code).toBe("bad-answer");
      expect(e.message).toMatch(/not JSON/);
      expect(e.message).not.toContain("BODY-WORDS");
    },
  );

  it.each([
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    'application/json;charset="UTF-8"',
  ])("accepts the content type %j", async (type) => {
    const s = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": type });
      res.end(JSON.stringify(ANSWER));
    });
    await expect(over(routeTo(s.port).request).complete(REQUEST)).resolves.toBeDefined();
    await s.close();
  });

  it.each([
    ["text that is not JSON", "<html>oops</html>"],
    ["JSON that is a list", "[]"],
    ["no text", JSON.stringify({ usage: ANSWER.usage })],
    ["text that is a number", JSON.stringify({ ...ANSWER, text: 4 })],
    ["no usage", JSON.stringify({ text: "x" })],
    [
      "a token count with a fraction",
      JSON.stringify({ ...ANSWER, usage: { input_tokens: 1.5, output_tokens: 1 } }),
    ],
    [
      "a negative token count",
      JSON.stringify({ ...ANSWER, usage: { input_tokens: -1, output_tokens: 1 } }),
    ],
    [
      "a token count as text",
      JSON.stringify({ ...ANSWER, usage: { input_tokens: "1", output_tokens: 1 } }),
    ],
  ])("refuses %s as a malformed answer", async (_n, body) => {
    const s = await startServer((_req, res) => json(res, 200, body));
    const e = await failure(over(routeTo(s.port).request).complete(REQUEST));
    await s.close();
    expect(e.code).toBe("bad-answer");
    expect(e.message).not.toContain("oops");
  });
});

describe("the hard timeout", () => {
  it("destroys a request that never answers, after the limit and not before", async () => {
    vi.useFakeTimers();
    const { request, destroyed } = hangingRequest();
    const done = failure(over(request).complete(REQUEST));
    await vi.advanceTimersByTimeAsync(5_000); // the gateway's own timeout comes first when the config is shorter
    const e = await done;
    expect(e.code).toBe("timeout");
    expect(destroyed()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("has a limit of its own that a long config cannot lengthen", async () => {
    vi.useFakeTimers();
    const { request, destroyed } = hangingRequest();
    const g = createGateway({
      config: { ...CONFIG, timeoutMs: 120_000 },
      adapters: [createProviderAdapter("example", { request })],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    const done = failure(g.complete(REQUEST));
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS - 1);
    expect(destroyed()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).code).toBe("timeout");
    expect(destroyed()).toBe(1);
    expect(HARD_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("destroys the request when the gateway aborts it", async () => {
    vi.useFakeTimers();
    const { request, destroyed } = hangingRequest();
    const done = failure(over(request).complete(REQUEST));
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(destroyed()).toBe(1);
  });

  it("clears its timer after an answer", async () => {
    const s = await startServer((_req, res) => json(res, 200, ANSWER));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await over(routeTo(s.port).request).complete(REQUEST);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await s.close();
  });
});

describe("no private, loopback, link-local or metadata address (the fetcher's own rule)", () => {
  /** What the sender hands the client as `lookup`, with a name resolver the test controls. */
  async function lookupFor(resolve: NameResolver) {
    const { request, seen } = hangingRequest();
    const adapter = createProviderAdapter("example", { request, resolve });
    const controller = new AbortController();
    const p = adapter
      .complete({
        model: "m",
        prompt: "hi",
        callId: "c",
        maxOutputTokens: 5,
        signal: controller.signal,
        key: new ApiKey(PLAIN_KEY),
      })
      .catch(() => undefined);
    controller.abort();
    await p;
    const lookup = seen[0]!.options.lookup!;
    return (host = "api.example.test") =>
      new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }>((r) =>
        (lookup as unknown as NameResolver)(host, {}, (err, address) => r({ err, address })),
      );
  }
  const answers =
    (...a: string[]): NameResolver =>
    (_h, _o, cb) =>
      cb(
        null,
        a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.9",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])("refuses a name that resolves to %s, so nothing connects", async (address) => {
    const r = await (await lookupFor(answers(address)))();
    expect(r.err?.code).toBe("EGAUGELINENOTPUBLIC");
  });

  it("refuses a name that resolves to a public address and a private one together", async () => {
    const r = await (await lookupFor(answers("93.184.216.34", "10.0.0.5")))();
    expect(r.err?.code).toBe("EGAUGELINENOTPUBLIC");
  });

  it.each(["not-an-ip", "localhost", "", "10.0.0.1.5", "example.test", "[::1]"])(
    "refuses an answer that is not an address at all (%j)",
    async (answer) => {
      const r = await (await lookupFor(answers(answer)))();
      expect(r.err?.code).toBe("EGAUGELINENOTPUBLIC");
    },
  );

  it("is asked by the real https client: with no request function given, the lookup is the one the sender passed", async () => {
    const asked: string[] = [];
    const adapter = createProviderAdapter("example", {
      resolve: (host, _o, cb) => {
        asked.push(host);
        cb(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    });
    const g = createGateway({
      config: CONFIG,
      adapters: [adapter],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    const e = await failure(g.complete(REQUEST));
    expect(e.message).toBe("api.example.test is not a public address: nothing was sent");
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["api.example.test"]));
  });

  it.each([
    ["NODE_USE_ENV_PROXY=1", [], { NODE_USE_ENV_PROXY: "1" }],
    ["--use-env-proxy", ["--use-env-proxy"], {}],
  ])(
    "still runs when Node's own proxy support is on (%s): the lookup is called and the proxy is never used",
    (_n, flags, env) => {
      if (flags.length > 0 && !process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) return;
      const root = fileURLToPath(new URL("../../../../../", import.meta.url));
      const child = fileURLToPath(new URL("./send-proxy-child.mjs", import.meta.url));
      const out = execFileSync(process.execPath, [...flags, "--import", "tsx", child], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 90_000,
      });
      const last = JSON.parse(out.trim().split("\n").pop()!) as {
        code: string;
        message: string;
        lookups: number;
        proxyHits: string[];
      };
      expect(last.message).toBe("api.example.test is not a public address: nothing was sent");
      expect(last.lookups).toBeGreaterThan(0);
      expect(last.proxyHits).toEqual([]);
    },
    120_000,
  );

  it("refuses a name that resolves to nothing", async () => {
    const r = await (await lookupFor(answers()))();
    expect(r.err?.code).toBe("EGAUGELINENOTPUBLIC");
  });

  it("lets a public address through, and passes a resolver's own error on", async () => {
    expect(
      (await (await lookupFor(answers("93.184.216.34", "2606:2800:220:1::1")))()).err,
    ).toBeNull();
    const failing: NameResolver = (_h, _o, cb) =>
      cb(Object.assign(new Error("x"), { code: "ENOTFOUND" }), []);
    expect((await (await lookupFor(failing))()).err?.code).toBe("ENOTFOUND");
  });

  it("is an error that says nothing was sent and shows no address", async () => {
    const adapter = createProviderAdapter("example", {
      resolve: answers("10.9.8.7"),
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
    const e = await failure(g.complete(REQUEST));
    expect(e.message).toContain("not a public address: nothing was sent");
    expect(e.message).not.toContain("10.9.8.7");
  });

  it("shows no raw error from the client: a refused connection is its code and the host only", async () => {
    const adapter = createProviderAdapter("example", {
      request: (url) => {
        const req = new EventEmitter() as ClientRequest;
        (req as unknown as { end(): void }).end = () =>
          req.emit(
            "error",
            Object.assign(new Error(`connect failed for ${url.href} ${PLAIN_KEY}`), {
              code: "ECONNREFUSED",
            }),
          );
        (req as unknown as { destroy(): void }).destroy = () => undefined;
        return req;
      },
    });
    const g = createGateway({
      config: CONFIG,
      adapters: [adapter],
      env: () => ({ [KEY_NAME]: PLAIN_KEY }),
    });
    const e = await failure(g.complete(REQUEST));
    expect(e.message).toBe("api.example.test could not be reached (ECONNREFUSED)");
  });
});

describe("the adapter scrubs its own errors", () => {
  const raise = (make: (url: URL) => Error) =>
    createProviderAdapter("example", {
      request: (url) => {
        const req = new EventEmitter() as ClientRequest;
        (req as unknown as { end(): void }).end = () => req.emit("error", make(url));
        (req as unknown as { destroy(): void }).destroy = () => undefined;
        return req;
      },
    });
  const call = (
    adapter: ReturnType<typeof createProviderAdapter>,
    signal = new AbortController().signal,
  ) =>
    adapter.complete({
      model: "m",
      prompt: "hi",
      callId: "c",
      maxOutputTokens: 5,
      signal,
      key: new ApiKey(PLAIN_KEY),
    });

  it("removes the key from an error code the client raised, before the gateway sees it", async () => {
    const adapter = raise(() =>
      Object.assign(new Error("x"), {
        code: `E_${PLAIN_KEY}_${Buffer.from(PLAIN_KEY).toString("base64")}`,
      }),
    );
    const e = await failure(call(adapter));
    expect(e).toBeInstanceOf(ModelGatewayError);
    expect(e.message).not.toContain(PLAIN_KEY);
    expect(e.message).not.toContain(Buffer.from(PLAIN_KEY).toString("base64"));
    expect(e.message).toContain("could not be reached");
  });

  it("does the same for every other error it raises", async () => {
    const s = await startServer((_req, res) => json(res, 401, "nope"));
    for (const adapter of [
      createProviderAdapter("example", { request: routeTo(s.port).request }),
    ]) {
      const e = await failure(call(adapter));
      expect(e.message).not.toContain(PLAIN_KEY);
    }
    await s.close();
    const aborted = new AbortController();
    aborted.abort();
    const e = await failure(
      call(createProviderAdapter("example", { request: hangingRequest().request }), aborted.signal),
    );
    expect(e.code).toBe("timeout");
    expect(e.message).not.toContain(PLAIN_KEY);
  });
});

describe("keys", () => {
  it("never appear in an error, even when the provider echoes the request", async () => {
    const s = await startServer((req, res, body) =>
      json(res, 400, { echo: String(req.headers.authorization), body }),
    );
    const e = await failure(
      over(routeTo(s.port).request, { [KEY_NAME]: SHAPED_KEY }).complete(REQUEST),
    );
    await s.close();
    expect(e.message).not.toContain(SHAPED_KEY);
    expect(e.stack ?? "").not.toContain(SHAPED_KEY);
  });
});

describe("where this module sits", () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const text = readFileSync(join(dir, "send.ts"), "utf8");

  it("builds one POST and no PUT, PATCH or DELETE, and opens a connection through node:https only", () => {
    const found = scan("core/src/model-gateway/send.ts", text);
    expect(found.filter((f) => f.category === "verb").map((f) => f.what)).toHaveLength(1);
    expect(text.match(/method:\s*"POST"/g)).toHaveLength(1);
    expect(text).not.toMatch(/["'`](PUT|PATCH|DELETE)["'`]/);
    expect([...text.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]).sort()).toEqual(
      [
        "../addresses.js",
        "./errors.js",
        "./types.js",
        "node:dns",
        "node:https",
        "node:net",
        "node:stream",
      ].sort(),
    );
    expect(text).not.toMatch(/\bfetch\s*\(|from "(node:)?http"|http:\/\/|process\s*\.\s*env/);
  });

  it("is the only model-gateway entry in the post-boundary list, as a file and for verb and network only", () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const t = readFileSync(join(root, "packages/core/src/__tests__/post-boundary.test.ts"), "utf8");
    const list = t.slice(t.indexOf("const ALLOWED"), t.indexOf("const packagesDir"));
    const entries = [...list.matchAll(/^\s*"([^"]+)":\s*\[([^\]]*)\]/gm)].map((m) => [
      m[1]!,
      m[2]!.replace(/\s/g, ""),
    ]);
    expect(entries.filter(([k]) => k!.includes("model-gateway"))).toEqual([
      ["core/src/model-gateway/send.ts", '"verb","network"'],
    ]);
    // Every entry is one file: no folder, no wildcard, no pattern.
    for (const [k] of entries) expect(k, k).toMatch(/^[a-z-]+\/src\/[A-Za-z0-9_./-]+\.ts$/);
    expect(list).not.toMatch(/[*?]|\.startsWith|\.test\(/);
  });

  it("is not imported by any other source file: nothing calls it yet, and no test or CI run can reach a provider", () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        if (["node_modules", "dist", "__tests__", ".next", ".turbo"].includes(n)) return [];
        const full = join(d, n);
        return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(n) ? [full] : [];
      });
    const files = [...walk(join(root, "packages")), ...walk(join(root, "apps"))].filter(
      (f) => !f.endsWith(join("model-gateway", "send.ts")),
    );
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.filter((f) => /model-gateway\/send(\.js)?["']/.test(readFileSync(f, "utf8"))),
    ).toEqual([]);
  });

  it("is not in the gateway's index: it is named where it is used", () => {
    expect(readFileSync(join(dir, "index.ts"), "utf8")).not.toContain("send");
  });

  it("is the only file the lint rule lets import node:https, and still bans node:http, sockets and fetch", async () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const eslint = new ESLint({ cwd: root });
    const rule = async (file: string, name: string) => {
      const cfg = await eslint.calculateConfigForFile(
        join(root, "packages/core/src/model-gateway", file),
      );
      const entry = cfg.rules?.[name] as
        [unknown, { paths?: Array<{ name: string }> } | { name: string }] | undefined;
      return entry;
    };
    const imports = async (file: string) =>
      (
        (await rule(file, "no-restricted-imports"))?.[1] as { paths: Array<{ name: string }> }
      ).paths.map((p) => p.name);
    const globals = async (file: string) =>
      ((await rule(file, "no-restricted-globals")) as unknown as unknown[])
        .slice(1)
        .map((g) => (g as { name: string }).name);
    for (const file of ["send.ts", "gateway.ts", "recorded.ts", "key.ts", "config.ts"]) {
      const names = await imports(file);
      // Everything restricted for every other file in core is restricted here, except node:https for send.ts alone.
      for (const n of ["node:http", "http", "node:net", "node:tls", "tls", "@gaugeline/cli"])
        expect(names, `${file} ${n}`).toContain(n);
      if (file === "send.ts") expect(names).not.toContain("node:https");
      else expect(names, file).toContain("node:https");
      expect(await globals(file), file).toEqual(
        expect.arrayContaining(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]),
      );
    }
    // And the process-exit rules for core still apply to it.
    expect(await imports("send.ts")).toEqual(expect.arrayContaining(["node:process", "process"]));
  }, 60_000);
});
