import { describe, expect, it } from "vitest";
import { readAds } from "../../api";

const good = {
  ads: {
    currencies: [
      { currency: "USD", destinations: [{ url: "https://a.example/", ads: 2, spend: 1999 }] },
      { currency: null, destinations: [] },
    ],
  },
};

describe("readAds: the destinations in an ads run's checked field", () => {
  it("reads the shape the server sends", () => {
    expect(readAds(good)).toEqual(good.ads);
  });

  it("is nothing for a page run's checked field", () => {
    expect(readAds({ page: {}, requests: [] })).toBeUndefined();
    expect(readAds(undefined)).toBeUndefined();
    expect(readAds("ads")).toBeUndefined();
  });

  it("spend that is not a whole number of minor units drops the whole list", () => {
    const bad = (spend: unknown) =>
      readAds({
        ads: { currencies: [{ currency: "USD", destinations: [{ url: "u", ads: 1, spend }] }] },
      });
    expect(bad(19.99)).toBeUndefined();
    expect(bad("1999")).toBeUndefined();
    expect(bad(-1)).toBeUndefined();
    expect(bad(2 ** 53)).toBeUndefined();
    expect(bad(0)).toBeDefined();
  });

  it("a malformed destination, currency or list drops the whole list", () => {
    const wrap = (c: unknown) => readAds({ ads: { currencies: [c] } });
    expect(wrap({ currency: 5, destinations: [] })).toBeUndefined();
    expect(wrap({ currency: "USD", destinations: "x" })).toBeUndefined();
    expect(wrap({ currency: "USD", destinations: [{ url: 1, ads: 1, spend: 1 }] })).toBeUndefined();
    expect(
      wrap({ currency: "USD", destinations: [{ url: "u", ads: 1.5, spend: 1 }] }),
    ).toBeUndefined();
    expect(readAds({ ads: { currencies: "x" } })).toBeUndefined();
  });
});
