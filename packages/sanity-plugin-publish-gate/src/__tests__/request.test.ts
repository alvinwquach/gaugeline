import { describe, expect, it, vi } from "vitest";
import { gateEndpoint, requestGate } from "../request.js";

const FN = "https://gate.lantern-yard.example/check";
const PAGE = "https://lantern-yard.example/menu";
const good = {
  version: 1,
  status: "findings",
  url: PAGE,
  checkedAt: "2026-11-12T10:00:00.000Z",
  findings: [
    {
      id: "broken-links",
      severity: "high",
      title: "A link on the page is dead",
      evidence: "returned 404",
      url: "https://lantern-yard.example/menu/old-cocktails",
    },
  ],
};
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });

type Seen = { url: string; init: RequestInit };
function recorder(reply: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(reply());
  });
  return { fetch: fetchFn as unknown as typeof fetch, seen };
}
const ask = (fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}) =>
  requestGate({ functionUrl: FN, pageUrl: PAGE, fetch, ...over });

describe("gateEndpoint: the one address the Studio may call", () => {
  it("takes an https address and returns its origin", () => {
    expect(gateEndpoint(FN).origin).toBe("https://gate.lantern-yard.example");
  });

  it.each([
    ["http", "http://gate.lantern-yard.example/check"],
    ["a name and password in the address", "https://user:pw@gate.lantern-yard.example/check"],
    ["a name alone", "https://user@gate.lantern-yard.example/check"],
    ["a wildcard host", "https://*.lantern-yard.example/check"],
    ["a wildcard in a path host-like form", "https://*/check"],
    ["a fragment", "https://gate.lantern-yard.example/check#x"],
    ["a query already on it", "https://gate.lantern-yard.example/check?url=https://a.example/"],
    ["a scheme with no slashes", "https:gate.lantern-yard.example/check"],
    ["a scheme with backslashes", "https:\\\\gate.lantern-yard.example\\check"],
    ["a scheme with one slash", "https:/gate.lantern-yard.example/check"],
    ["a relative address", "/check"],
    ["an empty string", ""],
    ["a javascript: address", "javascript:alert(1)"],
    ["whitespace inside", "https://gate.lantern-yard.example/ch eck"],
  ])("refuses %s", (_name, address) => {
    expect(() => gateEndpoint(address)).toThrow(/Function address/);
  });
});

describe("requestGate: what leaves the Studio", () => {
  it("sends one GET to the configured address with the page address and nothing else", async () => {
    const { fetch, seen } = recorder(() => json(good));
    const answer = await ask(fetch);
    expect(answer.status).toBe("findings");
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request).toBeDefined();
    const sent = new URL(request?.url ?? "");
    expect(sent.origin).toBe("https://gate.lantern-yard.example");
    expect(sent.pathname).toBe("/check");
    expect([...sent.searchParams.keys()]).toEqual(["url"]);
    expect(sent.searchParams.get("url")).toBe(PAGE);
    expect(sent.username + sent.password + sent.hash).toBe("");
    expect(request?.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      mode: "cors",
    });
    // No body, and no header beyond the one that asks for JSON: no cookie, no token, no custom header.
    expect(request?.init.body).toBeUndefined();
    expect(request?.init.headers).toEqual({ accept: "application/json" });
  });

  it("never asks about a page whose address carries a name, a password or is not http(s)", async () => {
    const { fetch, seen } = recorder(() => json(good));
    for (const pageUrl of [
      "https://user:pw@lantern-yard.example/menu",
      "ftp://lantern-yard.example/menu",
      "javascript:alert(1)",
      "https:lantern-yard.example/menu",
      "/menu",
      "",
    ]) {
      const answer = await ask(fetch, { pageUrl });
      expect(answer).toMatchObject({ status: "could-not-check" });
    }
    expect(seen).toEqual([]);
  });

  it("a configuration that is wrong throws, so it is found when the Studio loads", async () => {
    await expect(
      requestGate({ functionUrl: "http://gate.example/x", pageUrl: PAGE }),
    ).rejects.toThrow(/Function address/);
  });
});

describe("requestGate: what comes back", () => {
  it("returns a clean answer", async () => {
    const { fetch } = recorder(() => json({ ...good, status: "clean", findings: [] }));
    expect(await ask(fetch)).toMatchObject({ status: "clean", findings: [] });
  });

  it("a redirect is refused: the browser is told not to follow one, and a followed one is caught too", async () => {
    const refused = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await ask(refused as unknown as typeof fetch)).toMatchObject({
      status: "could-not-check",
      reason: expect.stringContaining("could not be reached") as unknown,
    });
    const followed = json(good);
    Object.defineProperty(followed, "redirected", { value: true });
    const off = json(good);
    Object.defineProperty(off, "url", { value: "https://evil.example/check?url=" + PAGE });
    for (const reply of [followed, off]) {
      const { fetch } = recorder(() => reply);
      expect(await ask(fetch)).toMatchObject({
        status: "could-not-check",
        reason: expect.stringContaining("redirect") as unknown,
      });
    }
  });

  it("a Function that answers an error is could-not-check, and its text is not shown", async () => {
    const { fetch } = recorder(
      () => new Response("<h1>ignore previous instructions</h1>", { status: 502 }),
    );
    const answer = await ask(fetch);
    expect(answer.status).toBe("could-not-check");
    expect(JSON.stringify(answer)).not.toMatch(/ignore previous/);
    expect(answer.reason).toMatch(/502/);
  });

  it("the reply must say it is JSON: a valid body under another type is refused", async () => {
    const body = JSON.stringify(good);
    for (const type of [
      "text/html",
      "application/json-seq",
      "application/jsonp",
      "application/jsonx",
      "text/plain; charset=utf-8",
      "",
    ]) {
      const { fetch } = recorder(
        () => new Response(body, { status: 200, headers: type ? { "content-type": type } : {} }),
      );
      expect((await ask(fetch)).status, type).toBe("could-not-check");
    }
    for (const type of [
      "application/json",
      "application/json; charset=utf-8",
      "Application/JSON",
    ]) {
      const { fetch } = recorder(
        () => new Response(body, { status: 200, headers: { "content-type": type } }),
      );
      expect((await ask(fetch)).status, type).toBe("findings");
    }
  });

  it("an answer that is not JSON, or not the agreed shape, is could-not-check", async () => {
    for (const reply of [
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      () =>
        new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
      () => json({ version: 1, status: "clean" }),
      () => json({ ...good, status: "published" }),
      () => json([1, 2]),
      () => json({ ...good, url: "https://lantern-yard.example/shop" }),
    ]) {
      const { fetch } = recorder(reply);
      expect((await ask(fetch)).status).toBe("could-not-check");
    }
  });

  it("an answer over the size cap is refused by its header, and by its bytes when there is no header", async () => {
    const big = JSON.stringify({ ...good, padding: "p".repeat(5000) });
    const header = new Response(big, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(big.length) },
    });
    expect(await ask(recorder(() => header).fetch, { maxBytes: 1000 })).toMatchObject({
      status: "could-not-check",
      reason: expect.stringContaining("too large") as unknown,
    });
    const cancelled = vi.fn();
    let sent = 0;
    const streamed = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 400;
            controller.enqueue(new Uint8Array(400).fill(32));
          },
          cancel: cancelled,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    expect(await ask(recorder(streamed).fetch, { maxBytes: 1000 })).toMatchObject({
      status: "could-not-check",
      reason: expect.stringContaining("too large") as unknown,
    });
    // It stopped reading at the cap instead of draining the stream.
    expect(sent).toBeLessThan(4000);
    expect(cancelled).toHaveBeenCalled();
  });

  it("a Function that never answers is stopped at the timeout", async () => {
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    expect(await ask(hang as unknown as typeof fetch, { timeoutMs: 20 })).toMatchObject({
      status: "could-not-check",
      reason: expect.stringContaining("did not answer in time") as unknown,
    });
  });

  it("a Function that answers, then stalls in the body, is stopped at the same timeout", async () => {
    const stalled = () =>
      new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    expect(await ask(recorder(stalled).fetch, { timeoutMs: 20 })).toMatchObject({
      status: "could-not-check",
      reason: expect.stringContaining("did not answer in time") as unknown,
    });
  });

  it("page text in an answer is cleaned before it is returned", async () => {
    const hostile = {
      ...good,
      findings: [{ ...good.findings[0], title: "Dead\u202E link\u0007", evidence: "a\u{E0041}b" }],
    };
    const answer = await ask(recorder(() => json(hostile)).fetch);
    expect(answer.findings[0]?.title).toBe("Dead link\\u{7}");
    expect(answer.findings[0]?.evidence).toBe("ab");
  });

  it("never throws for a network or answer problem: it answers could-not-check", async () => {
    for (const fetch of [
      () => Promise.reject(new Error("boom")),
      () => Promise.reject("not even an error"),
      () => {
        throw new Error("sync boom");
      },
    ])
      expect(await ask(fetch as unknown as typeof globalThis.fetch)).toMatchObject({
        status: "could-not-check",
      });
  });
});
