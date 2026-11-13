import { afterEach, describe, expect, it } from "vitest";
import { aiConfigSchema } from "../../ai-intent.js";
import { classifyAnswer } from "../../ai-endpoints/answer.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { PROBING_CHECKS } from "../../presets.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { AI_ENDPOINT_NO_CONSENT_REASON, aiEndpointOpen } from "../ai-endpoint-open.js";
import { createPageRegistry } from "../index.js";

/**
 * ai-endpoint-open (AI-12), a probing check: the routes the owner lists in gaugeline.ai.json (modelEndpoints) are
 * asked once each with a GET and no login. It finds a route that lists its models or answers with a model's reply to
 * anyone, and a route that shows a provider's own error text. Everything here is invented; no body text is printed.
 */
const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const json =
  (code: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  (_q, res) => {
    res
      .writeHead(code, { "content-type": "application/json", ...headers })
      .end(typeof body === "string" ? body : JSON.stringify(body));
  };
const text =
  (code: number, body: string): Handler =>
  (_q, res) => {
    res.writeHead(code, { "content-type": "text/plain" }).end(body);
  };
const modelList = (n: number) => ({
  object: "list",
  data: Array.from({ length: n }, (_, i) => ({
    id: `house-model-${i}`,
    object: "model",
    created: 1,
    owned_by: "studio",
  })),
});
const KEY_FRAGMENT = ["sk", "proj", "********************", "Ab12"].join("-");
const providerError = {
  error: {
    message: `Incorrect API key provided: ${KEY_FRAGMENT}. You can find your API key at the provider's dashboard.`,
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
};

const pageAt = (origin: string): PageSnapshot =>
  buildSnapshot([
    {
      url: `${origin}/`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><head><title>Cafe</title></head></html>",
      ms: 1,
    },
  ]);
const ai = (modelEndpoints: string[] | undefined) =>
  aiConfigSchema.parse(modelEndpoints === undefined ? {} : { modelEndpoints });

async function run(
  routes: Record<string, Handler>,
  endpoints: string[] | undefined = Object.keys(routes),
  extra: Partial<CheckContext> = {},
) {
  const server = await startServer(routes);
  servers.push(server);
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    fetcher: createFetcher({ allowPrivate: true }),
    ownerConsent: true,
    ai: ai(endpoints),
    ...extra,
  };
  const found = await aiEndpointOpen.run(pageAt(server.origin), ctx);
  return { found, notes, server, ctx };
}
const asked = (s: FixtureServer) => s.log.map((r) => `${r.method} ${r.path}`);

describe("ai-endpoint-open: unit, reading an answer", () => {
  const hop = (status: number, body: unknown, type = "application/json") => ({
    status,
    contentType: type,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("a list of models with no login is an open list, with the count and no model name", () => {
    expect(classifyAnswer(hop(200, modelList(3)))).toEqual({ kind: "open-list", count: 3 });
    expect(classifyAnswer(hop(200, { models: [{ name: "a:1" }, { model: "b:2" }] }))).toEqual({
      kind: "open-list",
      count: 2,
    });
  });

  it("a model's reply to a request with no login is an open answer", () => {
    for (const body of [
      {
        id: "x",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "Hello" } }],
      },
      { candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
      { type: "message", content: [{ type: "text", text: "Hello" }], model: "m" },
      { model: "m", response: "Hello", done: true },
    ])
      expect(classifyAnswer(hop(200, body)).kind, JSON.stringify(body)).toBe("open-answer");
  });

  it("a provider's own error text is verbose, whatever the status, and names the signs, never the text", () => {
    for (const status of [400, 401, 429, 500, 200]) {
      const out = classifyAnswer(hop(status, providerError));
      expect(out).toEqual({
        kind: "verbose-error",
        signs: ["a provider error type", "a provider message", "a key fragment"],
      });
    }
    expect(JSON.stringify(classifyAnswer(hop(401, providerError)))).not.toContain("Ab12");
  });

  it("a stack trace, a file path and an SDK error class are verbose", () => {
    const trace =
      "Error: upstream failed\n    at fetchModel (/var/task/app/api/chat/route.js:41:11)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)";
    expect(classifyAnswer(hop(500, trace, "text/plain"))).toEqual({
      kind: "verbose-error",
      signs: ["a stack trace", "a file path"],
    });
    expect(
      classifyAnswer(hop(500, "openai.error.AuthenticationError: bad key", "text/plain")),
    ).toEqual({ kind: "verbose-error", signs: ["an SDK error class"] });
    expect(
      classifyAnswer(
        hop(500, 'Traceback (most recent call last):\n  File "/app/main.py", line 3', "text/plain"),
      ).kind,
    ).toBe("verbose-error");
  });

  it("a plain refusal is closed: 401, 403 and 405, with or without a short message", () => {
    for (const [status, body] of [
      [401, { error: "unauthorized" }],
      [403, "Forbidden"],
      [405, "Method Not Allowed"],
      [401, ""],
    ] as const)
      expect(classifyAnswer(hop(status, body)), `${status}`).toEqual({ kind: "closed" });
  });

  it("an HTML page, an empty 200 and a JSON object that is not a model's are closed", () => {
    expect(
      classifyAnswer(hop(200, "<html><body>Ask our assistant</body></html>", "text/html")).kind,
    ).toBe("closed");
    expect(classifyAnswer(hop(200, "")).kind).toBe("closed");
    expect(classifyAnswer(hop(200, { ok: true })).kind).toBe("closed");
    expect(classifyAnswer(hop(200, { data: [{ id: 1 }] })).kind).toBe("closed");
    expect(classifyAnswer(hop(200, { object: "list", data: [] })).kind).toBe("closed");
  });

  it("a missing route, a rate limit, a server error with no text and a broken body are not clear", () => {
    expect(classifyAnswer(hop(404, "nope"))).toEqual({
      kind: "unclear",
      reason: "the address answered 404, which is not a clear answer",
    });
    expect(classifyAnswer(hop(429, "slow down")).kind).toBe("unclear");
    expect(classifyAnswer(hop(503, "")).kind).toBe("unclear");
    expect(classifyAnswer(hop(200, '{"object":"list","data":[{"id":"a"')).kind).toBe("closed");
  });

  it("is the same answer for the same input, and fast on a hostile body", () => {
    const evil = `at x (${"a".repeat(8000)}\n`.repeat(200) + "sk-".repeat(5000);
    const start = Date.now();
    expect(classifyAnswer(hop(500, evil, "text/plain"))).toEqual(
      classifyAnswer(hop(500, evil, "text/plain")),
    );
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("ai-endpoint-open: the settings entry", () => {
  it("modelEndpoints are paths: starting with /, no wildcard, query or hash, at most 8, and only paths", () => {
    expect(aiConfigSchema.safeParse({ modelEndpoints: ["/api/chat", "/v1/models"] }).success).toBe(
      true,
    );
    for (const bad of [
      ["chat"],
      ["/a*"],
      ["/a?x=1"],
      ["/a#b"],
      ["https://x.example/a"],
      ["/a b"],
      Array.from({ length: 9 }, (_, i) => `/r${i}`),
    ])
      expect(aiConfigSchema.safeParse({ modelEndpoints: bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
  });
});

describe("ai-endpoint-open: a probing check, when it asks", () => {
  it("is registered and a probing check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("ai-endpoint-open");
    expect(PROBING_CHECKS).toContain("ai-endpoint-open");
    expect(aiEndpointOpen.tech).toMatch(/^probing check/);
  });

  it("asks nothing without consent, and says why", async () => {
    const { found, notes, server } = await run(
      { "/v1/models": json(200, modelList(2)) },
      ["/v1/models"],
      { ownerConsent: false },
    );
    expect(found).toEqual([]);
    expect(notes).toEqual([{ url: server.origin, reason: AI_ENDPOINT_NO_CONSENT_REASON }]);
    expect(asked(server)).toEqual([]);
  });

  it("does not apply, and asks nothing, with no modelEndpoints entry or an empty one", async () => {
    for (const endpoints of [undefined, []]) {
      const { found, notes, server } = await run({}, endpoints);
      expect(found).toEqual([]);
      expect(notes).toEqual([]);
      expect(asked(server)).toEqual([]);
    }
  });

  it("asks only the routes the owner listed, once each, by GET, with no cookie or login, and never picks one itself", async () => {
    const { server } = await run(
      {
        "/api/chat": text(405, "Method Not Allowed"),
        "/v1/models": json(401, { error: "unauthorized" }),
        "/api/admin": text(200, "x"),
      },
      ["/api/chat", "/v1/models"],
    );
    expect(asked(server)).toEqual(["GET /api/chat", "GET /v1/models"]);
    for (const r of server.log) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
  });

  it("asks once per run: a second page of the same site asks nothing more", async () => {
    const server = await startServer({ "/api/chat": text(405, "no") });
    servers.push(server);
    const ctx: CheckContext = {
      warn: () => undefined,
      fetcher: createFetcher({ allowPrivate: true }),
      ownerConsent: true,
      ai: ai(["/api/chat"]),
    };
    await aiEndpointOpen.run(pageAt(server.origin), ctx);
    await aiEndpointOpen.run(pageAt(server.origin), ctx);
    expect(asked(server)).toHaveLength(1);
  });

  it("never sends a POST, PUT, PATCH or DELETE", async () => {
    const { server } = await run({ "/api/chat": json(200, modelList(1)) });
    expect(server.log.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("ai-endpoint-open: what it finds", () => {
  it("fails: an open model list, with the count and no model name", async () => {
    const { found, server } = await run({ "/v1/models": json(200, modelList(4)) });
    expect(found).toEqual([
      {
        checkId: "ai-endpoint-open",
        severity: "high",
        title: "An AI route on your site answers anyone or shows the provider's error text",
        evidence: "/v1/models answers 200 and lists 4 models to anyone, with no login",
        url: `${server.origin}/v1/models`,
      },
    ]);
    expect(JSON.stringify(found)).not.toContain("house-model");
  });

  it("fails: a model's reply with no login", async () => {
    const { found } = await run({
      "/api/generate": json(200, { model: "m", response: "Hello", done: true }),
    });
    expect(found.map((f) => f.evidence)).toEqual([
      "/api/generate answers 200 with a model's reply to anyone, with no login",
    ]);
  });

  it("fails: a verbose model error, naming the signs and none of the text", async () => {
    const { found } = await run({ "/api/chat": json(401, providerError) });
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      "/api/chat answers 401 with the provider's own error text: a provider error type, a provider message, a key fragment",
    );
    expect(found[0]?.severity).toBe("medium");
    expect(JSON.stringify(found)).not.toContain("Ab12");
    expect(JSON.stringify(found)).not.toContain("dashboard");
  });

  it("passes: closed routes, whatever they say politely", async () => {
    const { found, notes } = await run({
      "/api/chat": text(405, "Method Not Allowed"),
      "/v1/models": json(401, { error: "Unauthorized" }),
      "/api/ask": text(403, "Forbidden"),
    });
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("a route that is missing, rate limited or failing without text is could-not-check, never a pass or a finding", async () => {
    for (const code of [404, 429, 500, 503]) {
      const { found, notes } = await run({ "/api/chat": text(code, "") });
      expect(found, String(code)).toEqual([]);
      expect(
        notes.map((n) => n.reason),
        String(code),
      ).toEqual([`the address answered ${code}, which is not a clear answer`]);
    }
  });

  it("the fetcher refuses a private address without --allow-private, which is could-not-check", async () => {
    const server = await startServer({ "/api/chat": json(200, modelList(1)) });
    servers.push(server);
    const notes: string[] = [];
    const found = await aiEndpointOpen.run(pageAt(server.origin), {
      warn: () => undefined,
      couldNotCheck: (_u, r) => notes.push(r),
      fetcher: createFetcher({}),
      ownerConsent: true,
      ai: ai(["/api/chat"]),
    });
    expect(found).toEqual([]);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(asked(server)).toEqual([]);
  });

  it("reads at most 16 KiB of each answer, so a huge body cannot make a finding or a cost", async () => {
    const big = "x".repeat(2_000_000);
    const { found } = await run({ "/api/chat": text(200, `${big} Incorrect API key provided`) });
    expect(found).toEqual([]);
  });

  it("is the same findings for the same site every time", async () => {
    const routes = { "/a": json(200, modelList(2)), "/b": json(401, providerError) };
    const one = await run(routes);
    const two = await run(routes);
    expect(one.found.map((f) => f.evidence)).toEqual(two.found.map((f) => f.evidence));
  });
});
