// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The Supabase Auth adapter (A-01) against a recording fake of Supabase Auth (GoTrue): every request's
 * method, address, headers and body are asserted against the documented API (supabase/auth openapi.yaml:
 * POST /otp, POST /verify, POST /logout), and every token rule the stand-in has holds here too.
 * No network: the fake is the `fetch` the adapter is given.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signHs256 } from "../../lib/web/auth.js";
import { authFromEnv } from "../../lib/web/deps.js";
import { SupabaseAuth, type SupabaseAuthOptions } from "../../lib/web/supabase-auth.js";

const BASE = "https://project-ref.supabase.test";
const ISS = `${BASE}/auth/v1`;
// Key-shaped values are built at run time (push protection); none of them is a real key.
const ANON = ["eyJhbGciOiJIUzI1NiJ9", b64({ role: "anon", iss: "supabase" }), "c2lnbmF0dXJl"].join(
  ".",
);
const SECRET = "test-jwt-secret-not-a-real-key-0123456789abcdef";
const USER = "22222222-0000-4000-8000-000000000002";
const SESSION = "33333333-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-13T09:00:00Z");
const nowS = NOW.getTime() / 1000;

function b64(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISS,
  sub: USER,
  aud: "authenticated",
  role: "authenticated",
  email: "maya@northgate.test",
  session_id: SESSION,
  aal: "aal1",
  is_anonymous: false,
  iat: nowS,
  exp: nowS + 3600,
  ...over,
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestInit["redirect"];
  signal: boolean;
}

/** A recording fake of GoTrue: answers each path with the scripted response, keeps every request. */
function gotrue(
  script: Record<string, (seen: Seen, signal?: AbortSignal) => Promise<Response> | Response>,
) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const s: Seen = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      redirect: init.redirect,
      signal: init.signal instanceof AbortSignal,
    };
    seen.push(s);
    const path = new URL(url).pathname;
    const answer = script[path];
    return answer ? answer(s, init.signal ?? undefined) : new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function adapter(script: Parameters<typeof gotrue>[0], over: Partial<SupabaseAuthOptions> = {}) {
  const g = gotrue(script);
  const waits: number[] = [];
  const logs: string[] = [];
  const a = new SupabaseAuth({
    url: BASE,
    anonKey: ANON,
    jwtSecret: SECRET,
    fetch: g.fetch,
    now: () => NOW,
    sleep: async (ms) => void waits.push(ms),
    log: (line) => void logs.push(line),
    nodeEnv: "production",
    ...over,
  });
  return { a, ...g, waits, logs };
}

const verified =
  (token = signHs256(claims(), SECRET)) =>
  () =>
    json(200, { access_token: token, token_type: "bearer", expires_in: 3600, refresh_token: "r" });

describe("requestLink: POST /auth/v1/otp, invited members only", () => {
  it("sends the documented request: the anon key as apikey, JSON {email, create_user:false}, no redirects", async () => {
    const { a, seen } = adapter({ "/auth/v1/otp": () => json(200, {}) });
    await a.requestLink("  Maya@Northgate.test ");
    await a.settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: `${BASE}/auth/v1/otp`,
      method: "POST",
      body: { email: "maya@northgate.test", create_user: false },
      redirect: "manual",
      signal: true,
    });
    expect(seen[0]!.headers).toMatchObject({ apikey: ANON, "content-type": "application/json" });
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it("answers an unknown address exactly as a known one: same result, same wait, nothing echoed", async () => {
    const body = {
      code: 422,
      error_code: "otp_disabled",
      msg: "Signups not allowed for otp: who@x.test",
    };
    const known = adapter({ "/auth/v1/otp": () => json(200, {}) });
    const unknown = adapter({ "/auth/v1/otp": () => json(422, body) });
    expect(await known.a.requestLink("maya@northgate.test")).toBeUndefined();
    expect(await unknown.a.requestLink("who@nowhere.test")).toBeUndefined();
    await unknown.a.settled();
    expect(known.waits).toEqual(unknown.waits);
    expect(known.waits[0]).toBeGreaterThan(0);
    expect(unknown.logs.join("\n")).not.toMatch(/nowhere|Signups|otp_disabled/);
    expect(unknown.logs.join("\n")).toContain("422");
  });

  it("answers at the fixed time while Supabase is still working, for a member and an unknown address alike", async () => {
    for (const status of [200, 422]) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let answered = false;
      const { a, waits } = adapter({
        "/auth/v1/otp": async () => {
          await gate;
          answered = true;
          return json(status, {});
        },
      });
      const outcome = await Promise.race([
        a.requestLink("someone@northgate.test").then(() => "resolved"),
        new Promise((r) => setTimeout(() => r("pending"), 300)),
      ]);
      expect(outcome, `status ${status}`).toBe("resolved");
      expect(answered).toBe(false);
      expect(waits).toEqual([1500]);
      release();
      await a.settled();
      expect(answered).toBe(true);
    }
  });

  it("does not answer before the fixed time, even when Supabase answers at once", async () => {
    let wake!: () => void;
    const timer = new Promise<void>((r) => (wake = r));
    const { a, seen } = adapter({ "/auth/v1/otp": () => json(200, {}) }, { sleep: () => timer });
    let done = false;
    const asked = a.requestLink("maya@northgate.test").then(() => (done = true));
    await a.settled();
    expect(seen).toHaveLength(1);
    expect(done).toBe(false);
    wake();
    await asked;
    expect(done).toBe(true);
  });

  it("does not wait for a slow Auth server, and gives up on it after the timeout", async () => {
    const { a, logs } = adapter(
      {
        "/auth/v1/otp": (_s, signal) =>
          new Promise((_, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason)),
          ),
      },
      { timeoutMs: 30 },
    );
    await a.requestLink("maya@northgate.test");
    await a.settled();
    expect(logs).toEqual(["[auth] supabase otp failed: timeout"]);
  });
});

describe("exchangeLink: POST /auth/v1/verify with the link's token hash", () => {
  it("sends {type:'email', token_hash} and returns the access token, which then verifies", async () => {
    const { a, seen } = adapter({ "/auth/v1/verify": verified() });
    const got = await a.exchangeLink("a1b2c3d4e5f6");
    expect(seen[0]).toMatchObject({
      url: `${BASE}/auth/v1/verify`,
      method: "POST",
      body: { type: "email", token_hash: "a1b2c3d4e5f6" },
      redirect: "manual",
    });
    expect(seen[0]!.headers.apikey).toBe(ANON);
    expect(got).toMatchObject({ ok: true, expiresIn: 3600 });
    if (got.ok) expect(a.verify(got.accessToken)).toMatchObject({ sub: USER, session_id: SESSION });
  });

  it("an error from Supabase is 'invalid', and its body reaches neither the result nor the log", async () => {
    const { a, logs } = adapter({
      "/auth/v1/verify": () => json(403, { error_code: "otp_expired", msg: "secret detail" }),
    });
    expect(await a.exchangeLink("a1b2c3")).toEqual({ ok: false, reason: "invalid" });
    expect(logs.join("\n")).not.toContain("secret detail");
  });

  it("refuses an empty or odd token without asking Supabase", async () => {
    const { a, seen } = adapter({ "/auth/v1/verify": verified() });
    for (const t of ["", "x".repeat(600), "a b", "../otp", "a\u0000b"])
      expect(await a.exchangeLink(t)).toEqual({ ok: false, reason: "invalid" });
    expect(seen).toHaveLength(0);
  });

  it("refuses a token Supabase returns that this app would not accept (service_role, other issuer)", async () => {
    for (const bad of [
      claims({ role: "service_role" }),
      claims({ iss: "https://other.test/auth/v1" }),
    ]) {
      const { a } = adapter({ "/auth/v1/verify": verified(signHs256(bad, SECRET)) });
      expect(await a.exchangeLink("a1b2c3")).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses a redirect, a non-JSON answer and an answer over the size cap", async () => {
    const answers = [
      () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
      () => new Response("<html>", { status: 200 }),
      () => new Response(`{"access_token":"${"a".repeat(70_000)}"}`, { status: 200 }),
    ];
    for (const answer of answers) {
      const { a } = adapter({ "/auth/v1/verify": answer });
      expect(await a.exchangeLink("a1b2c3")).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("the answer size cap", () => {
  it("stops reading a valid answer past 64 KB, refuses it, and logs 'answer too large'", async () => {
    const good = JSON.stringify({
      access_token: signHs256(claims(), SECRET),
      expires_in: 3600,
      pad: "a".repeat(200_000),
    });
    const bytes = new TextEncoder().encode(good);
    const CHUNK = 16 * 1024;
    let pulled = 0;
    const answer = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (pulled >= bytes.length) return c.close();
            c.enqueue(bytes.slice(pulled, pulled + CHUNK));
            pulled += CHUNK;
          },
        }),
        { status: 200 },
      );
    // The same answer under the cap succeeds: only its size is refused.
    const small = adapter({ "/auth/v1/verify": verified() });
    expect((await small.a.exchangeLink("a1b2c3")).ok).toBe(true);
    const { a, logs } = adapter({ "/auth/v1/verify": answer });
    expect(await a.exchangeLink("a1b2c3")).toEqual({ ok: false, reason: "invalid" });
    expect(logs).toEqual(["[auth] supabase verify failed: answer too large"]);
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * CHUNK);
    expect(pulled).toBeLessThan(bytes.length);
  });
});

describe("verify: the access token, checked locally", () => {
  const { a } = adapter({});
  const t = (over: Record<string, unknown>) => signHs256(claims(over), SECRET);

  it("accepts a current Supabase token and returns its claims", () => {
    expect(a.verify(t({}))).toMatchObject({ sub: USER, role: "authenticated", iss: ISS });
  });

  it("refuses every claim the stand-in refuses, plus service_role, anon, anonymous users and no session", () => {
    const bad: Record<string, unknown>[] = [
      { iss: "gaugeline-stand-in" },
      { iss: `${BASE}/auth/v1/` },
      { aud: "anon" },
      { role: "service_role" },
      { role: "anon" },
      { exp: nowS - 1 },
      { exp: nowS + 31 * 86400 },
      { iat: nowS + 120 },
      { nbf: nowS + 120 },
      { sub: "not-a-uuid" },
      { is_anonymous: true },
      { session_id: undefined },
    ];
    for (const over of bad) expect(a.verify(t(over)), JSON.stringify(over)).toBeNull();
    expect(a.verify(signHs256(claims(), "another-secret-0123456789abcdefghijklmnop"))).toBeNull();
    const [, p] = t({}).split(".");
    expect(a.verify(`${b64({ alg: "none", typ: "JWT" })}.${p}.`)).toBeNull();
    expect(a.verify(`${b64({ alg: "HS384", typ: "JWT" })}.${p}.x`)).toBeNull();
  });

  it("verifies ES256 against the configured key set, by kid and with the key's own algorithm only", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };
    const es = adapter({}, { jwtSecret: undefined, jwks: JSON.stringify({ keys: [jwk] }) }).a;
    const signEs = (header: object, body = claims()) => {
      const data = `${b64(header)}.${b64(body)}`;
      const sig = cryptoSign("sha256", Buffer.from(data), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      });
      return `${data}.${sig.toString("base64url")}`;
    };
    expect(es.verify(signEs({ alg: "ES256", typ: "JWT", kid: "k1" }))).toMatchObject({ sub: USER });
    expect(es.verify(signEs({ alg: "ES256", typ: "JWT", kid: "k2" }))).toBeNull();
    expect(es.verify(signEs({ alg: "RS256", typ: "JWT", kid: "k1" }))).toBeNull();
    // Algorithm confusion: an HS256 token "signed" with the public key's text is refused (no secret set).
    expect(es.verify(signHs256(claims(), JSON.stringify(jwk)))).toBeNull();
  });

  /** The same token with its signature spelled another way that decodes to the same bytes. */
  const respell = (token: string): string => {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = token.at(-1)!;
    return token.slice(0, -1) + abc[abc.indexOf(last) ^ 1];
  };

  it.each(["ES256", "RS256"] as const)(
    "%s: refuses a token whose typ is not JWT, and a signature not in its one canonical spelling",
    (alg) => {
      const { publicKey, privateKey } =
        alg === "ES256"
          ? generateKeyPairSync("ec", { namedCurve: "P-256" })
          : generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg };
      const v = adapter({}, { jwtSecret: undefined, jwks: JSON.stringify({ keys: [jwk] }) }).a;
      const sign = (header: object) => {
        const data = `${b64(header)}.${b64(claims())}`;
        const sig = cryptoSign(
          "sha256",
          Buffer.from(data),
          alg === "ES256" ? { key: privateKey, dsaEncoding: "ieee-p1363" } : privateKey,
        );
        return `${data}.${sig.toString("base64url")}`;
      };
      const good = sign({ alg, typ: "JWT", kid: "k1" });
      expect(v.verify(good)).toMatchObject({ sub: USER });
      expect(Buffer.from(respell(good).split(".")[2]!, "base64url")).toEqual(
        Buffer.from(good.split(".")[2]!, "base64url"),
      );
      expect(v.verify(respell(good))).toBeNull();
      expect(v.verify(sign({ alg, kid: "k1" }))).toBeNull();
      expect(v.verify(sign({ alg, typ: "at+jwt", kid: "k1" }))).toBeNull();
    },
  );
});

describe("revoke: POST /auth/v1/logout?scope=local, and the local revocation list", () => {
  it("logs the session out at Supabase with its own token, and the token stops verifying here at once", async () => {
    const { a, seen } = adapter({ "/auth/v1/logout": () => new Response(null, { status: 204 }) });
    const token = signHs256(claims(), SECRET);
    const c = a.verify(token)!;
    await a.revoke(c, token);
    expect(seen[0]).toMatchObject({ url: `${BASE}/auth/v1/logout?scope=local`, method: "POST" });
    expect(seen[0]!.headers).toMatchObject({ apikey: ANON, authorization: `Bearer ${token}` });
    expect(a.verify(token)).toBeNull();
  });

  it("revokes locally even when Supabase fails, and forgets the session once its token has expired", async () => {
    let now = NOW;
    const { a } = adapter({ "/auth/v1/logout": () => json(500, {}) }, { now: () => now });
    const token = signHs256(claims(), SECRET);
    await a.revoke(a.verify(token)!, token);
    expect(a.verify(token)).toBeNull();
    expect(a.revokedCount()).toBe(1);
    now = new Date(NOW.getTime() + 3601_000);
    a.verify(token);
    expect(a.revokedCount()).toBe(0);
  });
});

describe("configuration: refused at start-up when missing or weak, never echoing a value", () => {
  const make = (over: Partial<SupabaseAuthOptions>) => () =>
    new SupabaseAuth({
      url: BASE,
      anonKey: ANON,
      jwtSecret: SECRET,
      nodeEnv: "production",
      ...over,
    });

  it.each([
    ["http outside development", { url: "http://project-ref.supabase.test" }],
    ["http to loopback in production", { url: "http://127.0.0.1:54321" }],
    ["user info", { url: "https://u:p@project-ref.supabase.test" }],
    ["a path", { url: `${BASE}/auth/v1` }],
    ["a query", { url: `${BASE}/?x=1` }],
    ["no anon key", { anonKey: "" }],
    [
      "a service-role key as the anon key",
      {
        anonKey: ANON.replace(
          b64({ role: "anon", iss: "supabase" }),
          b64({ role: "service_role" }),
        ),
      },
    ],
    ["a secret key as the anon key", { anonKey: "sb_" + "secret_" + "abcdefghijklmnopqrstuvwxyz" }],
    ["a weak JWT secret", { jwtSecret: "short" }],
    ["no way to verify tokens", { jwtSecret: undefined }],
    [
      "a private key in the key set",
      {
        jwtSecret: undefined,
        jwks: JSON.stringify({
          keys: [
            {
              ...generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
                format: "jwk",
              }),
              kid: "k",
              alg: "ES256",
            },
          ],
        }),
      },
      /private or shared/,
    ],
    [
      "an ES256 key that is not on the P-256 curve",
      {
        jwtSecret: undefined,
        jwks: JSON.stringify({
          keys: [
            {
              ...generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({
                format: "jwk",
              }),
              kid: "k",
              alg: "ES256",
            },
          ],
        }),
      },
      /ES256 \(EC P-256\)/,
    ],
  ] as [string, Partial<SupabaseAuthOptions>, RegExp?][])("refuses %s", (_name, over, why) => {
    expect(make(over)).toThrow(why ?? Error);
    try {
      make(over)();
    } catch (e) {
      const m = (e as Error).message;
      for (const v of [over.anonKey, over.jwtSecret, over.url].filter((x) => x && x.length > 8))
        expect(m).not.toContain(v);
    }
  });

  it("allows http only to a loopback address in development or test (the local Supabase stack)", () => {
    expect(make({ url: "http://127.0.0.1:54321", nodeEnv: "test" })).not.toThrow();
  });
});

describe("selection by configuration (deps)", () => {
  const env = {
    GAUGELINE_AUTH: "supabase",
    SUPABASE_URL: BASE,
    SUPABASE_ANON_KEY: ANON,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: "must-never-be-read",
    NODE_ENV: "production",
  };

  it("GAUGELINE_AUTH=supabase picks the adapter, which never reads the service-role key", () => {
    const read = new Set<string>();
    const watched = new Proxy(env, {
      get: (o, k) => (read.add(String(k)), o[k as keyof typeof o]),
      has: (o, k) => (read.add(String(k)), k in o),
      ownKeys: () => {
        throw new Error("the adapter must not list the environment");
      },
    });
    expect(authFromEnv(watched)).toBeInstanceOf(SupabaseAuth);
    expect([...read]).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("the stand-in is still refused outside development and test, and an unknown provider is refused", () => {
    expect(() => authFromEnv({ ...env, GAUGELINE_AUTH: "stand-in" })).toThrow(
      /development and test/,
    );
    expect(() => authFromEnv({ ...env, GAUGELINE_AUTH: "other" })).toThrow(
      /not set to a configured/,
    );
  });
});
