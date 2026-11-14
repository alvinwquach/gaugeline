import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson, sha256Hex } from "../canonical.js";

describe("canonicalJson: vectors", () => {
  const vectors: [string, unknown, string][] = [
    ["null", null, "null"],
    ["true and false", [true, false], "[true,false]"],
    ["integers", [0, 1, -1, 9007199254740991], "[0,1,-1,9007199254740991]"],
    ["negative zero prints as 0", -0, "0"],
    ["an empty object and array", { a: {}, b: [] }, '{"a":{},"b":[]}'],
    ["keys sorted", { b: 1, a: 2, c: 3 }, '{"a":2,"b":1,"c":3}'],
    [
      "nested keys sorted",
      { z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] },
      '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}',
    ],
    // UTF-16 code unit order: "Z" (0x5A) before "a" (0x61), and "aa" after "a".
    ["upper case before lower case, prefix first", { a: 1, Z: 2, aa: 3 }, '{"Z":2,"a":1,"aa":3}'],
    ["no whitespace", { a: [1, 2], b: "x y" }, '{"a":[1,2],"b":"x y"}'],
    ["quotes and backslashes escaped", 'say "hi" \\ bye', '"say \\"hi\\" \\\\ bye"'],
    ["control characters escaped", "a\nb\tc\u0001", '"a\\nb\\tc\\u0001"'],
    // Non-ASCII stays as itself (the hash is over UTF-8 bytes).
    ["accents and emoji stay as written", "Caf\u00E9 \u{1F37A}", '"Caf\u00E9 \u{1F37A}"'],
    ["a non-ASCII key", { "\u00E9": 1, e: 2 }, '{"e":2,"\u00E9":1}'],
  ];
  for (const [name, value, expected] of vectors)
    it(name, () => expect(canonicalJson(value)).toBe(expected));

  it("the same value with keys in another order gives the same text", () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalJson({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});

describe("canonicalJson: refusals (no floats, nothing JSON cannot say exactly)", () => {
  const refused: [string, unknown][] = [
    ["a float", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an integer past 2^53", 2 ** 53],
    ["a float in an array", [1, 0.1]],
    ["a float in an object", { a: { b: 2.5 } }],
    ["undefined", undefined],
    ["undefined in an object", { a: undefined }],
    ["undefined in an array", [undefined]],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a lone high surrogate", "a\ud800b"],
    ["a lone low surrogate", "\udc00"],
    ["a lone surrogate in a key", { "\ud800": 1 }],
  ];
  for (const [name, value] of refused)
    it(name, () => expect(() => canonicalJson(value)).toThrow(CanonicalJsonError));

  it("a cycle", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(CanonicalJsonError);
  });

  it("nesting deeper than 32 levels", () => {
    let v: unknown = 1;
    for (let i = 0; i < 40; i++) v = [v];
    expect(() => canonicalJson(v)).toThrow(/deep/);
  });

  it("an object with a null prototype is a plain object", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 1;
    o.a = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
  });
});

describe("sha256Hex", () => {
  it("hashes the UTF-8 bytes (published test vectors)", () => {
    // FIPS 180-2 examples: "abc" and the empty string.
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes a non-ASCII character as its UTF-8 bytes, not UTF-16", () => {
    // U+00E9 is C3 A9 in UTF-8.
    expect(sha256Hex("\u00E9")).toBe(sha256Hex(Buffer.from([0xc3, 0xa9]).toString("utf8")));
    expect(sha256Hex("\u00E9")).not.toBe(sha256Hex("e"));
  });
});
