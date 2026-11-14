import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isTemporaryHost } from "./launch/hosts.js";

export const tempHostCanonical = defineCheck<PageSnapshot>({
  id: "temp-host-canonical",
  size: "S",
  done: "Every page on the temporary host has a canonical pointing at the real domain.",
  estimateChanges: "A shared layout is one edit.",
  area: "Launch day",
  severity: "low",
  title: "A temporary address doesn't name the real one",
  what: "The page is served from a hosting provider's temporary address and has no canonical tag.",
  why: "If a search engine finds the temporary address, nothing tells it the real page is on your domain, and the preview can show up in results.",
  fix: 'Add <link rel="canonical" href="https://yourdomain/..."> to every page, so each preview points at the real address.',
  tech: "The final address's host ends in .vercel.app, .netlify.app or .pages.dev and the HTML has no link rel=canonical",
  run(page) {
    const host = new URL(page.finalUrl).hostname;
    if (!isTemporaryHost(host) || page.canonicals.length > 0) return [];
    return [
      {
        checkId: "temp-host-canonical",
        severity: "low",
        title: this.title,
        evidence: `served from ${host} with no canonical tag`,
        url: page.finalUrl,
      },
    ];
  },
});
