import { describe, expect, it } from "vitest";
import { numberFrom, parseTolerance, show, valueOf, within } from "../decimal.js";

const num = (text: string) => {
  const d = numberFrom(text);
  if (!d) throw new Error(`${text} is not a number`);
  return d;
};
const tol = (v: number | string) => {
  const t = parseTolerance(v);
  if (!t) throw new Error(`${String(v)} is not a tolerance`);
  return t;
};

describe("numberFrom: the number a page shows", () => {
  it.each([
    ["27.3", "27.3"],
    ["  27.30 ", "27.3"],
    ["1,234.5", "1234.5"],
    ["-4", "-4"],
    ["+4.0", "4"],
    ["48.2%", "48.2"],
    ["$12.50", "12.5"],
    ["27.3 PPG", "27.3"],
    [".5", "0.5"],
    ["0", "0"],
  ])("%j reads as %s", (text, shown) => {
    expect(show(num(text))).toBe(shown);
  });

  it.each(["", "n/a", "27,3", "1.2.3", "twelve", "1e3", "27.3 and 28", "12-14", "--"])(
    "%j is not a number (never guessed)",
    (text) => {
      expect(numberFrom(text)).toBeUndefined();
    },
  );
});

describe("valueOf: what a source gave", () => {
  it("reads integers, decimals and numeric text from a database", () => {
    expect(show(valueOf(27.3) ?? num("0"))).toBe("27.3");
    expect(show(valueOf("27.30") ?? num("0"))).toBe("27.3");
    expect(show(valueOf(5) ?? num("0"))).toBe("5");
  });
  it("refuses what is not a plain number", () => {
    for (const v of [null, true, "", "abc", 1e21, Number.NaN, Number.POSITIVE_INFINITY])
      expect(valueOf(v), String(v)).toBeUndefined();
  });
});

describe("parseTolerance", () => {
  it("is an absolute amount, or a percentage of the source's value", () => {
    expect(parseTolerance(0.1)).toEqual(expect.objectContaining({ kind: "abs" }));
    expect(parseTolerance("2%")).toEqual(expect.objectContaining({ kind: "percent" }));
    expect(parseTolerance("0.5%")).toEqual(expect.objectContaining({ kind: "percent" }));
  });
  it("refuses negatives and words", () => {
    for (const v of [-1, "-2%", "two", "%", "5 %%", Number.NaN, 1e21]) {
      expect(parseTolerance(v), String(v)).toBeUndefined();
    }
  });
});

describe("within: tolerance comparison for decimals and percentages", () => {
  it("is exact with no tolerance, ignoring trailing zeros", () => {
    expect(within(num("27.30"), num("27.3"), tol(0))).toBe(true);
    expect(within(num("27.3"), num("27.4"), tol(0))).toBe(false);
  });

  it("does not trip over binary floating point: 28.1 and 27.9 are 0.2 apart, not 0.20000000000000284", () => {
    expect(28.1 - 27.9 > 0.2).toBe(true); // the trap, in plain numbers
    expect(within(num("28.1"), num("27.9"), tol(0.2))).toBe(true);
    expect(within(num("27.9"), num("28.1"), tol(0.2))).toBe(true);
    expect(within(num("28.2"), num("27.9"), tol(0.2))).toBe(false);
  });

  it("compares numbers written with different numbers of decimals", () => {
    expect(within(num("$12.50"), num("12.5"), tol(0))).toBe(true);
    expect(within(num("12.55"), num("12.5"), tol(0.05))).toBe(true);
    expect(within(num("12.56"), num("12.5"), tol(0.05))).toBe(false);
  });

  it("a percentage tolerance is a share of the source's value", () => {
    expect(within(num("102"), num("100"), tol("2%"))).toBe(true);
    expect(within(num("102.1"), num("100"), tol("2%"))).toBe(false);
    expect(within(num("98"), num("100"), tol("2%"))).toBe(true);
    expect(within(num("27.5"), num("27.3"), tol("0.5%"))).toBe(false);
    expect(within(num("27.5"), num("27.3"), tol("0.8%"))).toBe(true);
  });

  it("a percentage of zero allows only zero", () => {
    expect(within(num("0"), num("0"), tol("5%"))).toBe(true);
    expect(within(num("0.1"), num("0"), tol("5%"))).toBe(false);
  });

  it("a percentage sign on the page is part of the value, not a tolerance", () => {
    expect(within(num("48.2%"), num("48.2"), tol(0))).toBe(true);
    expect(within(num("48.2%"), num("48.9"), tol(0.5))).toBe(false);
  });

  it("works for numbers far too large for a float's exact range", () => {
    expect(within(num("9007199254740993"), num("9007199254740993"), tol(0))).toBe(true);
    expect(within(num("9007199254740993"), num("9007199254740992"), tol(0))).toBe(false);
  });
});
