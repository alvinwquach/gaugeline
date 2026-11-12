import { describe, expect, it } from "vitest";
import { gateRequestHandler } from "../function.js";
import { requestGate } from "../request.js";
import { SITE, barSite, downSite, memorySite, type MemoryPage } from "./helpers.js";

const FN = "https://gate.lantern-yard.example/check";
const STUDIO = "https://lantern-yard.sanity.studio";
const now = () => new Date("2026-11-12T10:00:00Z");

function world(menuBody: string, extra: Record<string, MemoryPage> = {}, over = {}) {
  const seen: { method: string; url: string }[] = [];
  const handler = gateRequestHandler({
    site: SITE,
    allowOrigin: STUDIO,
    transport: memorySite(barSite(menuBody, extra), seen),
    now,
    ...over,
  });
  /** The browser's fetch, wired to the handler the way a host would mount it. */
  const fetch = ((url: string | URL, init?: RequestInit) =>
    handler(
      new Request(String(url), { method: init?.method ?? "GET", headers: { origin: STUDIO } }),
    )) as typeof globalThis.fetch;
  return { handler, fetch, seen };
}
const get = (query: string, headers: Record<string, string> = { origin: STUDIO }, method = "GET") =>
  new Request(`${FN}${query}`, { method, headers });

describe("the endpoint: the Publish button's check, end to end", () => {
  it("a page with a dead link comes back as findings that name the link", async () => {
    const { fetch } = world('<a href="/menu/old-cocktails">Old cocktails</a>');
    const answer = await requestGate({ functionUrl: FN, pageUrl: `${SITE}/menu`, fetch });
    expect(answer.status).toBe("findings");
    expect(answer.url).toBe(`${SITE}/menu`);
    expect(answer.checkedAt).toBe("2026-11-12T10:00:00.000Z");
    const broken = answer.findings.find((f) => f.id === "broken-links");
    expect(broken?.severity).toBe("high");
    expect(broken?.evidence).toContain("/menu/old-cocktails");
  });

  it("fix the link and the same request comes back clean", async () => {
    const { fetch } = world('<a href="/">Back to the bar</a>');
    expect(await requestGate({ functionUrl: FN, pageUrl: `${SITE}/menu`, fetch })).toMatchObject({
      status: "clean",
      findings: [],
    });
  });

  it("a site that is down is could-not-check, never clean", async () => {
    const { fetch } = world("<p>x</p>", {}, { transport: downSite });
    const answer = await requestGate({ functionUrl: FN, pageUrl: `${SITE}/menu`, fetch });
    expect(answer.status).toBe("could-not-check");
    expect(answer.reason).toBeTruthy();
  });

  it("a page that answers 404 is could-not-check", async () => {
    const { fetch } = world("<p>x</p>");
    const answer = await requestGate({ functionUrl: FN, pageUrl: `${SITE}/no-such-page`, fetch });
    expect(answer).toMatchObject({ status: "could-not-check", reason: "The page answered 404." });
  });

  it("only blocking findings are listed: blockOn decides what holds the button", async () => {
    const body = '<a href="/menu/old-cocktails">Old cocktails</a>';
    const { fetch: high } = world(body, {}, { blockOn: "high" });
    const { fetch: low } = world(body, {}, { blockOn: "low" });
    const a = await requestGate({ functionUrl: FN, pageUrl: `${SITE}/menu`, fetch: high });
    const b = await requestGate({ functionUrl: FN, pageUrl: `${SITE}/menu`, fetch: low });
    expect(b.findings.length).toBeGreaterThanOrEqual(a.findings.length);
    expect(a.findings.every((f) => f.severity === "high")).toBe(true);
  });

  it("two editors publishing the same document at once share one check", async () => {
    const { handler, seen } = world('<a href="/">Back</a>');
    const [a, b] = await Promise.all([
      handler(get(`?url=${encodeURIComponent(`${SITE}/menu`)}`)),
      handler(get(`?url=${encodeURIComponent(`${SITE}/menu`)}`)),
    ]);
    expect(await a.json()).toEqual(await b.json());
    expect(seen.filter((s) => s.url === `${SITE}/menu` && s.method === "GET")).toHaveLength(1);
  });

  it("a second ask inside the cache window does not read the page again; after it, it does", async () => {
    let t = 0;
    const { handler, seen } = world('<a href="/">Back</a>', {}, { cacheMs: 1000, clock: () => t });
    const ask = () => handler(get(`?url=${encodeURIComponent(`${SITE}/menu`)}`));
    await ask();
    const after = seen.length;
    t = 500;
    await ask();
    expect(seen.length).toBe(after);
    t = 1500;
    await ask();
    expect(seen.length).toBeGreaterThan(after);
  });
});

describe("the endpoint: what it refuses", () => {
  const url = (u: string) => `?url=${encodeURIComponent(u)}`;

  it("an address that is not on the configured site is refused, and nothing is requested", async () => {
    const { handler, seen } = world("<p>x</p>");
    for (const target of [
      "https://evil.example/menu",
      "https://www.lantern-yard.example/menu",
      "http://lantern-yard.example/menu",
      "https://lantern-yard.example:8443/menu",
      "https://user:pw@lantern-yard.example/menu",
      "ftp://lantern-yard.example/menu",
      "//evil.example/menu",
      "/menu",
      "",
    ]) {
      const res = await handler(get(url(target)));
      expect(res.status, target).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("anything but one url parameter is refused", async () => {
    const { handler, seen } = world("<p>x</p>");
    for (const query of [
      "",
      `?url=${SITE}/menu&url=${SITE}/`,
      `?url=${SITE}/menu&x=1`,
      `?x=${SITE}/menu`,
      `?url=${"a".repeat(3000)}`,
    ])
      expect((await handler(get(query))).status, query).toBe(400);
    expect(seen).toEqual([]);
  });

  it("only GET is answered", async () => {
    const { handler, seen } = world("<p>x</p>");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await handler(
        new Request(`${FN}${url(`${SITE}/menu`)}`, { method, headers: { origin: STUDIO } }),
      );
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect(seen).toEqual([]);
  });

  it("a browser from another origin gets 403 and nothing is requested", async () => {
    const { handler, seen } = world("<p>x</p>");
    const res = await handler(get(url(`${SITE}/menu`), { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("a request with no Origin (curl, a script) is answered, without a CORS header", async () => {
    const { handler } = world('<a href="/">Back</a>');
    const res = await handler(get(url(`${SITE}/menu`), {}));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allowOrigin is one exact https origin: a wildcard, a path or http is a setup error", () => {
    for (const allowOrigin of [
      "*",
      "https://*.sanity.studio",
      "http://lantern-yard.sanity.studio",
      `${STUDIO}/desk`,
      "null",
      "",
    ])
      expect(() => gateRequestHandler({ site: SITE, allowOrigin }), allowOrigin).toThrow(
        /allowOrigin/,
      );
  });

  it("the page redirecting to another host is could-not-check, and the other host is never requested", async () => {
    const { handler, seen } = world("<p>x</p>", {
      "/old": { status: 301, body: "", location: "https://evil.example/" },
    });
    const res = await handler(get(url(`${SITE}/old`)));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("could-not-check");
    expect(seen.every((s) => new URL(s.url).host === "lantern-yard.example")).toBe(true);
  });
});

describe("the endpoint: how it answers", () => {
  it("sends JSON that is not cached, not sniffed, and readable only by the Studio's origin", async () => {
    const { handler } = world('<a href="/">Back</a>');
    const res = await handler(get(`?url=${encodeURIComponent(`${SITE}/menu`)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe(STUDIO);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("an error reply holds a fixed sentence, never the text that was sent", async () => {
    const { handler } = world("<p>x</p>");
    const res = await handler(get(`?url=${encodeURIComponent("https://evil.example/<script>")}`));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/evil|script/);
  });

  it("holds no Sanity token and sends no request but GET and HEAD to the page's own host", async () => {
    const { handler, seen } = world('<a href="/menu/old-cocktails">Old</a>');
    await handler(get(`?url=${encodeURIComponent(`${SITE}/menu`)}`));
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET", "HEAD"]));
    expect(seen.every((s) => new URL(s.url).host === "lantern-yard.example")).toBe(true);
  });
});
