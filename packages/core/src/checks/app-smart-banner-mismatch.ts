import { appRefs, bannerAppId } from "../apps.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const appSmartBannerMismatch = defineCheck<PageSnapshot>({
  id: "app-smart-banner-mismatch",
  size: "S",
  done: "The iPhone banner's app-id is the same as the id in the App Store link.",
  estimateChanges: "The banner set in more than one template is one edit each.",
  area: "Visitors",
  severity: "medium",
  title: "The iPhone app banner promotes a different app",
  what: "The page's Smart App Banner (the apple-itunes-app meta tag) names a different app id than the page's App Store link.",
  why: "Safari shows the banner at the top of the page on iPhone, so visitors install whichever app it names, which here is not the one the page links to.",
  fix: "Set app-id in the apple-itunes-app meta tag to the same id as the App Store link.",
  tech: '<meta name="apple-itunes-app" content="app-id=..."> differs from every apps.apple.com/.../id<digits> link on the page',
  run(page) {
    const banner = bannerAppId(page.appleItunesApp);
    const apple = appRefs(page).filter((r) => r.store === "apple");
    if (!banner || apple.length === 0 || apple.some((r) => r.id === banner)) return [];
    return [
      {
        checkId: "app-smart-banner-mismatch",
        severity: "medium",
        title: this.title,
        evidence: `apple-itunes-app names app-id=${banner}; the App Store link is id${apple[0]?.id ?? ""}`,
        url: page.finalUrl,
      },
    ];
  },
});
