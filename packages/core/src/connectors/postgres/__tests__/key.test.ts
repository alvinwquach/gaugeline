import { describe, expect, it } from "vitest";
import { checkSupabaseKey } from "../key.js";

/** A JWT-shaped value built at run time: header.payload.signature, base64url. */
function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  return [part({ alg: "HS256", typ: "JWT" }), part(claims), "c2lnbmF0dXJl"].join(".");
}

describe("checkSupabaseKey", () => {
  it("accepts the anon role and a role the owner created for reading", () => {
    expect(checkSupabaseKey(jwt({ role: "anon", iss: "supabase" }))).toEqual({
      ok: true,
      role: "anon",
    });
    expect(checkSupabaseKey(jwt({ role: "gaugeline_reader" }))).toEqual({
      ok: true,
      role: "gaugeline_reader",
    });
  });

  it("refuses service_role, which bypasses row-level security, without printing the key", () => {
    const key = jwt({ role: "service_role", iss: "supabase" });
    const v = checkSupabaseKey(key);
    expect(v.ok).toBe(false);
    const text = JSON.stringify(v);
    expect(text).toMatch(/service_role/);
    expect(text).toMatch(/anon|read/i);
    for (const piece of key.split(".")) expect(text).not.toContain(piece);
  });

  it.each(["supabase_admin", "postgres", "supabase_auth_admin", "SERVICE_ROLE"])(
    "refuses the %s role",
    (role) => {
      expect(checkSupabaseKey(jwt({ role })).ok).toBe(false);
    },
  );

  it("refuses a secret key in the newer format and accepts a publishable one", () => {
    const secret = ["sb", "secret", "abcDEF0123456789"].join("_");
    const v = checkSupabaseKey(secret);
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).not.toContain("abcDEF0123456789");
    expect(checkSupabaseKey(["sb", "publishable", "abcDEF0123456789"].join("_"))).toEqual({
      ok: true,
      role: "anon",
    });
  });

  it("refuses a value that is not a key, a token with no role and a damaged token, never echoing it", () => {
    for (const bad of [
      "not-a-key-0123456789",
      jwt({ iss: "supabase" }),
      jwt({ role: 7 }),
      "a.b.c",
      `${jwt({ role: "anon" })}.extra`,
      "",
      "   ",
    ]) {
      const v = checkSupabaseKey(bad);
      expect(v.ok, bad).toBe(false);
      if (bad.trim() !== "") expect(JSON.stringify(v)).not.toContain(bad);
    }
  });

  it("trims whitespace around the key (an env file often adds a newline)", () => {
    expect(checkSupabaseKey(`  ${jwt({ role: "anon" })}\n`)).toEqual({ ok: true, role: "anon" });
  });

  it("does not verify the signature: it only reads the role, because it never sends the key anywhere", () => {
    expect(checkSupabaseKey(jwt({ role: "anon" })).ok).toBe(true);
  });
});
