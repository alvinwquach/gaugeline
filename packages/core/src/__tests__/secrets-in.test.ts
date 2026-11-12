import { describe, expect, it } from "vitest";
import { secretsIn, secretsInValue, stringsOf } from "../secrets.js";

// Values built at run time: a key-shaped string in the source would be refused by push protection.
const STRIPE = ["sk", "live", "0123456789abcdefABCDEF"].join("_");
const AWKWARD = ['pa"ss', "word99"].join("\\"); // pa"ss\word99: a quote and a backslash, which JSON escapes

describe("stringsOf: every decoded string in a parsed value, keys included", () => {
  it("walks objects, arrays and nesting without recursion", () => {
    const deep: unknown[] = [];
    let cur = deep;
    for (let i = 0; i < 100_000; i++) {
      const next: unknown[] = [];
      cur.push(next);
      cur = next;
    }
    cur.push("bottom");
    expect(stringsOf(deep)).toEqual(["bottom"]);
    expect(
      stringsOf({ a: "x", b: [{ c: "y" }, 3, null, true], "key-name": { z: "w" } }).sort(),
    ).toEqual(["a", "b", "c", "key-name", "w", "x", "y", "z"].sort());
    expect(stringsOf("plain")).toEqual(["plain"]);
    expect(stringsOf(null)).toEqual([]);
  });
});

describe("secretsInValue: the decoded strings, not the JSON text", () => {
  const env = { DB_PASSWORD: AWKWARD, PATH: "/usr/bin", SHORT_TOKEN: "abc" };

  it("finds a value with a quote and a backslash that JSON.stringify would have escaped", () => {
    // The old scan: the JSON text holds pa\"ss\\word99, which does not contain pa"ss\word99.
    expect(JSON.stringify({ evidence: AWKWARD })).not.toContain(AWKWARD);
    expect(secretsIn(JSON.stringify({ evidence: AWKWARD }), env)).toEqual([]);
    expect(secretsInValue({ evidence: AWKWARD }, env)).toEqual(["DB_PASSWORD"]);
  });

  it("finds it in any field and in a key, however deep", () => {
    for (const v of [
      { findings: [{ title: `t ${AWKWARD}` }] },
      { findings: [{ evidence: `e ${AWKWARD}` }] },
      { url: `https://x.test/?q=${AWKWARD}` },
      { couldNotCheck: [{ reason: AWKWARD }] },
      { sampled: { [AWKWARD]: { seen: 1 } } },
      { anything: { you: [{ like: AWKWARD }] } },
    ])
      expect(secretsInValue(v, env), JSON.stringify(v)).toEqual(["DB_PASSWORD"]);
  });

  it("catches a key shape, in any field, and returns names, never values", () => {
    const names = secretsInValue({ findings: [{ evidence: `x ${STRIPE}` }] }, {});
    expect(names).toEqual(["stripe-secret"]);
    expect(JSON.stringify(names)).not.toContain(STRIPE);
  });

  it("looks only at the environment it is given, and ignores short or innocently named values", () => {
    expect(secretsInValue({ a: "abc and /usr/bin" }, env)).toEqual([]);
    expect(secretsInValue({ a: AWKWARD }, {})).toEqual([]);
  });

  it("says nothing about ordinary findings", () => {
    expect(
      secretsInValue(
        {
          findings: [
            { title: "Broken link on the menu page", evidence: "/menu links to /drinks (404)" },
          ],
        },
        env,
      ),
    ).toEqual([]);
  });
});
