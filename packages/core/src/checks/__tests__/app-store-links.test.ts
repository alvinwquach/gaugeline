import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../../testkit/src/index.js";
import { appRefs, appleRef, bannerAppId, googleRef, playTitle } from "../../apps.js";
import { createFetcher } from "../../fetcher.js";
import { checkSite } from "../../site.js";
import { appSmartBannerMismatch } from "../app-smart-banner-mismatch.js";
import { page } from "./helpers.js";

const APP_CHECKS = ["app-link-dead", "app-name-mismatch", "app-smart-banner-mismatch"];

/** A run of the app checks against a recorded cassette: the page and every store answer. */
async function replay(name: string, expect?: { appName: string }) {
  const fetcher = createFetcher({ transport: useCassette(name, { mode: "replay" }) });
  return checkSite({
    address: "https://hollyhock-app.example/",
    fetcher,
    only: APP_CHECKS,
    ...(expect ? { expect } : {}),
  });
}

describe("app links: unit (id and package extraction)", () => {
  it.each([
    ["https://apps.apple.com/us/app/hollyhock-rewards/id6440000001", "6440000001", "us"],
    ["https://apps.apple.com/app/id6440000001", "6440000001", undefined],
    ["https://apps.apple.com/gb/app/id6440000001?l=fr", "6440000001", "gb"],
    ["https://apps.apple.com/GB/app/hollyhock/id6440000001#reviews", "6440000001", "gb"],
    ["https://itunes.apple.com/us/app/hollyhock/id6440000001?mt=8", "6440000001", "us"],
    ["itms-apps://itunes.apple.com/app/id6440000001", "6440000001", undefined],
  ])("App Store %s -> %s (%s)", (href, id, country) => {
    expect(appleRef(href)).toEqual({ store: "apple", id, ...(country ? { country } : {}), href });
  });

  it.each([
    "https://apps.apple.com/us/developer/hollyhock/id6440000001",
    "https://apps.apple.com/us/app/hollyhock",
    "https://example.com/app/id6440000001",
  ])("not an app link: %s", (href) => {
    expect(appleRef(href)).toBeUndefined();
  });

  it.each([
    [
      "https://play.google.com/store/apps/details?id=example.hollyhock.rewards",
      "example.hollyhock.rewards",
    ],
    [
      "https://play.google.com/store/apps/details?id=example.hollyhock.rewards&hl=en_GB&gl=GB",
      "example.hollyhock.rewards",
    ],
    [
      "http://play.google.com/store/apps/details/?hl=fr&id=example.hollyhock_2.app",
      "example.hollyhock_2.app",
    ],
    ["market://details?id=example.hollyhock.classic", "example.hollyhock.classic"],
  ])("Google Play %s -> %s", (href, id) => {
    expect(googleRef(href)).toEqual({ store: "google", id, href });
  });

  it.each([
    "https://play.google.com/store/apps/developer?id=Hollyhock",
    "https://play.google.com/store/apps/details?id=nodots",
    "https://play.google.com/store/apps/details",
  ])("not a Play app link: %s", (href) => {
    expect(googleRef(href)).toBeUndefined();
  });

  it("each app once per store, in document order; the banner's app-id; the Play title", () => {
    const refs = appRefs(
      page({
        links: [
          { href: "https://apps.apple.com/us/app/a/id1", text: "", sameSite: false },
          { href: "https://apps.apple.com/gb/app/a/id1", text: "", sameSite: false },
          { href: "market://details?id=example.a.b", text: "", sameSite: false },
          {
            href: "https://play.google.com/store/apps/details?id=example.a.b",
            text: "",
            sameSite: false,
          },
        ],
      }),
    );
    expect(refs.map((r) => `${r.store}:${r.id}`)).toEqual(["apple:1", "google:example.a.b"]);
    expect(bannerAppId("app-id=6440000009, app-argument=https://x.example/")).toBe("6440000009");
    expect(bannerAppId(" app-argument=x, APP-ID=12 ")).toBe("12");
    expect(bannerAppId("app-argument=x")).toBeUndefined();
    expect(playTitle("<title>Hollyhock &amp; Co - Apps on Google Play</title>")).toBe(
      "Hollyhock & Co",
    );
    expect(playTitle("<title>Before you continue</title>")).toBe("Before you continue");
    expect(playTitle("<p>no title</p>")).toBeUndefined();
  });

  it("a banner naming a different app than the App Store link is a finding; the same id is not", () => {
    const links = [
      { href: "https://apps.apple.com/us/app/a/id6440000001", text: "", sameSite: false },
    ];
    const ctx = { warn: () => undefined };
    expect(
      appSmartBannerMismatch.run(page({ links, appleItunesApp: "app-id=6440000009" }), ctx),
    ).toEqual([
      expect.objectContaining({
        evidence: "apple-itunes-app names app-id=6440000009; the App Store link is id6440000001",
      }),
    ]);
    expect(
      appSmartBannerMismatch.run(page({ links, appleItunesApp: "app-id=6440000001" }), ctx),
    ).toEqual([]);
    expect(appSmartBannerMismatch.run(page({ appleItunesApp: "app-id=6440000009" }), ctx)).toEqual(
      [],
    );
  });
});

describe("app store links: integration (recorded responses only)", () => {
  it("a found app, a missing app and a renamed app", async () => {
    const { result, budget } = await replay("app-stores", { appName: "Hollyhock Rewards" });
    expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
      [
        "app-link-dead",
        "https://apps.apple.com/gb/app/hollyhock-classic/id6440000002?mt=8 names App Store app 6440000002, which App Store does not have",
      ],
      [
        "app-link-dead",
        "market://details?id=example.hollyhock.classic names Google Play app example.hollyhock.classic, which Google Play does not have (404)",
      ],
      [
        "app-smart-banner-mismatch",
        "apple-itunes-app names app-id=6440000009; the App Store link is id6440000001",
      ],
      [
        "app-name-mismatch",
        'Google Play app example.hollyhock.rewards is "Hollyhock Loyalty"; expected "Hollyhock Rewards"',
      ],
    ]);
    expect(budget.summary().appLinks).toEqual({ limit: 5, sampled: 4, found: 4 });
  });

  it("ADR-0004: store requests carry only the app id and the storefront or language", async () => {
    const sent: URL[] = [];
    const cassette = useCassette("app-stores", { mode: "replay" });
    const fetcher = createFetcher({
      transport: (url, req) => {
        sent.push(url);
        return cassette(url, req);
      },
    });
    await checkSite({ address: "https://hollyhock-app.example/", fetcher, only: APP_CHECKS });
    const store = sent.filter((u) => u.hostname !== "hollyhock-app.example");
    expect(store.map((u) => u.hostname).sort()).toEqual([
      "itunes.apple.com",
      "itunes.apple.com",
      "itunes.apple.com",
      "play.google.com",
      "play.google.com",
    ]);
    for (const u of store) {
      expect([...u.searchParams.keys()].sort()).toEqual(
        u.hostname === "itunes.apple.com" ? ["country", "id"] : ["hl", "id"],
      );
    }
  });

  it("with no expected name, app-name-mismatch has nothing to compare and passes", async () => {
    const { result } = await replay("app-stores");
    expect(result.passed).toContain("app-name-mismatch");
  });
});

describe("app store links: edge cases", () => {
  it("a regional link for an app not sold in that country is could-not-check, not dead", async () => {
    const { result } = await replay("app-stores-regional");
    expect(result.findings.filter((f) => f.checkId === "app-link-dead")).toEqual([]);
    const failed = result.failed.find((f) => f.id === "app-link-dead");
    expect(failed?.error).toContain('"Hollyhock Rewards" is live but not sold in the GB store');
  });

  it("store rate limiting (429): could-not-check with the retry hint", async () => {
    const { result } = await replay("app-stores-rate-limited");
    expect(result.findings).toEqual([]);
    const failed = result.failed.find((f) => f.id === "app-link-dead");
    expect(failed?.error).toContain("try again in a few minutes");
  });

  it("a page with no app links makes no store request", async () => {
    const fetcher = createFetcher({
      transport: async (url) => {
        if (/apple\.com|google\.com/.test(url.hostname))
          throw new Error(`store requested: ${url.href}`);
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: Readable.from([Buffer.from("<title>x</title><p>No apps.</p>")]),
        };
      },
    });
    const run = await checkSite({ address: "https://plain.example/", fetcher, only: APP_CHECKS });
    expect(run.result.failed).toEqual([]);
    expect(run.result.passed.sort()).toEqual([...APP_CHECKS].sort());
  });
});
