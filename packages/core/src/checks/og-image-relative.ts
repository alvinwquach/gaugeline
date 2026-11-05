import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const ogImageRelative = defineCheck<PageSnapshot>({
  id: "og-image-relative",
  area: "Search & sharing",
  severity: "medium",
  title: "Shared links may show no picture",
  what: "og:image is a relative address (like /previews/landing.webp), not a full https:// address.",
  why: "Facebook, LinkedIn, Slack and iMessage need a full address. With a relative one, shares of the page show no picture.",
  fix: "Write og:image as a full address, including https:// and the domain. Most frameworks have a site URL setting for this.",
  tech: "og:image does not start with http:// or https:// (protocol-relative // addresses are flagged too)",
  run(page) {
    const image = (page.og["og:image"] ?? page.og["og:image:url"])?.trim();
    if (!image || /^https?:\/\//i.test(image)) return [];
    return [
      {
        checkId: "og-image-relative",
        severity: "medium",
        title: this.title,
        evidence: `og:image is "${image}"`,
        url: page.finalUrl,
      },
    ];
  },
});
