import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { classifyHop, describeRefusal } from "../refusal.js";
import { finalStatus, shortUrl } from "./site-helpers.js";

export const imagesBroken = defineCheck<PageSnapshot>({
  id: "images-broken",
  size: "S",
  done: "Every image on the page loads.",
  estimateChanges:
    "Many images lost in a migration are re-uploaded one by one. One wrong folder is a single path change.",
  area: "Visitors",
  severity: "high",
  title: "Some images on this page don't load",
  what: "An image on the site (or the original behind a Next.js /_next/image address) returns an error.",
  why: "Visitors see an empty box or a broken-image icon where a product photo or a diagram should be.",
  fix: "Upload the image again, or point the img at its current address. For /_next/image, check the file named by url= exists.",
  tech: "a sampled same-site img src answers 4xx or 5xx (images on other hosts are not requested); a refusal (401, 403, 429, 503 with Retry-After) is listed as could not check",
  async run(page, ctx) {
    const sample = await ctx.images?.();
    if (!sample) return [];
    const origin = new URL(page.finalUrl).origin;
    return sample.taken.flatMap((img) => {
      const status = finalStatus(img.hops);
      const outcome = classifyHop(img.hops.at(-1));
      if (outcome.kind === "refused") {
        ctx.couldNotCheck?.(img.url, describeRefusal(outcome));
        return [];
      }
      if (status === undefined || status < 400) return [];
      const source = img.ref.nextImageSource ? ` (source ${img.ref.nextImageSource})` : "";
      return [
        {
          checkId: "images-broken",
          severity: "high" as const,
          title: this.title,
          evidence: `<img src="${shortUrl(img.ref.src, origin)}">${source} returned ${status}`,
          url: img.url,
        },
      ];
    });
  },
});
