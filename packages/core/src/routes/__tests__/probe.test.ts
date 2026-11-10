import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { LIMITS } from "../../limits.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import type { RouteEntry } from "../discover.js";
import {
  anonymousPageAsk,
  classifyAnswer,
  planProbes,
  probeRouteDetails,
  probeRoutes,
  routeAddress,
  sniffPage,
} from "../probe.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const guarded = (path: string, extra: Partial<RouteEntry> = {}): RouteEntry => ({
  path,
  file: `app${path}/page.tsx`,
  dynamic: path.includes("["),
  expectsSession: true,
  reason: "the page calls auth()",
  ...extra,
});

const hop = (
  status: number,
  headers: Record<string, string> = {},
  extra: Partial<Hop> = {},
): Hop => ({
  url: "http://127.0.0.1:1/account/invoices",
  status,
  headers,
  ms: 1,
  ...extra,
});

const ADDRESS = "http://127.0.0.1:1/account/invoices";
const bytes = (text: string) => new TextEncoder().encode(text);

describe("classifyAnswer: unit", () => {
  it("200 with a page is handed over, with its size", () => {
    expect(classifyAnswer(hop(200, {}, { peek: "page", bytes: 1204 }), ADDRESS)).toEqual({
      result: "handed-over",
      status: 200,
      bytes: 1204,
    });
  });

  it("a 302 to /login is redirected-to-login, and the target keeps no query string", () => {
    expect(
      classifyAnswer(
        hop(302, { location: "/login?next=%2Faccount%2Finvoices&token=abc" }),
        ADDRESS,
      ),
    ).toEqual({ result: "redirected-to-login", status: 302, to: "/login" });
    // Every redirect status, and a redirect that leaves the site, names the host only.
    for (const s of [301, 303, 307, 308])
      expect(classifyAnswer(hop(s, { location: "/sign-in" }), ADDRESS).result).toBe(
        "redirected-to-login",
      );
    expect(
      classifyAnswer(hop(302, { location: "https://sso.example/start?x=1" }), ADDRESS),
    ).toEqual({
      result: "redirected-to-login",
      status: 302,
      to: "sso.example",
    });
  });

  it("a redirect to the same address, or with no address, says nothing about the route", () => {
    expect(classifyAnswer(hop(308, { location: "/account/invoices/" }), ADDRESS).result).toBe(
      "error",
    );
    expect(classifyAnswer(hop(302), ADDRESS)).toMatchObject({ result: "error", status: 302 });
    expect(classifyAnswer(hop(302, { location: "http://[bad" }), ADDRESS).result).toBe("error");
  });

  it("401 and 403 are refused, 404 is not found, and 500 and the rest are errors", () => {
    expect(classifyAnswer(hop(401), ADDRESS)).toEqual({ result: "refused", status: 401 });
    expect(classifyAnswer(hop(403), ADDRESS)).toEqual({ result: "refused", status: 403 });
    expect(classifyAnswer(hop(404), ADDRESS)).toEqual({ result: "not-found", status: 404 });
    for (const s of [204, 400, 405, 410, 429, 500, 503])
      expect(classifyAnswer(hop(s), ADDRESS)).toMatchObject({ result: "error", status: s });
    expect(classifyAnswer(hop(500), ADDRESS).note).toContain("500");
  });

  it("a 200 whose body is a sign-in form is refused, and a 200 with nothing is empty", () => {
    expect(classifyAnswer(hop(200, {}, { peek: "login", bytes: 900 }), ADDRESS)).toMatchObject({
      result: "refused",
      signInForm: true,
    });
    expect(classifyAnswer(hop(200, {}, { peek: "empty", bytes: 0 }), ADDRESS)).toMatchObject({
      result: "handed-over",
      empty: true,
      bytes: 0,
    });
  });

  it("a body longer than was read is capped, and a Content-Length is kept", () => {
    const answer = classifyAnswer(
      hop(200, { "content-length": "250000" }, { peek: "page", bytes: LIMITS.routeProbeBytes }),
      ADDRESS,
    );
    expect(answer).toMatchObject({ capped: true, contentLength: 250000 });
    expect(
      classifyAnswer(hop(200, { "content-length": "nope" }, { peek: "page", bytes: 4 }), ADDRESS),
    ).not.toHaveProperty("contentLength");
  });
});

describe("sniffPage: unit", () => {
  it("finds a password field however it is written, and tells nothing from a page", () => {
    expect(sniffPage(bytes('<form><input type="password" name="p"></form>'))).toBe("login");
    expect(sniffPage(bytes("<INPUT NAME=p TYPE=password>"))).toBe("login");
    expect(sniffPage(bytes("<input\n  class='a'\n  type = 'password'>"))).toBe("login");
    expect(sniffPage(bytes('<input type="text"><p>password</p>'))).toBe("page");
    expect(sniffPage(bytes("<h1>Invoices</h1>"))).toBe("page");
    expect(sniffPage(bytes(""))).toBe("empty");
    expect(sniffPage(bytes(" \n\t "))).toBe("empty");
  });
});

describe("planProbes: unit", () => {
  it("asks only routes that expect a session and have no dynamic segment, and lists a dynamic one as needing a real id", () => {
    const { probe, skipped } = planProbes([
      guarded("/b"),
      guarded("/a"),
      guarded("/orders/[id]"),
      { path: "/pricing", file: "app/pricing/page.tsx", dynamic: false, expectsSession: false },
      guarded("/a"),
    ]);
    expect(probe.map((r) => r.path)).toEqual(["/a", "/b"]);
    expect(skipped).toEqual([
      { path: "/orders/[id]", file: "app/orders/[id]/page.tsx", reason: "needs a real id" },
    ]);
  });

  it("asks 30 of 45 guarded routes and lists the other 15", () => {
    const routes = Array.from({ length: 45 }, (_, i) => guarded(`/r${String(i).padStart(2, "0")}`));
    const { probe, skipped } = planProbes([...routes].reverse());
    expect(probe).toHaveLength(30);
    expect(probe[0]?.path).toBe("/r00");
    expect(probe.at(-1)?.path).toBe("/r29");
    expect(skipped).toHaveLength(15);
    expect(skipped[0]).toMatchObject({ path: "/r30" });
    expect(skipped[0]?.reason).toContain("at most 30");
  });
});

describe("routeAddress: unit", () => {
  it("joins the base path and the route path, and never carries a query string", () => {
    expect(routeAddress(new URL("https://example.com"), "/account")).toBe(
      "https://example.com/account",
    );
    expect(routeAddress(new URL("https://example.com/"), "/")).toBe("https://example.com/");
    expect(routeAddress(new URL("https://example.com/shop/?a=1#x"), "/account")).toBe(
      "https://example.com/shop/account",
    );
    expect(routeAddress(new URL("https://example.com/shop"), "/")).toBe("https://example.com/shop");
  });
});

const page =
  (body = "<h1>Invoices</h1>"): Handler =>
  (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  };
const status =
  (code: number, headers: Record<string, string> = {}, body = ""): Handler =>
  (_req, res) => {
    res.writeHead(code, { "content-type": "text/plain", ...headers }).end(body);
  };

async function ask(routes: Record<string, Handler>, entries: RouteEntry[]) {
  const server = await startServer(routes);
  servers.push(server);
  const fetcher = createFetcher({ allowPrivate: true });
  const details = await probeRouteDetails(entries, server.origin, fetcher);
  return { server, fetcher, ...details };
}

describe("probeRoutes: integration (four routes on 127.0.0.1)", () => {
  it("one guarded by middleware (302), one in the page (401), one that renders anyway (200), one public", async () => {
    const server = await startServer({
      "/appointments": status(302, { location: "/login?next=/appointments" }),
      "/account/payments": status(401),
      "/account/invoices": page(),
      "/": page("<h1>Home</h1>"),
    });
    servers.push(server);
    const routes = [
      guarded("/appointments"),
      guarded("/account/payments"),
      guarded("/account/invoices"),
      { path: "/", file: "app/(site)/page.tsx", dynamic: false, expectsSession: false },
    ];
    const results = await probeRoutes(routes, server.origin, createFetcher({ allowPrivate: true }));
    expect(Object.fromEntries(results)).toEqual({
      "/appointments": "redirected-to-login",
      "/account/payments": "refused",
      "/account/invoices": "handed-over",
    });
    // The public page is not asked, and the login page a redirect names is not followed.
    expect(server.log.map((r) => r.path).sort()).toEqual([
      "/account/invoices",
      "/account/payments",
      "/appointments",
    ]);
  });

  it("returns the numbers behind a result: status, size, where a redirect went", async () => {
    const { answers } = await ask(
      { "/a": page("x".repeat(700)), "/b": status(302, { location: "/login" }), "/c": status(500) },
      [guarded("/a"), guarded("/b"), guarded("/c")],
    );
    expect(answers.get("/a")).toMatchObject({ result: "handed-over", status: 200, bytes: 700 });
    expect(answers.get("/b")).toMatchObject({
      result: "redirected-to-login",
      status: 302,
      to: "/login",
    });
    expect(answers.get("/c")).toMatchObject({ result: "error", status: 500 });
  });

  it("a server that does not answer is that route's error, and the others are still asked", async () => {
    const dead = await startServer({});
    const origin = dead.origin;
    await dead.close();
    const answers = await probeRouteDetails(
      [guarded("/a")],
      origin,
      createFetcher({ allowPrivate: true }),
    );
    expect(answers.answers.get("/a")).toMatchObject({ result: "error" });
    expect(answers.answers.get("/a")?.note).toBeTruthy();
  });

  it("a private address without allowPrivate stops the run instead of marking every route an error", async () => {
    const server = await startServer({ "/a": page() });
    servers.push(server);
    await expect(probeRoutes([guarded("/a")], server.origin, createFetcher())).rejects.toThrow();
    expect(server.log).toHaveLength(0);
  });

  it("an address with a user name or a password is refused before anything is sent", async () => {
    const server = await startServer({ "/a": page() });
    servers.push(server);
    const withLogin = server.origin.replace("http://", "http://dana:secret@");
    await expect(
      probeRoutes([guarded("/a")], withLogin, createFetcher({ allowPrivate: true })),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      probeRoutes([guarded("/a")], "ftp://example.com", createFetcher()),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      probeRoutes([guarded("/a")], "not an address", createFetcher()),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(server.log).toHaveLength(0);
  });
});

describe("probeRoutes: edge cases", () => {
  it("a 200 whose body is the login form is refused, not handed over", async () => {
    const { answers } = await ask(
      {
        "/account": page(
          '<html><form action="/login"><input name="email"><input type="password" name="p"></form></html>',
        ),
      },
      [guarded("/account")],
    );
    expect(answers.get("/account")).toMatchObject({ result: "refused", signInForm: true });
  });

  it("a sign-in form after the first kilobyte is still found", async () => {
    const { answers } = await ask(
      { "/account": page(`<p>${"x".repeat(5000)}</p><input type="password">`) },
      [guarded("/account")],
    );
    expect(answers.get("/account")?.result).toBe("refused");
  });

  it("a route that returns 200 with an empty body is marked empty", async () => {
    const { answers } = await ask({ "/account": status(200) }, [guarded("/account")]);
    expect(answers.get("/account")).toMatchObject({ result: "handed-over", empty: true, bytes: 0 });
  });

  it("a body larger than the read limit is capped and the connection is closed", async () => {
    const { answers } = await ask({ "/account": page("y".repeat(LIMITS.routeProbeBytes * 3)) }, [
      guarded("/account"),
    ]);
    expect(answers.get("/account")).toMatchObject({
      result: "handed-over",
      capped: true,
      bytes: LIMITS.routeProbeBytes,
    });
  });

  it("45 guarded routes: 30 asked, 15 listed as skipped", async () => {
    const routes = Array.from({ length: 45 }, (_, i) => guarded(`/r${String(i).padStart(2, "0")}`));
    const { server, answers, skipped } = await ask({}, routes);
    expect(answers.size).toBe(30);
    expect(skipped).toHaveLength(15);
    expect(server.log).toHaveLength(30);
    // Every answer was a 404, which is what the server sends for an address it does not know.
    expect([...answers.values()].every((a) => a.result === "not-found")).toBe(true);
  });

  it("a dynamic guarded route is listed as not probed and never asked", async () => {
    const { server, answers, skipped } = await ask({}, [guarded("/orders/[id]")]);
    expect(answers.size).toBe(0);
    expect(skipped).toEqual([
      { path: "/orders/[id]", file: "app/orders/[id]/page.tsx", reason: "needs a real id" },
    ]);
    expect(server.log).toHaveLength(0);
  });

  it("asks under the base path of the site", async () => {
    const server = await startServer({ "/clinic/account": page() });
    servers.push(server);
    const results = await probeRoutes(
      [guarded("/account")],
      `${server.origin}/clinic/`,
      createFetcher({ allowPrivate: true }),
    );
    expect(results.get("/account")).toBe("handed-over");
  });
});

describe("probeRoutes: promise test", () => {
  it("every request is a GET with no Cookie, no Authorization and no Referer, and no more than 5 are in flight", async () => {
    const slow: Handler = (_req, res) => {
      setTimeout(() => res.writeHead(401).end(), 40);
    };
    const routes = Array.from({ length: 20 }, (_, i) => guarded(`/r${String(i).padStart(2, "0")}`));
    const server = await startServer({}, slow);
    servers.push(server);
    // A fetcher that would allow more at once: the probe's own limit of 5 still holds.
    const fetcher = createFetcher({ allowPrivate: true, concurrency: 20 });
    await probeRoutes(routes, server.origin, fetcher);
    expect(server.log).toHaveLength(20);
    expect(server.maxConcurrent).toBeLessThanOrEqual(5);
    expect(server.maxConcurrent).toBeGreaterThan(1);
    for (const r of server.log) {
      expect(r.method).toBe("GET");
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.referer).toBeUndefined();
      expect(r.path).not.toContain("?");
    }
  });

  it("the ask has no way to carry a credential: anonymous, no redirects followed, and headers that are not secret", () => {
    const ask = anonymousPageAsk();
    expect(ask.anonymous).toBe(true);
    expect(ask.maxRedirects).toBe(0);
    expect(Object.keys(ask.headers ?? {}).sort()).toEqual(["accept", "accept-encoding"]);
    expect(ask.method).toBeUndefined();
  });
});
