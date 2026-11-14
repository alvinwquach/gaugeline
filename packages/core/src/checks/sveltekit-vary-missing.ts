import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isSveltekitSite } from "../sveltekit/detect.js";
import { acceptRead } from "../sveltekit/read.js";
import { isHtmlPage } from "./page.js";

const covers = (tokens: readonly string[]): boolean =>
  tokens.includes("accept") || tokens.includes("*");

export const sveltekitVaryMissing = defineCheck<PageSnapshot>({
  id: "sveltekit-vary-missing",
  size: "S",
  done: "Both responses send Vary: Accept and the CDN keeps it in its cache key.",
  estimateChanges: "A CDN setting that is not editable on your plan adds a support request.",
  area: "Search & sharing",
  severity: "high",
  title: "One address serves a page and JSON, and caches aren't told",
  what: "The same address of this SvelteKit site returns HTML to a browser and JSON to a request with Accept: application/json (a +page and a +server in one route), and neither response lists Accept in its Vary header.",
  why: "A shared cache (a CDN, a proxy) then keys both on the address alone and can hand the JSON to a visitor or a search engine: an outage that returns 200.",
  fix: "SvelteKit adds Vary: Accept to GET responses of a route that has both a +page and a +server. If it is missing, a CDN or proxy is stripping it: keep Vary in its cache key and header settings, or give the endpoint its own address.",
  tech: "SvelteKit pages only. One extra GET of the same address with Accept: application/json, the only header added, sent on same-origin hops only. Vary tokens from both answers, lower case; Vary: * counts as covering Accept. A 429 or 5xx answer is could not check. The routing rule and the Vary header are in SvelteKit's routing docs (Content negotiation) and runtime/server/respond.js",
  async run(page, ctx) {
    if (!ctx.fetcher || !isSveltekitSite(page) || !isHtmlPage(page)) return [];
    const read = await acceptRead(page, ctx);
    if ("unread" in read) {
      ctx.couldNotCheck?.(page.finalUrl, read.unread);
      return [];
    }
    const vary = [
      ...new Set([
        ...(page.hops.at(-1)?.headers.vary ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t !== ""),
        ...read.vary,
      ]),
    ];
    if (!read.json || covers(vary)) return [];
    return [
      {
        checkId: "sveltekit-vary-missing",
        severity: "high",
        title: this.title,
        evidence: `The address returns HTML to a browser and JSON to Accept: application/json, and neither response lists Accept in Vary${vary.length > 0 ? ` (Vary: ${vary.join(", ")})` : ""}: a shared cache can hand the JSON to a visitor`,
        url: page.finalUrl,
      },
    ];
  },
});
