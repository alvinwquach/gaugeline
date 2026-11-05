import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const redirectChain = defineCheck<PageSnapshot>({
  id: "redirect-chain",
  area: "Search & sharing",
  severity: "medium",
  title: "Your address takes several jumps to load",
  what: "The address you entered redirects more than once before the page loads.",
  why: "Each jump slows the first visit and can weaken how search engines credit the page.",
  fix: "Point every redirect straight at the final address.",
  tech: "more than one 3xx hop on the entered URL",
  run(page) {
    const redirects = page.hops.filter(
      (h) => h.status >= 300 && h.status < 400 && h.headers.location !== undefined,
    );
    if (redirects.length <= 1) return [];
    const trail = page.hops.map((h) => `${h.url} (${h.status})`).join(" -> ");
    return [
      {
        checkId: "redirect-chain",
        severity: "medium",
        title: this.title,
        evidence: `${redirects.length} redirects: ${trail}`,
        url: page.requestedUrl,
      },
    ];
  },
});
