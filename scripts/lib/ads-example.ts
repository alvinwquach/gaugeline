import type { AdsData, Finding, Result } from "../../packages/app/src/types.js";

/**
 * The invented export behind the Ads examples in the docs and the screenshot: a tapas bar's autumn
 * campaign, 12 ads over four landing pages. Spend is in cents, as the app holds it.
 */
export const SHOP = "https://tapas-bar.example";

export const TAPAS_ADS: AdsData = {
  currencies: [
    {
      currency: "USD",
      destinations: [
        { url: `${SHOP}/happy-hour`, ads: 5, spend: 120450 },
        { url: `${SHOP}/book-a-table`, ads: 3, spend: 80000 },
        { url: `${SHOP}/gift-cards`, ads: 3, spend: 15075 },
        { url: `${SHOP}/old-menu`, ads: 1, spend: 99999 },
      ],
    },
  ],
};

export const TAPAS_FINDINGS: Finding[] = [
  {
    checkId: "page-dead",
    severity: "high",
    title: "The page doesn't load",
    evidence: `${SHOP}/old-menu answered 404`,
    url: `${SHOP}/old-menu`,
  },
  {
    checkId: "campaign-tags-lost",
    severity: "medium",
    title: "Campaign tags are lost",
    evidence: "utm_source and utm_campaign are dropped by the redirect to /shop/gift-cards",
    url: `${SHOP}/gift-cards`,
  },
];

export const tapasResult = (): Result => ({
  schema: 2,
  url: "tapas-bar-autumn-ads.csv",
  startedAt: "2026-11-10T09:00:00.000Z",
  findings: TAPAS_FINDINGS,
  passed: [],
  failed: [],
  couldNotCheck: [],
  sampled: {},
});
