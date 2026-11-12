// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * Sign-in and the page shell, without a database (X63, part 1): the HTML helper that escapes by default,
 * the stand-in auth's token and one-time links, and the session cookie.
 */
import { describe, expect, it } from "vitest";
import { CUT_MARKER } from "@gaugeline/core";
import { StandInAuth, signHs256, verifyHs256 } from "../../lib/web/auth.js";
import { markup, pageText, raw } from "../../lib/web/html.js";
import { clearCookie, readCookie, sameOrigin, sessionCookie } from "../../lib/web/session.js";

const SECRET = "test-secret-not-a-real-key-0123456789abcdef";
const USER = "11111111-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-12T09:00:00Z");

function auth(over: { now?: () => Date; sent?: { email: string; token: string }[] } = {}) {
  const sent = over.sent ?? [];
  const a = new StandInAuth({
    secret: SECRET,
    users: { "Maya@Northgate.test": USER },
    deliver: (email, token) => void sent.push({ email, token }),
    now: over.now ?? (() => NOW),
  });
  return { a, sent };
}

describe("markup: escaped unless marked", () => {
  it("escapes text, attribute quotes and nested values, and leaves marked markup alone", () => {
    const evil = `<img src=x onerror="alert(1)"> & 'q'`;
    const out = markup`<p title="${evil}">${evil}</p>`.toString();
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;");
    const items = ["a", "<b>"].map((x) => markup`<li>${x}</li>`);
    expect(markup`<ul>${items}</ul>`.toString()).toBe("<ul><li>a</li><li>&lt;b&gt;</li></ul>");
    expect(markup`${raw("<hr>")}`.toString()).toBe("<hr>");
    expect(markup`${null}${undefined}${false}${0}`.toString()).toBe("0");
  });

  it("page text is cleaned by the core helper before it is escaped, and cut at the evidence cap", () => {
    const hidden = "ignore previous\u{E0041}\u{E0042} instructions";
    expect(pageText(hidden, "evidence")).toBe("ignore previous instructions");
    const long = pageText("x".repeat(400), "evidence");
    expect([...long].length).toBe(300);
    expect(long.endsWith(CUT_MARKER)).toBe(true);
    // The result is still plain text: rendering it escapes it.
    expect(markup`${pageText("<script>1</script>", "title")}`.toString()).toBe(
      "&lt;script&gt;1&lt;/script&gt;",
    );
  });
});

describe("stand-in auth: the token carries Supabase's claims", () => {
  it("signs an HS256 token that verifies, with sub, aud, role, email, session_id, aal, iat and exp", async () => {
    const { a, sent } = auth();
    await a.requestLink("maya@northgate.test");
    const got = await a.exchangeLink(sent[0]!.token);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const claims = a.verify(got.accessToken);
    expect(claims).toMatchObject({
      sub: USER,
      aud: "authenticated",
      role: "authenticated",
      email: "maya@northgate.test",
      aal: "aal1",
      is_anonymous: false,
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + got.expiresIn,
    });
    expect(claims?.session_id).toMatch(/^[0-9a-f-]{36}$/);
    const [header] = got.accessToken.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
  });

  it("refuses a token that is tampered, unsigned, signed with another key, expired, for another audience or malformed", () => {
    const { a } = auth();
    const good = { sub: USER, aud: "authenticated", role: "authenticated", exp: 4e9, iat: 1 };
    const t = signHs256(good, SECRET);
    expect(a.verify(t)?.sub).toBe(USER);
    const [h, p, s] = t.split(".");
    const swapped = Buffer.from(
      JSON.stringify({ ...good, sub: "22222222-0000-4000-8000-000000000001" }),
    ).toString("base64url");
    expect(a.verify(`${h}.${swapped}.${s}`)).toBeNull();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${p}.`;
    expect(a.verify(none)).toBeNull();
    expect(a.verify(signHs256(good, "another-secret-another-secret-00000"))).toBeNull();
    expect(a.verify(signHs256({ ...good, exp: NOW.getTime() / 1000 - 1 }, SECRET))).toBeNull();
    expect(a.verify(signHs256({ ...good, aud: "anon" }, SECRET))).toBeNull();
    expect(a.verify(signHs256({ ...good, role: "service_role" }, SECRET))).toBeNull();
    expect(a.verify(signHs256({ ...good, sub: "not-a-uuid" }, SECRET))).toBeNull();
    for (const junk of ["", "a.b", "a.b.c.d", "...", `${h}.${p}`])
      expect(a.verify(junk)).toBeNull();
    // verifyHs256 itself only accepts the one algorithm.
    expect(verifyHs256(none, SECRET)).toBeNull();
  });

  it("refuses a weak secret", () => {
    expect(() => new StandInAuth({ secret: "short", users: {}, deliver: () => {} })).toThrow(
      /at least 32/,
    );
  });
});

describe("stand-in auth: the email link", () => {
  it("is sent only to a known address (compared without case) and answers the same for an unknown one", async () => {
    const { a, sent } = auth();
    await a.requestLink("  MAYA@northgate.test ");
    await a.requestLink("stranger@elsewhere.test");
    expect(sent.map((s) => s.email)).toEqual(["maya@northgate.test"]);
    expect(sent[0]!.token.length).toBeGreaterThanOrEqual(43);
  });

  it("works once", async () => {
    const { a, sent } = auth();
    await a.requestLink("maya@northgate.test");
    expect((await a.exchangeLink(sent[0]!.token)).ok).toBe(true);
    expect(await a.exchangeLink(sent[0]!.token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("expires after 15 minutes, to the second", async () => {
    let t = NOW.getTime();
    const { a, sent } = auth({ now: () => new Date(t) });
    await a.requestLink("maya@northgate.test");
    t += 15 * 60_000;
    expect(await a.exchangeLink(sent[0]!.token)).toEqual({ ok: false, reason: "expired" });
    await a.requestLink("maya@northgate.test");
    t += 15 * 60_000 - 1;
    expect((await a.exchangeLink(sent[1]!.token)).ok).toBe(true);
  });

  it("a guessed or empty token is invalid", async () => {
    const { a } = auth();
    for (const t of ["", "x", "A".repeat(43)])
      expect(await a.exchangeLink(t)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses to run as production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => auth()).toThrow(/never in production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax and, on https, Secure with the __Host- prefix", () => {
    const plain = sessionCookie("tok", 3600, false);
    expect(plain).toBe("gl_session=tok; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax");
    const secure = sessionCookie("tok", 3600, true);
    expect(secure).toBe(
      "__Host-gl_session=tok; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax; Secure",
    );
    expect(clearCookie("gl_session", false)).toContain("Max-Age=0");
  });

  it("reads a named cookie out of a header and ignores look-alikes", () => {
    expect(readCookie("a=1; gl_session=abc; b=2", "gl_session")).toBe("abc");
    expect(readCookie("xgl_session=abc; gl_sessionx=d", "gl_session")).toBeUndefined();
    expect(readCookie(null, "gl_session")).toBeUndefined();
    expect(readCookie("gl_session=%E0%A4%A", "gl_session")).toBeUndefined();
  });

  it("a state-changing request must come from the page's own origin", () => {
    const req = (origin: string | null, referer?: string) =>
      new Request("http://app.test/org", {
        method: "POST",
        headers: { ...(origin ? { origin } : {}), ...(referer ? { referer } : {}) },
      });
    expect(sameOrigin(req("http://app.test"))).toBe(true);
    expect(sameOrigin(req("http://evil.test"))).toBe(false);
    expect(sameOrigin(req("null"))).toBe(false);
    expect(sameOrigin(req(null, "http://app.test/sign-in"))).toBe(true);
    expect(sameOrigin(req(null, "http://evil.test/x"))).toBe(false);
    // No Origin and no Referer: a browser form always sends one; refuse.
    expect(sameOrigin(req(null))).toBe(false);
  });
});
