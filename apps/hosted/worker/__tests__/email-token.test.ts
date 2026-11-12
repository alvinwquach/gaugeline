/** Unit: the signed preference link in every morning email. */
import { describe, expect, it } from "vitest";
import { signToken, verifyToken, checkTokenSecret } from "../../lib/email/token.js";

describe("the signed preference link", () => {
  const secret = "k".repeat(40);
  const org = "0a000000-0000-4000-8000-00000000000a";
  const user = "11111111-0000-4000-8000-000000000001";
  const t0 = new Date("2026-11-12T07:00:00Z");
  const days = (n: number) => new Date(t0.getTime() + n * 86_400_000);

  it("round-trips, binds one person in one organisation, and never contains the secret", () => {
    const token = signToken(secret, { orgId: org, userId: user }, t0);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(secret);
    expect(verifyToken(secret, token, days(1))).toEqual({ ok: true, orgId: org, userId: user });
  });

  it("expires after 90 days", () => {
    const token = signToken(secret, { orgId: org, userId: user }, t0);
    expect(verifyToken(secret, token, days(89)).ok).toBe(true);
    expect(verifyToken(secret, token, days(91))).toEqual({ ok: false, reason: "expired" });
  });

  it("a changed payload, a changed signature or another secret is refused", () => {
    const token = signToken(secret, { orgId: org, userId: user }, t0);
    const [v, payload, sig] = token.split(".") as [string, string, string];
    const other = Buffer.from(
      JSON.stringify({ o: org, u: "22222222-0000-4000-8000-000000000001", x: 9999999999 }),
    ).toString("base64url");
    expect(verifyToken(secret, `${v}.${other}.${sig}`, days(1))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verifyToken(secret, `${v}.${payload}.${sig.slice(0, -2)}AA`, days(1)).ok).toBe(false);
    expect(verifyToken("z".repeat(40), token, days(1)).ok).toBe(false);
  });

  it("garbage is malformed and never throws", () => {
    for (const bad of ["", "v1", "v1..", "v2.a.b", "v1.%%%.%%%", "a".repeat(10_000)])
      expect(verifyToken(secret, bad, t0).ok).toBe(false);
  });

  it("refuses a short or missing secret", () => {
    expect(() => checkTokenSecret(undefined)).toThrow(/GAUGELINE_EMAIL_TOKEN_SECRET/);
    expect(() => checkTokenSecret("short")).toThrow(/32/);
    expect(checkTokenSecret(secret)).toBe(secret);
  });
});
