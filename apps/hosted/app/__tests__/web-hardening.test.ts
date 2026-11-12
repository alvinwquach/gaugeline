// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The review's findings on part 1, as tests: `next` can only name a path on this app, the stand-in refuses
 * to run anywhere but development and test, sign-out ends the session, the dev server cannot be fooled
 * about its own origin, tokens are checked strictly, and links do not pile up.
 */
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createWebServer } from "../../server/node.js";
import { signHs256, StandInAuth, verifyHs256 } from "../../lib/web/auth.js";
import type { WebDeps } from "../../lib/web/deps.js";
import { safeNext } from "../../lib/web/handlers.js";

const SECRET = "test-secret-not-a-real-key-0123456789abcdef";
const USER = "11111111-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-12T09:00:00Z");
const nowS = NOW.getTime() / 1000;

function auth(over: Partial<ConstructorParameters<typeof StandInAuth>[0]> = {}) {
  const sent: { email: string; token: string }[] = [];
  const a = new StandInAuth({
    secret: SECRET,
    users: { "maya@northgate.test": USER },
    deliver: (email, token) => void sent.push({ email, token }),
    now: () => NOW,
    ...over,
  });
  return { a, sent };
}
const good = {
  sub: USER,
  aud: "authenticated",
  role: "authenticated",
  iss: "gaugeline-stand-in",
  iat: nowS,
  exp: nowS + 3600,
};

describe("next: only a path on this app", () => {
  const refused = [
    "//evil.example/x",
    "/\\evil.example",
    "/\t/evil.example/x",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\u0000/evil.example",
    "/ /evil.example",
    "/ /evil.example",
    "/ /evil.example",
    "/​/evil.example",
    "/\u007f/evil.example",
    "https://evil.example",
    "http://evil.example/x",
    "javascript:alert(1)",
    "evil.example",
    "",
    "/%5c/x".replace("%5c", "\\"),
    "\\\\evil.example",
    "/\\/evil.example",
    "///evil.example",
    "/﻿/evil.example",
  ];
  it.each(refused)("refuses %j", (v) => expect(safeNext(v)).toBe("/"));

  it("the encoded forms a browser sends decode first and are then refused", () => {
    for (const raw of [
      "/%09/evil.example/x",
      "/%0a/evil.example",
      "/%0d/evil.example",
      "/%20/evil.example",
      "/%5c/evil.example",
      "//evil.example",
      "/\\evil.example",
    ]) {
      const decoded = new URLSearchParams(`next=${raw}`).get("next");
      expect(safeNext(decoded), raw).toBe("/");
    }
  });

  it("keeps a path on this app, with its query, and drops a fragment", () => {
    expect(safeNext("/last-night")).toBe("/last-night");
    expect(safeNext("/sites?x=1&y=%20z")).toBe("/sites?x=1&y=%20z");
    expect(safeNext("/a/b#frag")).toBe("/a/b");
    expect(safeNext("/%2f/x")).toBe("/%2f/x"); // still one path on this app: no host can come out of it
    expect(safeNext("/@evil.example")).toBe("/@evil.example");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("/".repeat(1) + "a".repeat(3000))).toBe("/");
  });

  it("whatever it returns parses as this app's origin", () => {
    for (const v of [...refused, "/ok", "/%2f/x", "/@x", "/a?b=//c"]) {
      const out = safeNext(v);
      expect(new URL(out, "http://app.test").origin, v).toBe("http://app.test");
      expect(out).toMatch(/^\/(?![/\\])/);
      expect([...out].every((ch) => (ch.codePointAt(0) ?? 0) > 0x20 && ch !== "\u007f")).toBe(true);
    }
  });
});

describe("the stand-in runs only in development and test", () => {
  it.each([
    undefined,
    "",
    "production",
    "Production",
    "PRODUCTION",
    "prod",
    "staging",
    " production",
    "development ",
    "dev",
    "Test",
  ])("refuses NODE_ENV=%j", (nodeEnv) => {
    expect(() => auth({ nodeEnv })).toThrow(/development and test/);
  });
  it.each(["development", "test"])("allows NODE_ENV=%s", (nodeEnv) => {
    expect(() => auth({ nodeEnv })).not.toThrow();
  });
});

describe("secrets", () => {
  it("must be 32 characters and look random: a repeated letter is refused", () => {
    expect(() => auth({ secret: "a".repeat(40) })).toThrow(/random/);
    expect(() => auth({ secret: "abababababababababababababababab" })).toThrow(/random/);
    expect(() => auth({ secret: "short" })).toThrow(/at least 32/);
    expect(() => auth({ secret: SECRET })).not.toThrow();
  });
});

describe("tokens are checked strictly", () => {
  it("takes a good one and returns its sub in lower case", () => {
    const { a } = auth();
    expect(a.verify(signHs256(good, SECRET))?.sub).toBe(USER);
    expect(a.verify(signHs256({ ...good, sub: USER.toUpperCase() }, SECRET))?.sub).toBe(USER);
  });

  it("refuses the wrong typ, a future nbf or iat, a wrong or missing issuer and a lifetime above 30 days", () => {
    const { a } = auth();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const resign = (h: object, p: object) => {
      const head = b64(h);
      const body = b64(p);
      return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
    };
    expect(a.verify(resign({ alg: "HS256", typ: "JWT" }, good))).not.toBeNull();
    expect(a.verify(resign({ alg: "HS256", typ: "JWE" }, good))).toBeNull();
    expect(a.verify(resign({ alg: "HS256" }, good))).toBeNull();
    expect(a.verify(signHs256({ ...good, nbf: nowS + 3600 }, SECRET))).toBeNull();
    expect(a.verify(signHs256({ ...good, nbf: nowS - 5 }, SECRET))).not.toBeNull();
    expect(a.verify(signHs256({ ...good, iat: nowS + 3600 }, SECRET))).toBeNull();
    expect(a.verify(signHs256({ ...good, iat: nowS + 30 }, SECRET))).not.toBeNull(); // clock skew
    expect(a.verify(signHs256({ ...good, iss: "someone-else" }, SECRET))).toBeNull();
    const noIss: Record<string, unknown> = { ...good };
    delete noIss.iss;
    expect(a.verify(signHs256(noIss, SECRET))).toBeNull();
    expect(a.verify(signHs256({ ...good, exp: nowS + 30 * 86400 + 1 }, SECRET))).toBeNull();
    expect(a.verify(signHs256({ ...good, exp: nowS + 30 * 86400 }, SECRET))).not.toBeNull();
    expect(a.verify(signHs256({ ...good, exp: "4000000000" }, SECRET))).toBeNull();
  });

  it("refuses a padded or otherwise non-canonical signature, and a token over 8 KB", () => {
    const { a } = auth();
    const t = signHs256(good, SECRET);
    expect(a.verify(`${t}==`)).toBeNull();
    expect(verifyHs256(`${t}==`, SECRET)).toBeNull();
    expect(verifyHs256(t, SECRET)).not.toBeNull();
    const fat = signHs256({ ...good, pad: "x".repeat(9000) }, SECRET);
    expect(a.verify(fat)).toBeNull();
  });
});

describe("links do not pile up", () => {
  it("a newer link for the same person ends the older ones", async () => {
    const { a, sent } = auth();
    await a.requestLink("maya@northgate.test");
    await a.requestLink("maya@northgate.test");
    expect(await a.exchangeLink(sent[0]!.token)).toEqual({ ok: false, reason: "invalid" });
    expect((await a.exchangeLink(sent[1]!.token)).ok).toBe(true);
  });

  it("a thousand requests leave one link, and expired links are dropped", async () => {
    let t = NOW.getTime();
    const { a, sent } = auth({ now: () => new Date(t) });
    for (let i = 0; i < 1000; i++) await a.requestLink("maya@northgate.test");
    expect(a.pendingLinks()).toBe(1);
    expect((await a.exchangeLink(sent.at(-1)!.token)).ok).toBe(true);
    await a.requestLink("maya@northgate.test");
    t += 16 * 60_000;
    await a.requestLink("nobody@nowhere.test");
    expect(a.pendingLinks()).toBe(0);
  });

  it("an unknown address does the same hashing work as a known one", async () => {
    const { a } = auth();
    const before = a.dummyWork();
    await a.requestLink("nobody@nowhere.test");
    expect(a.dummyWork()).toBe(before + 1);
    await a.requestLink("maya@northgate.test");
    expect(a.dummyWork()).toBe(before + 1);
  });
});

describe("sign-out ends the session on the server", () => {
  it("a revoked session id fails verify, others still pass, and revoked ids are pruned once expired", async () => {
    let t = NOW.getTime();
    const { a, sent } = auth({ now: () => new Date(t) });
    await a.requestLink("maya@northgate.test");
    const one = await a.exchangeLink(sent[0]!.token);
    await a.requestLink("maya@northgate.test");
    const two = await a.exchangeLink(sent[1]!.token);
    if (!one.ok || !two.ok) throw new Error("no token");
    const claims = a.verify(one.accessToken)!;
    await a.revoke(claims);
    expect(a.verify(one.accessToken)).toBeNull();
    expect(a.verify(two.accessToken)).not.toBeNull();
    expect(a.revokedCount()).toBe(1);
    t += 9 * 3600_000;
    await a.requestLink("nobody@nowhere.test");
    expect(a.revokedCount()).toBe(0);
  });
});

describe("the development server cannot be told its own origin", () => {
  it("a path that starts with two slashes is a path, not a host: no session, no cookie", async () => {
    const hits: string[] = [];
    const deps = {
      auth: { exchangeLink: async () => (hits.push("exchange"), { ok: false, reason: "invalid" }) },
    } as unknown as WebDeps;
    let origin = "";
    const server = createWebServer(deps, () => origin);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await new Promise<{ status: number; cookie: string | undefined }>(
        (resolve, reject) => {
          const req = httpRequest(
            origin,
            {
              method: "POST",
              path: "//evil.example/sign-in/verify",
              headers: {
                origin: "http://evil.example",
                "content-type": "application/x-www-form-urlencoded",
              },
            },
            (r) =>
              resolve({ status: r.statusCode ?? 0, cookie: r.headers["set-cookie"]?.join(";") }),
          );
          req.on("error", reject).end("token=x");
        },
      );
      expect(res.status).toBe(404);
      expect(res.cookie).toBeUndefined();
      expect(hits).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
