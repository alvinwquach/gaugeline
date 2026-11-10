import { describe, expect, it } from "vitest";
import { finding, result } from "../../__tests__/helpers";
import type { AdsData } from "../../types";
import { hasProblem, toAdsModel } from "../model";

const BAR = "https://tapas-bar.example";

/** 12 ads over 4 destinations, in one currency. Spend is cents. */
const data: AdsData = {
  currencies: [
    {
      currency: "USD",
      destinations: [
        { url: `${BAR}/happy-hour`, ads: 5, spend: 120450 },
        { url: `${BAR}/book-a-table`, ads: 3, spend: 80000 },
        { url: `${BAR}/gift-cards`, ads: 3, spend: 15075 },
        { url: `${BAR}/old-menu`, ads: 1, spend: 99999 },
      ],
    },
  ],
};

const findings = [
  finding({ checkId: "page-dead", title: "The page does not load", url: `${BAR}/old-menu` }),
  finding({
    checkId: "campaign-tags-lost",
    severity: "medium",
    title: "The campaign fields are lost",
    url: `${BAR}/gift-cards`,
  }),
  finding({ checkId: "page-dead", title: "The page does not load", url: `${BAR}/old-menu` }),
];

describe("toAdsModel", () => {
  const model = toAdsModel(result({ findings }), data);
  const usd = model.currencies[0];

  it("12 ads over 4 destinations: totals are exact integers", () => {
    expect(model.currencies).toHaveLength(1);
    expect(usd?.currency).toBe("USD");
    expect(usd?.totalSpend).toBe(120450 + 80000 + 15075 + 99999);
    expect(usd?.destinations.reduce((n, d) => n + d.ads, 0)).toBe(12);
    expect(Number.isInteger(usd?.totalSpend)).toBe(true);
  });

  it("problem spend adds the destinations that have a finding, each once however many it has", () => {
    expect(usd?.problemSpend).toBe(99999 + 15075);
  });

  it("a page with only a low note is listed with it but its spend is not problem spend", () => {
    const low = toAdsModel(
      result({
        findings: [
          finding({
            checkId: "ad-sold-out",
            severity: "low",
            title: "Some options of the advertised product are sold out",
            url: `${BAR}/happy-hour`,
          }),
        ],
      }),
      data,
    ).currencies[0];
    expect(low?.problemSpend).toBe(0);
    expect(low?.destinations.find((d) => d.url === `${BAR}/happy-hour`)?.findings).toHaveLength(1);
    expect(low?.destinations.map((d) => hasProblem(d))).toEqual([false, false, false, false]);
    expect(low?.destinations[0]?.url).toBe(`${BAR}/happy-hour`);
  });

  it("sorts by the spend on pages with problems, highest first, then total spend, then address", () => {
    expect(usd?.destinations.map((d) => d.url)).toEqual([
      `${BAR}/old-menu`,
      `${BAR}/gift-cards`,
      `${BAR}/happy-hour`,
      `${BAR}/book-a-table`,
    ]);
  });

  it("each row carries references into the result's findings, by index", () => {
    const dead = usd?.destinations[0];
    expect(dead?.findings.map((f) => f.index)).toEqual([0, 2]);
    expect(dead?.findings[0]).toEqual({
      index: 0,
      checkId: "page-dead",
      severity: "high",
      title: "The page does not load",
    });
    expect(usd?.destinations[2]?.findings).toEqual([]);
  });

  it("equal spend breaks on the address, so the order never depends on the input order", () => {
    const tied: AdsData = {
      currencies: [
        {
          currency: "USD",
          destinations: [
            { url: "https://b.example/", ads: 1, spend: 500 },
            { url: "https://a.example/", ads: 1, spend: 500 },
          ],
        },
      ],
    };
    const a = toAdsModel(result(), tied);
    const b = toAdsModel(result(), {
      currencies: [
        { currency: "USD", destinations: [...(tied.currencies[0]?.destinations ?? [])].reverse() },
      ],
    });
    expect(a.currencies[0]?.destinations.map((d) => d.url)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    expect(b).toEqual(a);
  });

  it("every destination healthy: no problem spend, and the rows are all still there", () => {
    const healthy = toAdsModel(result(), data);
    expect(healthy.currencies[0]?.problemSpend).toBe(0);
    expect(healthy.currencies[0]?.destinations).toHaveLength(4);
    expect(healthy.currencies[0]?.destinations[0]?.url).toBe(`${BAR}/happy-hour`);
  });

  it("does not change its input", () => {
    const before = JSON.stringify(data);
    toAdsModel(result({ findings }), data);
    expect(JSON.stringify(data)).toBe(before);
  });

  it("a finding about an address that is not a destination is kept, not dropped", () => {
    const m = toAdsModel(
      result({ findings: [finding({ url: "https://elsewhere.example/", title: "Odd" })] }),
      data,
    );
    expect(m.currencies[0]?.problemSpend).toBe(0);
    expect(m.unplaced.map((f) => f.title)).toEqual(["Odd"]);
  });
});

describe("toAdsModel with mixed currencies", () => {
  const mixed: AdsData = {
    currencies: [
      { currency: "USD", destinations: [{ url: `${BAR}/a`, ads: 2, spend: 1000 }] },
      { currency: "EUR", destinations: [{ url: `${BAR}/a`, ads: 1, spend: 700 }] },
    ],
  };
  const m = toAdsModel(result({ findings: [finding({ url: `${BAR}/a` })] }), mixed);

  it("keeps a total for each currency and never adds them", () => {
    expect(m.currencies.map((c) => [c.currency, c.totalSpend, c.problemSpend])).toEqual([
      ["USD", 1000, 1000],
      ["EUR", 700, 700],
    ]);
  });

  it("the same finding is on the page's row in each currency", () => {
    expect(m.currencies.map((c) => c.destinations[0]?.findings.length)).toEqual([1, 1]);
  });
});

describe("toAdsModel with a sum past the safe integers", () => {
  it("refuses to show a total it cannot hold exactly", () => {
    const big: AdsData = {
      currencies: [
        {
          currency: "USD",
          destinations: [
            { url: "https://a.example/", ads: 1, spend: Number.MAX_SAFE_INTEGER },
            { url: "https://b.example/", ads: 1, spend: 5 },
          ],
        },
      ],
    };
    expect(() => toAdsModel(result(), big)).toThrow(/too large/);
  });
});
