import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { rscFindings } from "./rsc-shared.js";

export const rscVaryMissing = defineCheck<PageSnapshot>({
  id: "rsc-vary-missing",
  size: "S",
  done: "Both responses send Vary: RSC and the CDN keeps it in its cache key.",
  estimateChanges: "A CDN setting that is not editable on your plan adds a support request.",
  area: "Search & sharing",
  severity: "high",
  title: "One address serves a page and app data, and caches aren't told",
  what: "The same address returns HTML to a normal request and text/x-component to a request with RSC: 1, and neither response lists RSC in its Vary header.",
  why: "A shared cache (a CDN, a proxy) then keys both on the address alone and can hand the data format to a visitor or a search engine: an outage that returns 200.",
  fix: "Send Vary: RSC (Next.js sends RSC, Next-Router-State-Tree, Next-Router-Prefetch) on both responses, and make sure the CDN keeps it in its cache key. If the origin already sends it, look at the CDN's header and cache-key settings.",
  tech: "React framework pages only. Vary tokens from both responses, compared in lower case; Vary: * counts as covering RSC. A CDN header in either response adds a note that the CDN may be stripping Vary",
  async run(page, ctx) {
    return rscFindings(page, ctx, this.id);
  },
});
