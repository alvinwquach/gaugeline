import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { brokenLinks } from "../checks/broken-links.js";
import { createFetcher, type Hop } from "../fetcher.js";
import type { CheckContext } from "../model.js";
import { classifyHop } from "../refusal.js";
import { parseResult, buildResult } from "../result.js";
import { runCheckList } from "../runner.js";
import { checkSite } from "../site.js";
import { buildSnapshot } from "../snapshot.js";
import { startServer, type FixtureServer } from "./helpers/server.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const hop = (status: number, body = "", headers: Record<string, string> = {}): Hop => ({
  url: "https://pop.example/",
  status,
  headers: { "content-type": "text/html", ...headers },
  body,
  ms: 1,
});
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const send =
  (status: number, body: string, headers: Record<string, string> = {}) =>
  (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "content-type": "text/html", ...headers }).end(body);
  };

describe("refusal: unit", () => {
  it.each([
    ["200", hop(200, `<p>${words(200)}</p>`), { kind: "ok" }],
    ["301", hop(301), { kind: "ok" }],
    ["403", hop(403), { kind: "refused", reason: "status", status: 403 }],
    ["401", hop(401), { kind: "refused", reason: "status", status: 401 }],
    ["429", hop(429), { kind: "refused", reason: "rate-limit", status: 429 }],
    [
      "503 with Retry-After",
      hop(503, "", { "retry-after": "120" }),
      { kind: "refused", reason: "rate-limit", status: 503 },
    ],
    ["503 without Retry-After", hop(503), { kind: "ok" }],
    [
      "a 200 challenge body",
      hop(200, "<title>Just a moment...</title><p>Checking your browser</p>"),
      { kind: "refused", reason: "challenge", status: 200 },
    ],
    ["a 200 thin page with no marker", hop(200, "<p>Coming soon</p>"), { kind: "ok" }],
  ])("classifyHop: %s", (_name, h, want) => {
    expect(classifyHop(h)).toEqual(want);
  });

  it("a real 404 page that mentions captcha and has 400 words is not a challenge page", () => {
    expect(
      classifyHop(hop(200, `<p>We added a captcha to the contact form. ${words(400)}</p>`)),
    ).toEqual({ kind: "ok" });
  });

  it("a check with one refused sample and no findings is in couldNotCheck, not in passed", async () => {
    const page = buildSnapshot([hop(200, '<a href="/a">A</a>')]);
    const ctx: Partial<CheckContext> = {
      links: async () => ({
        seen: 1,
        taken: [
          {
            url: "https://pop.example/a",
            href: "/a",
            text: "A",
            hops: [{ ...hop(429), url: "https://pop.example/a" }],
          },
        ],
      }),
    };
    const out = await runCheckList([brokenLinks], page, ctx);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toEqual([
      { id: "broken-links", url: "https://pop.example/a", reason: "rate limited (429)" },
    ]);
  });

  it("--json validates with couldNotCheck present and empty on a normal run", () => {
    const r = buildResult({
      url: "https://pop.example/",
      startedAt: new Date(0),
      findings: [],
      passed: ["x"],
      failed: [],
      couldNotCheck: [],
    });
    expect(parseResult(r).couldNotCheck).toEqual([]);
  });
});

describe("refusal: integration", () => {
  it("a site that answers 403: one finding (blocked), zero others, the page checks in couldNotCheck; one request per address", async () => {
    const server = await startServer({}, send(403, "<h1>Forbidden</h1>"));
    servers.push(server);
    const { result } = await checkSite({
      address: `${server.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
    });
    expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
      [
        "blocked",
        "low",
        `${server.origin}/ answered 403: it refuses automated readers, so the page was not checked`,
      ],
    ]);
    expect(result.couldNotCheck.map((c) => c.id)).toContain("canonical-missing");
    expect(
      result.couldNotCheck.every((c) => c.reason === "the page refused automated readers (403)"),
    ).toBe(true);
    expect(result.passed).not.toContain("canonical-missing");
    const paths = server.log.map((l) => `${l.method} ${l.path}`);
    expect(new Set(paths).size).toBe(paths.length);
    // Every request says what it is, the same way: no other user agent, no extra headers.
    expect(new Set(server.log.map((l) => l.headers["user-agent"]))).toEqual(
      new Set(["Gaugeline/0.1 (read-only site check)"]),
    );
  });

  it("3 of 30 links answer 429: zero broken-link findings and three couldNotCheck entries, no retries", async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join(" ");
    const routes: Record<string, ReturnType<typeof send>> = {
      "/": send(
        200,
        `<html><head><title>Hub</title></head><body><main><p>${words(100)}</p>${links}</main></body></html>`,
      ),
    };
    for (let i = 0; i < 30; i++) routes[`/p${i}`] = send(i < 3 ? 429 : 200, "<p>ok</p>");
    const server = await startServer(routes);
    servers.push(server);
    const { result } = await checkSite({
      address: `${server.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
      only: ["broken-links"],
    });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck.map((c) => [c.id, new URL(c.url).pathname, c.reason])).toEqual([
      ["broken-links", "/p0", "rate limited (429)"],
      ["broken-links", "/p1", "rate limited (429)"],
      ["broken-links", "/p2", "rate limited (429)"],
    ]);
    for (const p of ["/p0", "/p1", "/p2"])
      expect(server.log.filter((l) => l.path === p).map((l) => l.method)).toEqual(["HEAD"]);
  });

  it("a 403 on a single admin link while the page loads: one couldNotCheck entry, the run otherwise normal", async () => {
    const server = await startServer({
      "/": send(
        200,
        `<html><head><title>Hub</title></head><body><main><p>${words(100)}</p><a href="/admin">Admin</a> <a href="/about">About</a></main></body></html>`,
      ),
      "/admin": send(403, "no"),
      "/about": send(200, "<p>About</p>"),
    });
    servers.push(server);
    const { result } = await checkSite({
      address: `${server.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
      only: ["broken-links", "blocked"],
    });
    expect(result.couldNotCheck.map((c) => [c.id, new URL(c.url).pathname])).toEqual([
      ["broken-links", "/admin"],
    ]);
    expect(result.findings).toEqual([]);
    expect(result.passed).toEqual(["blocked"]);
  });
});
