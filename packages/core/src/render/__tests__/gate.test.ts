import { Readable } from "node:stream";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FetchError, type Transport, type TransportRequest } from "../../fetcher.js";
import { createEgressGate, type GateRequest } from "../gate.js";

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** A transport that answers from a table and remembers what it was asked. */
function fake(table: Record<string, Answer | Error>) {
  const calls: { url: string; req: TransportRequest }[] = [];
  const transport: Transport = (url, req) => {
    calls.push({ url: url.href, req });
    const hit = table[url.href];
    if (hit === undefined) return Promise.reject(new Error(`no answer for ${url.href}`));
    if (hit instanceof Error) return Promise.reject(hit);
    const body =
      req.method === "HEAD" ? [] : [Buffer.from(hit.body ?? "<p>ok</p>")].filter((b) => b.length);
    return Promise.resolve({
      status: hit.status ?? 200,
      headers: hit.headers ?? { "content-type": "text/html" },
      body: Readable.from(body),
    });
  };
  return { transport, calls };
}

const get = (url: string, extra: Partial<GateRequest> = {}): GateRequest => ({
  url,
  method: "GET",
  kind: "script",
  frame: "main",
  ...extra,
});
const doc = (url: string) => get(url, { kind: "document" });

describe("the egress gate: method, scheme, host", () => {
  it("answers a GET from the transport and strips what must not reach the page", async () => {
    const { transport, calls } = fake({
      "https://site.example/app.js": {
        headers: {
          "content-type": "text/javascript",
          "set-cookie": "a=b",
          "content-encoding": "gzip",
          "content-length": "999",
          "x-kept": "yes",
        },
        body: "var a=1;",
      },
    });
    const gate = createEgressGate({ transport });
    const answer = await gate.handle(
      get("https://site.example/app.js", {
        headers: { cookie: "s=1", authorization: "Bearer x", accept: "*/*", "x-other": "1" },
      }),
    );
    expect(answer).toMatchObject({ action: "fulfill", status: 200 });
    if (answer.action !== "fulfill") throw new Error("unreachable");
    expect(answer.body.toString()).toBe("var a=1;");
    expect(answer.headers).toEqual({ "content-type": "text/javascript", "x-kept": "yes" });
    expect(calls[0]?.req.method).toBe("GET");
    // Only these request headers are forwarded: never a cookie or a credential.
    expect(Object.keys(calls[0]?.req.headers ?? {}).sort()).toEqual(["accept"]);
    expect(gate.state.requests).toEqual([
      {
        url: "https://site.example/app.js",
        method: "GET",
        kind: "script",
        verdict: "allowed",
        status: 200,
        bytes: 8,
      },
    ]);
  });

  it("answers a HEAD with no body", async () => {
    const { transport } = fake({ "https://site.example/x": { body: "ignored" } });
    const answer = await createEgressGate({ transport }).handle(
      get("https://site.example/x", { method: "HEAD" }),
    );
    expect(answer).toMatchObject({ action: "fulfill" });
    if (answer.action === "fulfill") expect(answer.body.length).toBe(0);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "post"])(
    "aborts %s without touching the transport",
    async (method) => {
      const { transport, calls } = fake({});
      const gate = createEgressGate({ transport });
      expect(await gate.handle(get("https://site.example/form", { method }))).toEqual({
        action: "abort",
        reason: "method",
      });
      expect(calls).toEqual([]);
      expect(gate.state.blocked.method).toBe(1);
      expect(gate.state.requests[0]).toMatchObject({ verdict: "blocked", reason: "method" });
    },
  );

  it("never lets a method other than GET or HEAD reach the transport", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((m) => m.toUpperCase() !== "GET" && m.toUpperCase() !== "HEAD"),
        async (method) => {
          const { transport, calls } = fake({});
          const answer = await createEgressGate({ transport }).handle(
            get("https://site.example/", { method }),
          );
          expect(answer.action).toBe("abort");
          expect(calls).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it.each([
    "file:///etc/passwd",
    "ftp://site.example/x",
    "javascript:alert(1)",
    "data:text/html,hi",
    "blob:https://site.example/1",
    "chrome://settings",
    "view-source:https://site.example/",
    "ws://site.example/socket",
    "not a url",
  ])("aborts %s as a scheme", async (url) => {
    const { transport, calls } = fake({});
    const gate = createEgressGate({ transport });
    expect(await gate.handle(doc(url))).toEqual({ action: "abort", reason: "scheme" });
    expect(calls).toEqual([]);
    expect(gate.state.blocked.scheme).toBe(1);
  });

  it("aborts an analytics host, records it, and sends nothing", async () => {
    const { transport, calls } = fake({});
    const gate = createEgressGate({ transport });
    expect(
      await gate.handle(get("https://www.google-analytics.com/g/collect?v=2&tid=G-X&en=click")),
    ).toEqual({ action: "abort", reason: "analytics" });
    expect(calls).toEqual([]);
    // The query string (it can carry an identifier) is not kept.
    expect(gate.state.requests[0]?.url).toBe("https://www.google-analytics.com/g/collect");
  });

  it("aborts a private address the transport refuses, for either of its refusals", async () => {
    for (const reason of ["private-address-refused", "blocked-address"] as const) {
      const { transport } = fake({
        "http://169.254.169.254/latest/meta-data/": new FetchError(reason, "no", "x", []),
      });
      const gate = createEgressGate({ transport });
      expect(await gate.handle(get("http://169.254.169.254/latest/meta-data/"))).toEqual({
        action: "abort",
        reason: "address",
      });
      expect(gate.state.blocked.address).toBe(1);
    }
  });

  it("counts a request the transport could not answer as failed, not as a block of policy", async () => {
    const { transport } = fake({ "https://site.example/gone": new Error("ENOTFOUND") });
    const gate = createEgressGate({ transport });
    expect(await gate.handle(get("https://site.example/gone"))).toEqual({
      action: "abort",
      reason: "failed",
    });
    expect(gate.state.blocked.failed).toBe(1);
  });
});

describe("the egress gate: redirects are checked at every hop", () => {
  it("follows a subresource redirect and checks the target", async () => {
    const { transport, calls } = fake({
      "https://site.example/a.js": { status: 302, headers: { location: "/b.js" } },
      "https://site.example/b.js": { body: "ok" },
    });
    const answer = await createEgressGate({ transport }).handle(get("https://site.example/a.js"));
    expect(answer).toMatchObject({ action: "fulfill", status: 200 });
    expect(calls.map((c) => c.url)).toEqual([
      "https://site.example/a.js",
      "https://site.example/b.js",
    ]);
  });

  it("refuses a subresource redirect to a private address through the transport's own refusal", async () => {
    const { transport, calls } = fake({
      "https://site.example/a.js": { status: 301, headers: { location: "http://10.0.0.5/x" } },
      "http://10.0.0.5/x": new FetchError("blocked-address", "no", "x", []),
    });
    const gate = createEgressGate({ transport });
    expect(await gate.handle(get("https://site.example/a.js"))).toEqual({
      action: "abort",
      reason: "address",
    });
    // The transport itself refused the address before a socket opened: one refused call.
    expect(calls.map((c) => c.url)).toEqual(["https://site.example/a.js", "http://10.0.0.5/x"]);
  });

  it("refuses a redirect to an analytics host or a non-http scheme without asking", async () => {
    for (const [location, reason] of [
      ["https://www.google-analytics.com/collect", "analytics"],
      ["file:///etc/hosts", "scheme"],
      ["javascript:alert(1)", "scheme"],
    ] as const) {
      const { transport, calls } = fake({
        "https://site.example/a.js": { status: 302, headers: { location } },
      });
      const gate = createEgressGate({ transport });
      expect(await gate.handle(get("https://site.example/a.js"))).toEqual({
        action: "abort",
        reason,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("stops a subresource redirect loop at the redirect cap", async () => {
    const { transport, calls } = fake({
      "https://site.example/loop": { status: 302, headers: { location: "/loop" } },
    });
    const gate = createEgressGate({ transport, limits: { redirects: 5 } });
    expect(await gate.handle(get("https://site.example/loop"))).toEqual({
      action: "abort",
      reason: "cap",
    });
    expect(calls).toHaveLength(6);
    expect(gate.state.capped).toBe("redirects");
  });

  it("hands a navigation redirect back one hop at a time, so the browser asks the gate again", async () => {
    const { transport, calls } = fake({
      "https://site.example/old": { status: 301, headers: { location: "/new?a=1&b=2" } },
    });
    const gate = createEgressGate({ transport });
    const answer = await gate.handle(doc("https://site.example/old"));
    expect(answer.action).toBe("fulfill");
    if (answer.action !== "fulfill") throw new Error("unreachable");
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toMatch(/^text\/html/);
    expect(answer.body.toString()).toContain(
      '<meta http-equiv="refresh" content="0;url=https://site.example/new?a=1&amp;b=2">',
    );
    // Only the first hop was asked for here: the next one is the browser's request, checked when it arrives.
    expect(calls).toHaveLength(1);
    // A redirect is never passed to the browser as a redirect: it would follow it on its own network.
    expect(answer.status).not.toBeGreaterThanOrEqual(300);
  });

  it("escapes a hostile Location in the interstitial", async () => {
    const { transport } = fake({
      "https://site.example/old": {
        status: 302,
        headers: { location: 'https://site.example/x"><script>alert(1)</script>' },
      },
    });
    const answer = await createEgressGate({ transport }).handle(doc("https://site.example/old"));
    if (answer.action !== "fulfill") throw new Error("expected a page");
    expect(answer.body.toString()).not.toContain("<script>");
  });

  it("refuses a navigation redirect to a scheme or host it would never allow, at once", async () => {
    for (const location of ["file:///etc/passwd", "https://www.googletagmanager.com/gtm.js"]) {
      const { transport } = fake({
        "https://site.example/old": { status: 302, headers: { location } },
      });
      const answer = await createEgressGate({ transport }).handle(doc("https://site.example/old"));
      expect(answer.action).toBe("abort");
    }
  });

  it("stops a navigation redirect loop at the redirect cap", async () => {
    const { transport } = fake({
      "https://site.example/loop": { status: 302, headers: { location: "/loop" } },
    });
    const gate = createEgressGate({ transport, limits: { redirects: 3 } });
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(await gate.handle(doc("https://site.example/loop")));
    expect(answers.slice(0, 3).every((a) => a.action === "fulfill")).toBe(true);
    expect(answers[3]).toEqual({ action: "abort", reason: "cap" });
    expect(gate.state.capped).toBe("redirects");
  });

  it("restarts the redirect count when a page is finally served", async () => {
    const { transport } = fake({
      "https://site.example/a": { status: 302, headers: { location: "/b" } },
      "https://site.example/b": { status: 200 },
    });
    const gate = createEgressGate({ transport, limits: { redirects: 1 } });
    await gate.handle(doc("https://site.example/a"));
    await gate.handle(doc("https://site.example/b"));
    expect((await gate.handle(doc("https://site.example/a"))).action).toBe("fulfill");
    expect(gate.state.capped).toBeUndefined();
  });
});

describe("the egress gate: the main page and the caps", () => {
  it("records the final address and status of the main frame's document", async () => {
    const { transport } = fake({
      "https://site.example/a": { status: 302, headers: { location: "/b" } },
      "https://site.example/b": { status: 404, body: "<p>none</p>" },
    });
    const gate = createEgressGate({ transport });
    await gate.handle(doc("https://site.example/a"));
    expect(gate.state.status).toBeUndefined();
    await gate.handle(doc("https://site.example/b"));
    expect(gate.state).toMatchObject({ status: 404, finalUrl: "https://site.example/b" });
  });

  it("does not take a sub-frame or a script for the main page", async () => {
    const { transport } = fake({ "https://site.example/x": {} });
    const gate = createEgressGate({ transport });
    await gate.handle(get("https://site.example/x", { kind: "document", frame: "sub" }));
    await gate.handle(get("https://site.example/x", { kind: "script" }));
    expect(gate.state.status).toBeUndefined();
  });

  it("remembers why the main page was blocked", async () => {
    const { transport } = fake({});
    const gate = createEgressGate({ transport });
    await gate.handle(doc("file:///etc/passwd"));
    expect(gate.state.mainBlock).toBe("scheme");
  });

  it("clears the block when a later document of the main frame is served", async () => {
    const { transport } = fake({ "https://site.example/ok": {} });
    const gate = createEgressGate({ transport });
    await gate.handle(doc("file:///etc/passwd"));
    expect(gate.state.mainBlock).toBe("scheme");
    await gate.handle(doc("https://site.example/ok"));
    expect(gate.state.mainBlock).toBeUndefined();
  });

  it("says when a redirect is waiting for the browser to come back, and a block ends the wait", async () => {
    const { transport } = fake({
      "https://site.example/old": { status: 302, headers: { location: "/new" } },
    });
    const gate = createEgressGate({ transport });
    await gate.handle(doc("https://site.example/old"));
    expect(gate.state.redirectPending).toBe(true);
    await gate.handle(doc("file:///etc/passwd"));
    expect(gate.state.redirectPending).toBeUndefined();
    expect(gate.state.mainBlock).toBe("scheme");
  });

  it("aborts requests past the cap, and says which cap", async () => {
    const { transport, calls } = fake({ "https://site.example/x": {} });
    const gate = createEgressGate({ transport, limits: { requests: 3 } });
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await gate.handle(get("https://site.example/x")));
    expect(answers.map((a) => a.action)).toEqual([
      "fulfill",
      "fulfill",
      "fulfill",
      "abort",
      "abort",
    ]);
    expect(calls).toHaveLength(3);
    expect(gate.state.capped).toBe("requests");
    expect(gate.state.totalRequests).toBe(5);
    // The list is bounded by the cap too.
    expect(gate.state.requests).toHaveLength(3);
  });

  it("aborts a response over the per-response cap and a download over the total", async () => {
    const big = "x".repeat(2000);
    const { transport } = fake({
      "https://site.example/big": { body: big },
      "https://site.example/a": { body: "x".repeat(600) },
      "https://site.example/b": { body: "x".repeat(600) },
    });
    const one = createEgressGate({ transport, limits: { responseBytes: 1000 } });
    expect(await one.handle(get("https://site.example/big"))).toEqual({
      action: "abort",
      reason: "cap",
    });
    expect(one.state.capped).toBe("bytes");

    const total = createEgressGate({ transport, limits: { bytes: 1000, responseBytes: 1000 } });
    expect((await total.handle(get("https://site.example/a"))).action).toBe("fulfill");
    expect((await total.handle(get("https://site.example/b"))).action).toBe("abort");
    expect(total.state.capped).toBe("bytes");
    expect(total.state.bytes).toBeLessThanOrEqual(1000);
  });

  it("stops reading a response as soon as it passes the cap", async () => {
    let produced = 0;
    const transport: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: Readable.from(
          (function* () {
            for (;;) {
              produced += 1;
              yield Buffer.alloc(1024);
            }
          })(),
        ),
      });
    const gate = createEgressGate({ transport, limits: { responseBytes: 10 * 1024 } });
    expect((await gate.handle(get("https://site.example/endless"))).action).toBe("abort");
    expect(produced).toBeLessThan(100);
  });

  it("answers nothing once closed", async () => {
    const { transport, calls } = fake({ "https://site.example/x": {} });
    const gate = createEgressGate({ transport });
    gate.close("time");
    expect(await gate.handle(get("https://site.example/x"))).toEqual({
      action: "abort",
      reason: "cap",
    });
    expect(calls).toEqual([]);
    expect(gate.state.capped).toBe("time");
  });

  it("counts windows, forms and WebSockets the page tried, and sends none", () => {
    const gate = createEgressGate({ transport: vi.fn() });
    gate.note("websocket");
    gate.note("popup");
    gate.note("popup");
    gate.note("form");
    expect(gate.state.blocked).toMatchObject({ websocket: 1, popup: 2, form: 1 });
  });

  it("blocks a request from a window the page opened", async () => {
    const { transport, calls } = fake({ "https://site.example/pop": {} });
    const gate = createEgressGate({ transport });
    expect(await gate.handle(get("https://site.example/pop", { frame: "popup" }))).toEqual({
      action: "abort",
      reason: "popup",
    });
    expect(calls).toEqual([]);
  });

  it("keeps no more than a short address in a record", async () => {
    const { transport } = fake({});
    const gate = createEgressGate({ transport });
    await gate.handle(get(`https://site.example/${"a".repeat(5000)}`, { method: "POST" }));
    expect(gate.state.requests[0]?.url.length).toBeLessThanOrEqual(300);
  });
});
