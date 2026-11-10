import { describe, expect, it } from "vitest";
import { toMinor } from "../money.js";

describe("toMinor: unit", () => {
  it('48 becomes 4800 and "48.00" becomes 4800', () => {
    expect(toMinor(48)).toBe(4800);
    expect(toMinor("48.00")).toBe(4800);
    expect(toMinor("48")).toBe(4800);
  });

  it("a one-place fraction is padded and a thousands comma is read", () => {
    expect(toMinor("48.5")).toBe(4850);
    expect(toMinor("1,299.00")).toBe(129900);
    expect(toMinor(" 0.07 ")).toBe(7);
  });

  it("19.99 becomes 1999, never 1998, and the float traps stay exact", () => {
    expect(toMinor(19.99)).toBe(1999);
    expect(toMinor(0.57)).toBe(57);
    expect(toMinor(1.15)).toBe(115);
    expect(toMinor(4.35)).toBe(435);
    expect(toMinor("0.30")).toBe(30);
  });

  it("extra zeros after the cents are fine; extra digits are refused", () => {
    expect(toMinor("48.500")).toBe(4850);
    expect(() => toMinor("48.123")).toThrow(RangeError);
    expect(() => toMinor(48.125)).toThrow(RangeError);
  });

  it.each(["", "free", "-5", ".5", "48.", "1,29.00", "4 8", "1e3", "$48", "NaN"])(
    "refuses %j",
    (bad) => {
      expect(() => toMinor(bad)).toThrow(RangeError);
    },
  );

  it("refuses NaN, infinity, negatives, exponent notation and sizes beyond a safe integer", () => {
    expect(() => toMinor(Number.NaN)).toThrow(RangeError);
    expect(() => toMinor(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toMinor(-1)).toThrow(RangeError);
    expect(() => toMinor(1e-7)).toThrow(RangeError);
    expect(() => toMinor("99999999999999999")).toThrow(RangeError);
  });

  it("zero is a price (a free product)", () => {
    expect(toMinor(0)).toBe(0);
    expect(toMinor("0.00")).toBe(0);
  });
});
