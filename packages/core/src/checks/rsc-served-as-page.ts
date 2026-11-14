import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { rscFindings } from "./rsc-shared.js";

export const rscServedAsPage = defineCheck<PageSnapshot>({
  id: "rsc-served-as-page",
  size: "M",
  done: "A request without the RSC header returns HTML, and one with it returns app data.",
  estimateChanges:
    "A custom server, middleware and a CDN rule each fix differently, and finding the one that answers is the work.",
  area: "Search & sharing",
  severity: "high",
  title: "The page address returns app data, not a page",
  what: "A normal request to the page returns the framework's data format (text/x-component), or HTML with no readable words while the prefetch request returns the page's data.",
  why: "Search engines and visitors without JavaScript get nothing to read: the page can drop out of search while every check that loads it in a browser looks fine.",
  fix: "Serve HTML to requests without the RSC header. On Next.js this is usually a custom server, middleware or CDN rule that answers every request with the RSC response, or a page that renders only on the client.",
  tech: "React framework pages only (Next.js signals in the response). One extra GET of the same address with RSC: 1, the only header added, sent on same-origin hops only. 401, 403, 404, 429 and 5xx are could not check",
  async run(page, ctx) {
    return rscFindings(page, ctx, this.id);
  },
});
