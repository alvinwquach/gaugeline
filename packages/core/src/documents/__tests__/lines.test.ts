import { describe, expect, it } from "vitest";
import { normaliseName } from "../../products/match.js";
import { parseItemLines } from "../lines.js";

const one = (text: string) =>
  parseItemLines(text).map(({ name, amount, size }) => ({ name, amount, size }));

describe("item and price lines", () => {
  it("reads a dot leader", () => {
    expect(one("Smash Burger ........ 16")).toEqual([
      { name: "Smash Burger", amount: 1600, size: undefined },
    ]);
  });

  it("reads a price with a currency symbol and cents, and a wide gap", () => {
    expect(one("Smash Burger $16.00")).toEqual([
      { name: "Smash Burger", amount: 1600, size: undefined },
    ]);
    expect(one("Cold Brew  $4.50")).toEqual([{ name: "Cold Brew", amount: 450, size: undefined }]);
  });

  it("reads a price with no symbol and a trailing currency code", () => {
    expect(one("Garden Salad 11.5 USD")).toEqual([
      { name: "Garden Salad", amount: 1150, size: undefined },
    ]);
  });

  it("reads sizes: Lumpia (6) 9 / (12) 16 is two prices of one item", () => {
    expect(one("Lumpia (6) 9 / (12) 16")).toEqual([
      { name: "Lumpia", amount: 900, size: "6" },
      { name: "Lumpia", amount: 1600, size: "12" },
    ]);
  });

  it("leaves out hours, phone numbers, addresses and lines with no price", () => {
    expect(
      one("Open Tue-Thu 4pm-11pm\nCall (555) 010-0123\n42 Harbor Road 90210\nOur story\nFries  5"),
    ).toEqual([{ name: "Fries", amount: 500, size: undefined }]);
  });

  it("numbers lines, so a finding can say which line", () => {
    expect(parseItemLines("Menu\nTea 3\nCoffee 4").map((i) => i.line)).toEqual([2, 3]);
  });
});

describe("the name normaliser shared with the product matcher", () => {
  it("ignores case and punctuation", () => {
    expect(normaliseName("Smash Burger!")).toBe(normaliseName("smash-burger"));
  });
  it("reads & and 'and' as the same word", () => {
    expect(normaliseName("Salt & Pepper Fries")).toBe(normaliseName("Salt and Pepper Fries"));
  });
});
