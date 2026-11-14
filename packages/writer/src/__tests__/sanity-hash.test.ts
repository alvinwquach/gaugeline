/** The digest of a field's live value (X71): the same text, whatever order the keys came in. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, valueSha256 } from "../sanity/hash.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("writes text, numbers and booleans as JSON does", () => {
    expect(canonicalJson('Mon – Sat "late"')).toBe(JSON.stringify('Mon – Sat "late"'));
    expect(canonicalJson(4.5)).toBe("4.5");
    expect(canonicalJson(true)).toBe("true");
  });

  it("treats a missing field as null: a field that was never set is not different from an empty one", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(null)).toBe("null");
  });

  it("refuses what JSON cannot hold, and nesting that deep", () => {
    for (const v of [NaN, Infinity, 1n, () => 1, Symbol("x")])
      expect(() => canonicalJson(v), String(typeof v)).toThrow(TypeError);
    let deep: unknown = "x";
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(TypeError);
  });
});

describe("valueSha256", () => {
  it("is the SHA-256 of the canonical text, lower-case hex", () => {
    expect(valueSha256("Mon to Sat")).toBe(sha('"Mon to Sat"'));
    expect(valueSha256(undefined)).toBe(sha("null"));
    expect(valueSha256({ b: 1, a: 2 })).toBe(sha('{"a":2,"b":1}'));
    expect(valueSha256("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for a changed value, a changed type and a changed case", () => {
    const all = new Set(
      ["10:00", "10:01", 10, "10", true, "True", "true", null, ""].map(valueSha256),
    );
    expect(all.size).toBe(9);
  });
});
