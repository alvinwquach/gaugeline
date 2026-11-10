import { describe, expect, it } from "vitest";
import { formatMoney, minorExponent, toMinor } from "../money.js";

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

describe("toMinor with a currency: unit", () => {
  it("a currency changes how many places the fraction has", () => {
    expect(toMinor("500", "jpy")).toBe(500);
    expect(toMinor("500.00", "jpy")).toBe(500);
    expect(toMinor(35000, "krw")).toBe(35000);
    expect(toMinor("1.250", "kwd")).toBe(1250);
    expect(toMinor("1.25", "kwd")).toBe(1250);
    expect(toMinor("2", "bhd")).toBe(2000);
    expect(toMinor("48.00", "usd")).toBe(4800);
  });

  it("the currency may be written in any case and defaults to two places", () => {
    expect(toMinor("500", "JPY")).toBe(500);
    expect(toMinor("1.250", "KWD")).toBe(1250);
    expect(toMinor("48.5", "eur")).toBe(4850);
    expect(toMinor("48.5", "zzz")).toBe(4850);
    expect(toMinor("48.5", "")).toBe(4850);
    expect(toMinor("48.5", undefined)).toBe(4850);
  });

  it("a fraction longer than the currency allows is refused, extra zeros are not", () => {
    expect(() => toMinor("48.123", "usd")).toThrow(RangeError);
    expect(() => toMinor("500.5", "jpy")).toThrow(RangeError);
    expect(() => toMinor("1.2345", "kwd")).toThrow(RangeError);
    expect(toMinor("500.000", "jpy")).toBe(500);
    expect(toMinor("1.2500", "kwd")).toBe(1250);
  });

  it("the thousands comma and the float traps work in every exponent", () => {
    expect(toMinor("1,299", "jpy")).toBe(1299);
    expect(toMinor("1,299.000", "kwd")).toBe(1299000);
    expect(toMinor("0.1")).toBe(10);
    expect(toMinor("0.2")).toBe(20);
    expect(toMinor("0.30")).toBe(30);
    expect(toMinor("0.1", "kwd")).toBe(100);
  });
});

describe("minorExponent and formatMoney: unit", () => {
  it("jpy and krw have none, bhd and kwd three, everything else two", () => {
    expect(minorExponent("jpy")).toBe(0);
    expect(minorExponent("KRW")).toBe(0);
    expect(minorExponent("bhd")).toBe(3);
    expect(minorExponent("kwd")).toBe(3);
    expect(minorExponent("usd")).toBe(2);
    expect(minorExponent("")).toBe(2);
    expect(minorExponent(undefined)).toBe(2);
  });

  it("formatMoney writes the integer back with the currency's places and an upper-case code", () => {
    expect(formatMoney({ amount: 4800, currency: "usd" })).toBe("48.00 USD");
    expect(formatMoney({ amount: 7, currency: "eur" })).toBe("0.07 EUR");
    expect(formatMoney({ amount: 0, currency: "usd" })).toBe("0.00 USD");
    expect(formatMoney({ amount: 500, currency: "jpy" })).toBe("500 JPY");
    expect(formatMoney({ amount: 1250, currency: "kwd" })).toBe("1.250 KWD");
    expect(formatMoney({ amount: 129900, currency: "usd" })).toBe("1299.00 USD");
    expect(formatMoney({ amount: 4800, currency: "" })).toBe("48.00");
  });
});
