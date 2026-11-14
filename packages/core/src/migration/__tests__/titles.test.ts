import { describe, expect, it } from "vitest";
import { normaliseTitle, sameTitle, titleKept } from "../titles.js";

describe("sameTitle", () => {
  it("ignores case, spacing, accents and the punctuation between a page's name and the site's", () => {
    expect(
      sameTitle("Sourdough Saturdays - Wren Bakehouse", "sourdough saturdays | Wren  Bakehouse"),
    ).toBe(true);
    expect(sameTitle("Caf\u00E9 menu", "Cafe menu")).toBe(true);
    expect(sameTitle("Cardamom buns & cinnamon swirls", "Cardamom buns and cinnamon swirls")).toBe(
      true,
    );
  });
  it("accepts adding or dropping the site's name, whole words only", () => {
    expect(sameTitle("About us", "About us | Wren Bakehouse")).toBe(true);
    expect(sameTitle("About us - Wren Bakehouse", "About us")).toBe(true);
    expect(sameTitle("Rye", "Ryegrass farm")).toBe(false);
  });
  it("calls a reworded title a change, and an empty one never a match", () => {
    expect(sameTitle("The new rye loaf", "Our rye, reworked")).toBe(false);
    expect(sameTitle("", "Anything")).toBe(false);
    expect(sameTitle("!!!", "???")).toBe(false);
  });
  it("normalises invisible characters away", () => {
    expect(normaliseTitle("Wed\u200Bding cakes")).toBe("wedding cakes");
  });
});

describe("titleKept", () => {
  it("compares the old <title> with the new <title> and og:title, and the list's title with the heading too", () => {
    expect(titleKept({ page: "Menu - Bar" }, { title: "Menu | Bar" })).toBe(true);
    expect(titleKept({ page: "Menu - Bar" }, { h1: "Menu" })).toBe(false);
    expect(titleKept({ listed: "Menu" }, { title: "Lunch | Bar", h1: "Menu" })).toBe(true);
    expect(titleKept({ listed: "Menu", page: "Menu - Bar" }, { title: "Lunch | Bar" })).toBe(false);
  });
  it("a heading that is only the site's name does not keep every old title", () => {
    expect(
      titleKept(
        { page: "Wedding cakes - Wren Bakehouse" },
        { title: "Cakes | x", h1: "Wren Bakehouse" },
      ),
    ).toBe(false);
  });
});
