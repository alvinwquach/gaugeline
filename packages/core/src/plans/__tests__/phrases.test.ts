import { describe, expect, it } from "vitest";
import {
  cadenceUnclear,
  findAmounts,
  hasPromoWords,
  parseCadence,
  parseTaxDisplay,
  parseTrial,
  sameCadence,
} from "../phrases.js";

const month = { unit: "month", count: 1 } as const;

describe("parseCadence: how often a plan says it bills", () => {
  it.each([
    ["$49 per month", month],
    ["$49 a month", month],
    ["$49/mo", month],
    ["$49 / month", month],
    ["$49 monthly", month],
    ["Billed monthly", month],
    ["$49 al mes", month],
    ["49 \u20AC por mes", month],
    ["$49 mensual", month],
    ["$49 mensualmente", month],
    ["$49 cada mes", month],
    ["$490 per year", { unit: "year", count: 1 }],
    ["$490/yr", { unit: "year", count: 1 }],
    ["$490 annually", { unit: "year", count: 1 }],
    ["$490 al a\u00F1o", { unit: "year", count: 1 }],
    ["$490 anual", { unit: "year", count: 1 }],
    ["$12 per week", { unit: "week", count: 1 }],
    ["$12 a la semana", { unit: "week", count: 1 }],
    ["$2 daily", { unit: "day", count: 1 }],
    ["$2 al d\u00EDa", { unit: "day", count: 1 }],
    ["$120 every 3 months", { unit: "month", count: 3 }],
    ["$120 cada 3 meses", { unit: "month", count: 3 }],
    ["$120 per 3 months", { unit: "month", count: 3 }],
    ["$120 quarterly", { unit: "month", count: 3 }],
    ["$120 trimestral", { unit: "month", count: 3 }],
    ["$60 every other month", { unit: "month", count: 2 }],
    ["$60 cada dos meses", { unit: "month", count: 2 }],
    ["$60 every 2 weeks", { unit: "week", count: 2 }],
  ])("reads %s", (text, expected) => {
    expect(parseCadence(text)).toEqual(expected);
  });

  it("is null when the text says nothing about it", () => {
    expect(parseCadence("Foundation $49")).toBeNull();
    expect(parseCadence("")).toBeNull();
  });

  it("does not take a trial's length for a billing interval", () => {
    expect(parseCadence("7-day free trial, then $49 per month")).toEqual(month);
    expect(parseCadence("7-day free trial")).toBeNull();
    expect(parseCadence("1 month free trial")).toBeNull();
  });

  it("is null, and unclear, when the text names two different intervals", () => {
    const text = "$19 per month, billed annually";
    expect(parseCadence(text)).toBeNull();
    expect(cadenceUnclear(text)).toBe(true);
    expect(parseCadence("$20/mo or $200/yr")).toBeNull();
    expect(cadenceUnclear("$49 per month, billed monthly")).toBe(false);
  });

  it("treats 12 months as a year and 7 days as a week", () => {
    expect(sameCadence({ unit: "month", count: 12 }, { unit: "year", count: 1 })).toBe(true);
    expect(sameCadence({ unit: "day", count: 7 }, { unit: "week", count: 1 })).toBe(true);
    expect(sameCadence(month, { unit: "month", count: 3 })).toBe(false);
  });
});

describe("parseTrial: the free trial a plan promises", () => {
  it.each([
    ["7-day free trial", { min: 7, max: 7 }],
    ["14 day trial", { min: 14, max: 14 }],
    ["Free trial of 7 days", { min: 7, max: 7 }],
    ["Try it free for 7 days", null],
    ["7 days free", { min: 7, max: 7 }],
    ["prueba gratis de 7 d\u00EDas", { min: 7, max: 7 }],
    ["7 d\u00EDas de prueba gratis", { min: 7, max: 7 }],
    ["2 weeks free trial", { min: 14, max: 14 }],
    ["1 month free trial", { min: 28, max: 31 }],
    ["first month free", { min: 28, max: 31 }],
    ["primer mes gratis", { min: 28, max: 31 }],
    ["$49 per month", null],
    ["2 months free when you pay yearly", null],
  ])("reads %s", (text, expected) => {
    expect(parseTrial(text)).toEqual(expected);
  });
});

describe("parseTaxDisplay", () => {
  it.each([
    ["$49 per month, tax included", "inclusive"],
    ["$49 incl. VAT", "inclusive"],
    ["49 \u20AC IVA incluido", "inclusive"],
    ["$49 + tax", "exclusive"],
    ["$49 plus VAT", "exclusive"],
    ["$49 excl. tax", "exclusive"],
    ["49 \u20AC m\u00E1s IVA", "exclusive"],
    ["$49 per month", null],
    ["$49 incl. VAT, plus tax", null],
  ])("reads %s", (text, expected) => {
    expect(parseTaxDisplay(text)).toBe(expected);
  });
});

describe("findAmounts: prices written with a currency", () => {
  it("reads symbols and codes, before and after the number", () => {
    expect(findAmounts("$49 or 49 EUR or \u00A349.50 or USD 49 or 1.299,00 \u20AC")).toEqual([
      { text: "49", shown: "$49", currencies: ["usd", "cad", "aud", "nzd", "mxn", "sgd", "hkd"] },
      { text: "49", shown: "49 EUR", currencies: ["eur"] },
      { text: "49.50", shown: "\u00A349.50", currencies: ["gbp"] },
      { text: "49", shown: "USD 49", currencies: ["usd"] },
      { text: "1299.00", shown: "1.299,00 \u20AC", currencies: ["eur"] },
    ]);
  });

  it("reads thousands separators and decimal commas", () => {
    expect(findAmounts("$1,299.00")[0]?.text).toBe("1299.00");
    expect(findAmounts("$1,299")[0]?.text).toBe("1299");
    expect(findAmounts("49,50 \u20AC")[0]?.text).toBe("49.50");
  });

  it("ignores numbers with no currency, and reads one amount once", () => {
    expect(findAmounts("7-day trial, 3 classes")).toEqual([]);
    expect(findAmounts("$49 USD")).toHaveLength(1);
  });

  it("knows a dollar sign can be several currencies", () => {
    expect(findAmounts("US$49")[0]?.currencies).toEqual(["usd"]);
    expect(findAmounts("CA$49")[0]?.currencies).toEqual(["cad"]);
  });
});

describe("hasPromoWords", () => {
  it("sees introductory prices, coupons and discounts", () => {
    expect(hasPromoWords("First month $1, then $49")).toBe(true);
    expect(hasPromoWords("primer mes $1")).toBe(true);
    expect(hasPromoWords("Use coupon SPRING")).toBe(true);
    expect(hasPromoWords("Save 20% today")).toBe(true);
  });

  it("does not take a free trial for one", () => {
    expect(hasPromoWords("7-day free trial, then $49 per month")).toBe(false);
    expect(hasPromoWords("first month free, then $49")).toBe(false);
  });
});
