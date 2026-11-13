import { describe, expect, it } from "vitest";
import { ANALYTICS_HOSTS, isAnalyticsRequest } from "../deny-hosts.js";

const yes = (u: string) => isAnalyticsRequest(new URL(u));

describe("the built-in analytics deny list", () => {
  it.each([
    "https://www.google-analytics.com/g/collect?v=2&en=page_view",
    "https://region1.google-analytics.com/g/collect",
    "https://analytics.google.com/g/collect",
    "https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
    "https://www.googletagmanager.com/gtag/js?id=G-ABCDEF1234",
    "https://stats.g.doubleclick.net/j/collect",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://www.facebook.com/tr/?id=123456789012&ev=PageView",
    "https://snap.licdn.com/li.lms-analytics/insight.min.js",
    "https://px.ads.linkedin.com/collect/?pid=123456",
    "https://analytics.tiktok.com/i18n/pixel/events.js",
    "https://static.hotjar.com/c/hotjar-123456.js",
    "https://www.clarity.ms/tag/abcdefghij",
    "https://edge.fullstory.com/s/fs.js",
    "https://cdn.logrocket.io/LogRocket.min.js",
    "https://cdn.mouseflow.com/projects/00000000-0000-0000-0000-000000000000.js",
    "https://cdn.segment.com/analytics.js/v1/abc/analytics.min.js",
    "https://api-js.mixpanel.com/track",
    "https://api2.amplitude.com/2/httpapi",
    "https://plausible.io/api/event",
    "https://js.hs-scripts.com/123456.js",
    "https://bat.bing.com/action/0",
    "https://www.google.com/g/collect?v=2",
    "https://www.google.com/pagead/1p-user-list/123",
  ])("blocks %s", (u) => {
    expect(yes(u)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://www.google.com/search?q=cats",
    "https://www.facebook.com/somepage",
    "https://notgoogle-analytics.com/",
    "https://google-analytics.com.example.org/",
    "https://fonts.gstatic.com/s/font.woff2",
    "http://127.0.0.1:8080/collect",
  ])("leaves %s alone", (u) => {
    expect(yes(u)).toBe(false);
  });

  it("matches the host case-insensitively and with a trailing dot", () => {
    expect(yes("https://WWW.Google-Analytics.COM./g/collect")).toBe(true);
  });

  it("has an entry for every kind of tracker the tracker checks fingerprint", async () => {
    // The fingerprint table matches script text, not hosts, so this is the one place the two lists meet:
    // each kind below is a tracker kind in trackers/fingerprints.ts, with a host a rendered run would see.
    const { FINGERPRINTS } = await import("../../trackers/fingerprints.js");
    const hostOf: Record<string, string> = {
      "meta-pixel": "https://connect.facebook.net/en_US/fbevents.js",
      "tiktok-pixel": "https://analytics.tiktok.com/i18n/pixel/events.js",
      "linkedin-insight": "https://snap.licdn.com/li.lms-analytics/insight.min.js",
      ga4: "https://www.googletagmanager.com/gtag/js?id=G-ABCDEF1234",
      gtm: "https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123",
      hotjar: "https://static.hotjar.com/c/hotjar-123456.js",
      clarity: "https://www.clarity.ms/tag/abcdefghij",
      fullstory: "https://edge.fullstory.com/s/fs.js",
      logrocket: "https://cdn.logrocket.io/LogRocket.min.js",
      mouseflow: "https://cdn.mouseflow.com/projects/00000000-0000-0000-0000-000000000000.js",
    };
    const own = FINGERPRINTS.filter((f) => !f.kind.endsWith("-tracking"));
    expect(own.map((f) => f.kind).sort()).toEqual(Object.keys(hostOf).sort());
    for (const url of Object.values(hostOf)) expect(yes(url)).toBe(true);
  });

  it("is a frozen list of lower-case entries", () => {
    expect(Object.isFrozen(ANALYTICS_HOSTS)).toBe(true);
    for (const e of ANALYTICS_HOSTS) expect(e.host).toBe(e.host.toLowerCase());
  });
});
