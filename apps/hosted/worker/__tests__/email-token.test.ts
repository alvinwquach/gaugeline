/** Unit: the signed preference link in every morning email. */
import { describe, expect, it } from "vitest";
import { signToken, verifyToken, checkTokenSecret } from "../../lib/email/token.js";

describe("the signed preference link", () => {
  const secret = "k7Qz2mXp9WvB4nTc8LrD1sHy6JfG3aEu5NoI0";
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

  it("refuses a long secret made of very few different characters, with a clear error", () => {
    for (const weak of [
      "k".repeat(40),
      "ab".repeat(20),
      "abcdefg".repeat(6),
      "0123456789".slice(0, 7).repeat(8),
    ]) {
      expect(() => checkTokenSecret(weak), weak).toThrow(/at least 8 different characters/);
      expect(() => checkTokenSecret(weak), weak).toThrow(/GAUGELINE_EMAIL_TOKEN_SECRET/);
      // The error names the setting, never the value.
      try {
        checkTokenSecret(weak);
      } catch (e) {
        expect((e as Error).message).not.toContain(weak);
      }
    }
    // Exactly eight different characters is enough; a random-looking one is accepted.
    expect(checkTokenSecret("abcdefgh".repeat(5))).toBe("abcdefgh".repeat(5));
  });

  describe("the signature must be exactly what signToken wrote", () => {
    const token = signToken(secret, { orgId: org, userId: user }, t0);
    const [v, payload, sig] = token.split(".") as [string, string, string];
    const withSig = (s: string) => verifyToken(secret, `${v}.${payload}.${s}`, days(1));

    it("the real one verifies, and is 43 URL-safe characters", () => {
      expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(withSig(sig)).toEqual({ ok: true, orgId: org, userId: user });
    });

    it("padding, extra characters, whitespace and other alphabets are refused", () => {
      for (const altered of [
        `${sig}=`,
        `${sig}==`,
        `${sig}!`,
        `${sig}\n`,
        ` ${sig}`,
        `${sig}A`,
        sig.slice(0, 42),
        `${sig.slice(0, 20)}*${sig.slice(21)}`,
      ]) {
        expect(withSig(altered).ok, JSON.stringify(altered)).toBe(false);
      }
    });

    it("the standard base64 form of the same signature is refused", () => {
      // Find a signature that uses '-' or '_' (about 3 in 4 do): its '+' and '/' twin decodes to the same bytes.
      for (let i = 0; i < 200; i++) {
        const u = `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`;
        const t = signToken(secret, { orgId: org, userId: u }, t0);
        const [tv, tp, ts] = t.split(".") as [string, string, string];
        if (!/[-_]/.test(ts)) continue;
        const standard = Buffer.from(ts, "base64url").toString("base64"); // has + or / and a trailing =
        expect(standard).toMatch(/[+/=]/);
        expect(verifyToken(secret, t, days(1)).ok).toBe(true);
        expect(verifyToken(secret, `${tv}.${tp}.${standard}`, days(1)).ok).toBe(false);
        expect(verifyToken(secret, `${tv}.${tp}.${standard.replace(/=+$/, "")}`, days(1)).ok).toBe(
          false,
        );
        return;
      }
      throw new Error("no signature with - or _ found in 200 tries");
    });

    it("a signature whose last character differs only in bits that are not part of the 256 is refused", () => {
      // 43 characters carry 258 bits; the last two are padding, so a lenient decoder accepts four spellings.
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const last = alphabet.indexOf(sig.at(-1)!);
      const twins = [0, 1, 2, 3]
        .map((n) => alphabet[(last & ~3) | n]!)
        .filter((c) => c !== sig.at(-1));
      expect(twins).toHaveLength(3);
      for (const c of twins) expect(withSig(sig.slice(0, -1) + c).ok, c).toBe(false);
    });
  });
});
