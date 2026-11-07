import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { allowedHosts, checkRequest, REFUSAL_TEXT } from "../origin.js";
import { createSession, sessionCookie } from "../session.js";
import { startApp, type RunningApp } from "../server.js";

const P = 4817;

describe("cross-site rules: unit", () => {
  it("allowedHosts is exactly two strings", () => {
    expect([...allowedHosts(P)]).toEqual(["localhost:4817", "127.0.0.1:4817"]);
  });

  it("checkRequest: the table", () => {
    const ok = { ok: true };
    const no = (reason: string) => ({ ok: false, reason });
    const rows: [string, string | undefined, string | undefined, string | undefined, unknown][] = [
      // method, host, origin, sec-fetch-site, result
      ["GET", "localhost:4817", undefined, undefined, ok],
      ["GET", "127.0.0.1:4817", undefined, undefined, ok],
      ["GET", "LOCALHOST:4817", undefined, undefined, ok],
      ["GET", "localhost", undefined, undefined, no("host")],
      ["GET", "localhost:4818", undefined, undefined, no("host")],
      ["GET", "attacker.example", undefined, undefined, no("host")],
      ["GET", "attacker.example:4817", undefined, undefined, no("host")],
      ["GET", "[::1]:4817", undefined, undefined, no("host")],
      ["GET", "0.0.0.0:4817", undefined, undefined, no("host")],
      ["GET", "", undefined, undefined, no("host")],
      ["GET", undefined, undefined, undefined, no("host")],
      ["GET", "localhost.:4817", undefined, undefined, no("host")],
      ["GET", "127.0.0.1.attacker.example:4817", undefined, undefined, no("host")],
      ["GET", "localhost.evil.example:4817", undefined, undefined, no("host")],
      ["GET", "localhost:4817", "http://localhost:4817", undefined, ok],
      ["GET", "localhost:4817", "http://127.0.0.1:4817", undefined, ok],
      ["GET", "localhost:4817", "https://localhost:4817", undefined, no("origin")],
      ["GET", "localhost:4817", "http://localhost:4818", undefined, no("origin")],
      ["GET", "localhost:4817", "null", undefined, no("origin")],
      ["GET", "localhost:4817", "https://evil.example", undefined, no("origin")],
      ["POST", "localhost:4817", "http://localhost:4817", undefined, ok],
      ["POST", "localhost:4817", undefined, undefined, no("origin")],
      ["OPTIONS", "localhost:4817", undefined, undefined, no("origin")],
      ["HEAD", "localhost:4817", undefined, undefined, ok],
      ["GET", "localhost:4817", undefined, "same-origin", ok],
      ["GET", "localhost:4817", undefined, "none", ok],
      ["GET", "localhost:4817", undefined, "cross-site", no("fetch-site")],
      ["GET", "localhost:4817", undefined, "same-site", no("fetch-site")],
    ];
    expect(rows.length).toBeGreaterThanOrEqual(24);
    for (const [method, host, origin, secFetchSite, want] of rows)
      expect(
        checkRequest({ method, host, origin, secFetchSite }, P),
        `${method} ${host} ${origin} ${secFetchSite}`,
      ).toEqual(want);
  });

  it("session: the key exchanges once; isValid for missing, wrong and right", () => {
    const s = createSession("the-key");
    expect(s.exchange("wrong")).toBeNull();
    const token = s.exchange("the-key");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe("the-key");
    expect(s.exchange("the-key")).toBeNull();
    expect([s.isValid(undefined), s.isValid("wrong"), s.isValid(token ?? "")]).toEqual([
      false,
      false,
      true,
    ]);
    expect(createSession("k").isValid("anything")).toBe(false);
  });

  it("cookie parsing: several cookies, duplicate names, spaces, no header", () => {
    expect(sessionCookie("a=1; gl_session=abc; b=2")).toBe("abc");
    expect(sessionCookie("gl_session=first; gl_session=second")).toBe("first");
    expect(sessionCookie("   gl_session =  spaced  ;x=y")).toBe("spaced");
    expect(sessionCookie("xgl_session=no; gl_sessionx=no")).toBeUndefined();
    expect(sessionCookie(undefined)).toBeUndefined();
    expect(sessionCookie("")).toBeUndefined();
  });
});

/** One raw HTTP/1.1 request to 127.0.0.1:port, headers exactly as given: what a hostile page can't set. */
function raw(
  port: number,
  lines: string[],
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const c = connect({ host: "127.0.0.1", port }, () =>
      c.end(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`),
    );
    let data = "";
    c.on("data", (d) => (data += d.toString()));
    c.on("end", () => {
      const [head = "", body = ""] = data.split("\r\n\r\n");
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0), head, body });
    });
    c.on("error", reject);
  });
}

/** Start the app and open its link: the session cookie, as a browser would hold it. */
async function opened(
  port: number,
): Promise<{ app: RunningApp; cookie: string; host: string; set: string }> {
  const app = await startApp({ port });
  const host = `localhost:${app.port}`;
  const path = new URL(app.url).search;
  const r = await raw(app.port, [`GET /${path} HTTP/1.1`, `Host: ${host}`, "Sec-Fetch-Site: none"]);
  const set = /^set-cookie: (.+)$/im.exec(r.head)?.[1] ?? "";
  expect(r.status).toBe(303);
  expect(r.head).toMatch(/^location: \/\r?$/im);
  return { app, cookie: set.split(";")[0] ?? "", host, set };
}

describe("cross-site rules: integration (real sockets)", () => {
  it("the link: 303 to /, Set-Cookie with HttpOnly, SameSite=Strict and Path=/, no Secure, no Domain", async () => {
    const { app, set, cookie, host } = await opened(5010);
    try {
      expect(set).toMatch(/^gl_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
      expect(set).not.toMatch(/Secure|Domain/i);
      const page = await raw(app.port, ["GET / HTTP/1.1", `Host: ${host}`, `Cookie: ${cookie}`]);
      expect(page.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("the same link a second time, without the cookie: 403", async () => {
    const { app, host } = await opened(5020);
    try {
      const again = await raw(app.port, [
        `GET /${new URL(app.url).search} HTTP/1.1`,
        `Host: ${host}`,
      ]);
      expect([again.status, again.body]).toEqual([403, REFUSAL_TEXT.session]);
    } finally {
      await app.close();
    }
  });

  it("a valid cookie on a POST from https://evil.example, or with no Origin: 403", async () => {
    const { app, cookie, host } = await opened(5030);
    try {
      const evil = await raw(app.port, [
        "POST / HTTP/1.1",
        `Host: ${host}`,
        `Cookie: ${cookie}`,
        "Origin: https://evil.example",
        "Content-Length: 0",
      ]);
      const bare = await raw(app.port, [
        "POST / HTTP/1.1",
        `Host: ${host}`,
        `Cookie: ${cookie}`,
        "Content-Length: 0",
      ]);
      expect([evil.status, evil.body, bare.status, bare.body]).toEqual([
        403,
        REFUSAL_TEXT.origin,
        403,
        REFUSAL_TEXT.origin,
      ]);
    } finally {
      await app.close();
    }
  });

  it("DNS rebinding: 127.0.0.1:<port> with Host attacker.example:<port> and a valid cookie: 403", async () => {
    const { app, cookie } = await opened(5040);
    try {
      const r = await raw(app.port, [
        "GET / HTTP/1.1",
        `Host: attacker.example:${app.port}`,
        `Cookie: ${cookie}`,
      ]);
      expect([r.status, r.body]).toEqual([403, REFUSAL_TEXT.host]);
    } finally {
      await app.close();
    }
  });

  it("an OPTIONS preflight from another origin: 403 and no Access-Control-* header", async () => {
    const { app, host } = await opened(5050);
    try {
      const r = await raw(app.port, [
        "OPTIONS / HTTP/1.1",
        `Host: ${host}`,
        "Origin: https://evil.example",
        "Access-Control-Request-Method: POST",
      ]);
      expect(r.status).toBe(403);
      expect(r.head).not.toMatch(/access-control-/i);
    } finally {
      await app.close();
    }
  });
});

describe("cross-site rules: edge cases", () => {
  it("Host in upper case is accepted; a trailing dot is refused", async () => {
    const { app, cookie } = await opened(5060);
    try {
      const upper = await raw(app.port, [
        "GET / HTTP/1.1",
        `Host: LOCALHOST:${app.port}`,
        `Cookie: ${cookie}`,
      ]);
      const dot = await raw(app.port, [
        "GET / HTTP/1.1",
        `Host: localhost.:${app.port}`,
        `Cookie: ${cookie}`,
      ]);
      expect([upper.status, dot.status]).toEqual([200, 403]);
    } finally {
      await app.close();
    }
  });

  it("two Host headers on one request: refused", async () => {
    const { app, cookie, host } = await opened(5070);
    try {
      const r = await raw(app.port, [
        "GET / HTTP/1.1",
        `Host: ${host}`,
        `Host: ${host}`,
        `Cookie: ${cookie}`,
      ]);
      expect(r.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("a cookie of the right length with wrong bytes: 403 with the same body as no cookie", async () => {
    const { app, cookie, host } = await opened(5080);
    try {
      const value = cookie.split("=")[1] ?? "";
      const wrong = `gl_session=${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
      const bad = await raw(app.port, ["GET / HTTP/1.1", `Host: ${host}`, `Cookie: ${wrong}`]);
      const none = await raw(app.port, ["GET / HTTP/1.1", `Host: ${host}`]);
      expect([bad.status, bad.body]).toEqual([403, none.body]);
      expect(none.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("127.0.0.1.attacker.example:<port> is refused: exact match, no suffix or prefix", async () => {
    const { app, cookie } = await opened(5090);
    try {
      const r = await raw(app.port, [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1.attacker.example:${app.port}`,
        `Cookie: ${cookie}`,
      ]);
      expect(r.status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
