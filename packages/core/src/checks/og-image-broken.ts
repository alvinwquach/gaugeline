import { defineCheck } from "../model.js";
import { probe } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus } from "./site-helpers.js";

export const ogImageBroken = defineCheck<PageSnapshot>({
  id: "og-image-broken",
  area: "Launch day",
  severity: "medium",
  title: "The share picture doesn't load",
  what: "The og:image the page names answers with an error, or can't be reached.",
  why: "When someone shares the page, the preview card shows no picture, or none at all, on the day you most want it to look right.",
  fix: "Point og:image at an image that loads on the live domain (open the address in a browser to check), and use a full https:// address.",
  tech: "One probe of the og:image address (HEAD, then GET on 405/501), counted in the images budget; 4xx, 5xx or no answer is a finding. No og:image is og-image-missing's to report",
  async run(page, ctx) {
    const raw = page.og["og:image"]?.trim();
    if (!raw || !ctx.fetcher || !ctx.budget) return [];
    let url: string;
    try {
      url = new URL(raw, page.finalUrl).href;
    } catch {
      return [];
    }
    if (ctx.budget.take("images", [url]).length === 0) return [];
    const status = finalStatus(await probe(url, ctx.fetcher));
    if (status !== undefined && status < 400) return [];
    return [
      {
        checkId: "og-image-broken",
        severity: "medium",
        title: this.title,
        evidence:
          status === undefined
            ? `og:image ${url} could not be reached`
            : `og:image ${url} returned ${status}`,
        url: page.finalUrl,
      },
    ];
  },
});
