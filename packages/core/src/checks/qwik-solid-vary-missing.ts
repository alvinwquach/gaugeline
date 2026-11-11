import { defineCheck } from "../model.js";
import { acceptRead } from "../qwik/read.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";
import { frameworkOf } from "./qwik-solid-shared.js";

const covers = (tokens: readonly string[]): boolean =>
  tokens.includes("accept") || tokens.includes("*");

export const qwikSolidVaryMissing = defineCheck<PageSnapshot>({
  id: "qwik-solid-vary-missing",
  size: "S",
  done: "Both responses send Vary: Accept and the CDN keeps it in its cache key.",
  estimateChanges: "A CDN setting that is not editable on your plan adds a support request.",
  area: "Search & sharing",
  severity: "high",
  title: "One address serves a page and JSON, and caches aren't told",
  what: "The same address of this Qwik or SolidStart site returns HTML to a browser and JSON to a request with Accept: application/json (an endpoint and a page sharing a route), and neither response lists Accept in its Vary header.",
  why: "A shared cache (a CDN, a proxy) then keys both on the address alone and can hand the JSON to a visitor or a search engine: an outage that returns 200.",
  fix: "Send Vary: Accept on both answers (in the middleware or endpoint that negotiates), keep Vary in the CDN's cache key, or give the endpoint its own address.",
  tech: "Qwik and SolidStart pages only. One extra GET of the same address with Accept: application/json, the only header added, sent on same-origin hops only. Vary tokens from both answers, lower case; Vary: * counts as covering Accept. A 429 or 5xx answer is could not check. Neither framework negotiates a successful page on Accept by itself (Qwik City only answers an error as application/qwik-json when Accept lacks text/html, from the package source), so this catches custom endpoints and middleware: the check itself is uncited",
  async run(page, ctx) {
    if (!ctx.fetcher || frameworkOf(page) === undefined || !isHtmlPage(page)) return [];
    const read = await acceptRead(page, ctx);
    if ("unread" in read) {
      ctx.couldNotCheck?.(page.finalUrl, read.unread);
      return [];
    }
    const vary = [
      ...new Set([
        ...(page.hops.at(-1)?.headers["vary"] ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t !== ""),
        ...read.vary,
      ]),
    ];
    if (!read.json || covers(vary)) return [];
    return [
      {
        checkId: "qwik-solid-vary-missing",
        severity: "high",
        title: this.title,
        evidence: `The address returns HTML to a browser and JSON to Accept: application/json, and neither response lists Accept in Vary${vary.length > 0 ? ` (Vary: ${vary.join(", ")})` : ""}: a shared cache can hand the JSON to a visitor`,
        url: page.finalUrl,
      },
    ];
  },
});
