import { describe, expect, it } from "vitest";
import { formatMoney } from "../money";

describe("formatMoney: from the minor-unit integer and the currency", () => {
  it("0, 5, 1999 and 123456789 in USD", () => {
    expect(formatMoney(0, "USD", "en-US")).toBe("$0.00");
    expect(formatMoney(5, "USD", "en-US")).toBe("$0.05");
    expect(formatMoney(1999, "USD", "en-US")).toBe("$19.99");
    expect(formatMoney(123456789, "USD", "en-US")).toBe("$1,234,567.89");
  });

  it("the same amounts in EUR", () => {
    expect(formatMoney(0, "EUR", "en-US")).toBe("€0.00");
    expect(formatMoney(5, "EUR", "en-US")).toBe("€0.05");
    expect(formatMoney(1999, "EUR", "en-US")).toBe("€19.99");
    expect(formatMoney(123456789, "EUR", "en-US")).toBe("€1,234,567.89");
  });

  it("JPY has no decimals: its minor unit is the yen", () => {
    expect(formatMoney(0, "JPY", "en-US")).toBe("¥0");
    expect(formatMoney(5, "JPY", "en-US")).toBe("¥5");
    expect(formatMoney(1999, "JPY", "en-US")).toBe("¥1,999");
    expect(formatMoney(123456789, "JPY", "en-US")).toBe("¥123,456,789");
  });

  it("follows the reader's locale for separators", () => {
    expect(formatMoney(123456, "EUR", "de-DE")).toBe("1.234,56 €");
  });

  it("a currency with three decimals (KWD) keeps them", () => {
    expect(formatMoney(1234, "KWD", "en-US")).toMatch(/1\.234$/);
  });

  it("builds the amount as text from the integer, so no division happens", () => {
    // Beyond 2^53 a float cannot hold the cents; the text path keeps every digit it was given.
    expect(formatMoney(Number.MAX_SAFE_INTEGER, "USD", "en-US")).toBe("$90,071,992,547,409.91");
  });

  it("no currency, or one Intl does not know, shows the number with two decimals and no symbol", () => {
    expect(formatMoney(1999, null, "en-US")).toBe("19.99");
    expect(formatMoney(1999, "not a code", "en-US")).toBe("19.99");
  });

  it("a negative amount (a refund line in an export) keeps its sign", () => {
    expect(formatMoney(-1999, "USD", "en-US")).toBe("-$19.99");
  });

  it("refuses an amount that is not a safe integer rather than showing a guess", () => {
    expect(() => formatMoney(19.99, "USD", "en-US")).toThrow(/whole number/);
    expect(() => formatMoney(Number.NaN, "USD", "en-US")).toThrow(/whole number/);
    expect(() => formatMoney(2 ** 53, "USD", "en-US")).toThrow(/whole number/);
  });
});
