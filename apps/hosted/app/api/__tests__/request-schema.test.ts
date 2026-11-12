import { describe, expect, it } from "vitest";
import { findKeys } from "@gaugeline/core";
import {
  MAX_BODY_BYTES,
  MAX_FINDINGS,
  parseIdempotencyKey,
  parseUpload,
} from "../../../lib/api/schema.js";
import { decodeCursor, encodeCursor } from "../../../lib/api/cursor.js";
import { hashToken, newToken, parseBearer, TOKEN_PATTERN } from "../../../lib/api/tokens.js";
import { secretsIn } from "../../../lib/api/secrets.js";
import { finding, manyFindings, result } from "./helpers.js";

describe("request schema (zod)", () => {
  it("accepts the CLI's result, schema 2, and the published schema 1", () => {
    const v2 = parseUpload(result());
    expect(v2.ok).toBe(true);
    const { couldNotCheck: _c, sampled: _s, ...rest } = result();
    const v1 = parseUpload({ ...rest, schema: 1 });
    expect(v1.ok).toBe(true);
    if (v1.ok) expect(v1.value.findings).toHaveLength(1);
  });

  it("rejects an unknown schema with a message that says what is accepted", () => {
    for (const schema of [3, 0, "2", undefined]) {
      const r = parseUpload(result([finding()], { schema }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(422);
        expect(r.code).toBe("unsupported_schema");
        expect(r.message).toMatch(/schema 1 and 2/);
        expect(r.message).toMatch(/gaugeline <address> --json/);
      }
    }
  });

  it("rejects a body that is not an object, and unknown fields (strict, like the CLI's schema)", () => {
    for (const body of [null, [], "x", 3]) expect(parseUpload(body).ok).toBe(false);
    const r = parseUpload(result([finding()], { html: "<html>the whole page</html>" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_body");
  });

  it("names the field that is wrong, without echoing its value", () => {
    const r = parseUpload(result([finding(1, { severity: "urgent" as never })]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("findings.0.severity");
      expect(r.message).not.toContain("urgent");
    }
  });

  it("derives the fingerprint with core's function, one line of evidence and a bounded summary", () => {
    const long = `${"x".repeat(1500)}\nsecond line`;
    const r = parseUpload(result([finding(1, { evidence: long, title: "t".repeat(400) })]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const f = r.value.findings[0]!;
      expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(f.evidence.length).toBeLessThanOrEqual(1000);
      expect(f.evidence).not.toContain("\n");
      expect(f.title.length).toBeLessThanOrEqual(300);
      expect(r.value.summary).toMatchObject({ high: 1, medium: 0, low: 0, total: 1 });
    }
  });

  it("the same finding in two runs has the same fingerprint; a different path has another", () => {
    const a = parseUpload(result([finding(1)]));
    const b = parseUpload(result([finding(1)], { startedAt: "2026-11-13T03:00:00.000Z" }));
    const c = parseUpload(result([finding(1, { url: "https://tidewater-bar.test/other" })]));
    if (!a.ok || !b.ok || !c.ok) throw new Error("rejected");
    expect(a.value.findings[0]!.fingerprint).toBe(b.value.findings[0]!.fingerprint);
    expect(a.value.findings[0]!.fingerprint).not.toBe(c.value.findings[0]!.fingerprint);
  });

  it("accepts 10,000 findings and rejects the 10,001st (the whole body)", () => {
    expect(MAX_FINDINGS).toBe(10_000);
    expect(parseUpload(result(manyFindings(10_000))).ok).toBe(true);
    const r = parseUpload(result(manyFindings(10_001)));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(413);
      expect(r.message).toMatch(/10,000/);
    }
  });

  it("a hostile summary stays under the database's 16 KB limit", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `${"c".repeat(90)}-${i}`);
    const r = parseUpload(
      result([finding()], {
        failed: ids,
        passed: ids,
        couldNotCheck: ids.map((id) => ({ id, reason: "r".repeat(500), url: "https://x.test/" })),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(Buffer.byteLength(JSON.stringify(r.value.summary))).toBeLessThanOrEqual(15_000);
  });

  it("has a body cap the 10,000 findings fit under", () => {
    const size = Buffer.byteLength(JSON.stringify(result(manyFindings(10_000))));
    expect(size).toBeLessThan(MAX_BODY_BYTES);
  });
});

describe("Idempotency-Key", () => {
  it("is 1 to 255 printable characters, or absent", () => {
    expect(parseIdempotencyKey(null)).toEqual({ ok: true, key: null });
    expect(parseIdempotencyKey("gl-abc_123.XYZ:1")).toEqual({ ok: true, key: "gl-abc_123.XYZ:1" });
    for (const bad of ["", " ", "a".repeat(256), "line\nbreak", "café"])
      expect(parseIdempotencyKey(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe("site tokens", () => {
  it("a token is random, has a lookup prefix, and only its SHA-256 is kept", () => {
    const a = newToken();
    const b = newToken();
    expect(a.token).toMatch(TOKEN_PATTERN);
    expect(a.token).not.toBe(b.token);
    expect(a.prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(a.token.startsWith(`glt_${a.prefix}_`)).toBe(true);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).not.toContain(a.token.slice(-20));
  });

  it("reads a Bearer header and nothing else", () => {
    const { token } = newToken();
    expect(parseBearer(`Bearer ${token}`)).toBe(token);
    expect(parseBearer(`bearer ${token}`)).toBe(token);
    for (const bad of [
      null,
      "",
      token,
      `Basic ${token}`,
      "Bearer ",
      "Bearer short",
      `Bearer ${token} x`,
    ])
      expect(parseBearer(bad), String(bad)).toBeNull();
  });
});

describe("cursor", () => {
  it("round-trips, and a made-up cursor is refused", () => {
    const c = encodeCursor({
      t: "2026-11-12 03:00:00.123456+00",
      id: "a1a10000-0000-4000-8000-0000000000a1",
    });
    expect(decodeCursor(c)).toEqual({
      t: "2026-11-12 03:00:00.123456+00",
      id: "a1a10000-0000-4000-8000-0000000000a1",
    });
    for (const bad of ["", "not a cursor", Buffer.from('{"t":1}').toString("base64url"), "e30"])
      expect(decodeCursor(bad), bad).toBeNull();
  });
});

describe("secretsIn (core's scan, used for the presented token and key shapes)", () => {
  it("finds the names of variables whose value appears in the text, never the values", () => {
    const value = ["abcd", "1234", "efgh"].join("");
    const env = {
      SOME_API_KEY: value,
      PATH: "/usr/bin",
      SHORT_TOKEN: "abc",
      NODE_ENV: "production",
    };
    expect(secretsIn(`evidence ${value} more`, env)).toEqual(["SOME_API_KEY"]);
    expect(secretsIn("clean evidence", env)).toEqual([]);
    expect(secretsIn("abc", env)).toEqual([]);
  });

  it("also catches a key shape core already knows (a Stripe secret key), built at run time", () => {
    const shape = ["sk", "live", "0123456789abcdefABCDEF"].join("_");
    expect(findKeys(shape)).toContain("stripe-secret");
    expect(secretsIn(`key ${shape}`, {})).toEqual(["stripe-secret"]);
  });
});
