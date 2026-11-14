import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";
import { PAGE_HEAVY_BYTES, describeSize, measurePage } from "./weight.js";

export const pageHeavy = defineCheck<PageSnapshot>({
  id: "page-heavy",
  size: "M",
  done: "The page loads within the size budget, with the largest files resized or trimmed first.",
  estimateChanges: "The number of large images and how much of the HTML is inline data.",
  area: "Visitors",
  severity: "medium",
  title: "This page is heavy to load",
  what: "The HTML plus the images Gaugeline sampled add up to over 3 MB, and that is a floor: unsampled files come on top.",
  why: "On a phone connection a page this heavy takes many seconds and costs visitors data.",
  fix: "Start with the largest files in the evidence: resize and compress images, and trim the HTML's inline data.",
  tech: "HTML bytes plus the Content-Length of sampled images (the files the run already requested) is over 3 MB (3,145,728 bytes); no extra requests are made",
  async run(page, ctx) {
    const last = page.hops.at(-1);
    if (!isHtmlPage(page) || !last) return [];
    const { htmlBytes } = measurePage(last.body ?? "");
    // Only what the run already fetched: never start the image sample from here.
    const sample = await ctx.imagesIfSampled?.();
    const sizes = (sample?.taken ?? []).flatMap((img) => {
      const n = Number(img.hops.at(-1)?.headers["content-length"] ?? Number.NaN);
      return Number.isFinite(n) && n > 0 ? [n] : [];
    });
    const total = htmlBytes + sizes.reduce((a, b) => a + b, 0);
    if (total <= PAGE_HEAVY_BYTES) return [];
    return [
      {
        checkId: "page-heavy",
        severity: "medium",
        title: this.title,
        evidence: `at least ${describeSize(total)}: ${describeSize(htmlBytes)} HTML plus ${sizes.length} sampled ${sizes.length === 1 ? "image" : "images"} (sampled files only, so the real total is higher)`,
        url: page.finalUrl,
      },
    ];
  },
});
