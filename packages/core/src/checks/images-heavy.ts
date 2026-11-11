import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { IMAGE_HEAVY_BYTES } from "./images/refs.js";
import { shortUrl } from "./site-helpers.js";

export const imagesHeavy = defineCheck<PageSnapshot>({
  id: "images-heavy",
  size: "S",
  done: "The images are resized to the size they are shown at and served as WebP or AVIF.",
  estimateChanges:
    "A site that serves originals needs an image component or CDN set up, then each image needs checking.",
  area: "Visitors",
  severity: "medium",
  title: "Some images are very large files",
  what: "An image on the page is over 500 KB.",
  why: "Large images are the most common reason a page is slow on a phone, and a slow page loses visitors before it loads.",
  fix: "Resize the image to the size it is shown at and export it as WebP or AVIF, or serve it through an image CDN or your framework's image component.",
  tech: "a sampled image's Content-Length header is over 512,000 bytes; a server that sends no Content-Length gives no finding",
  async run(page, ctx) {
    const sample = await ctx.images?.();
    if (!sample) return [];
    const origin = new URL(page.finalUrl).origin;
    return sample.taken.flatMap((img) => {
      const last = img.hops.at(-1);
      const length = Number(last?.headers["content-length"] ?? Number.NaN);
      if (!last || last.status >= 400 || !Number.isFinite(length) || length <= IMAGE_HEAVY_BYTES)
        return [];
      return [
        {
          checkId: "images-heavy",
          severity: "medium" as const,
          title: this.title,
          evidence: `${shortUrl(img.ref.src, origin)} is ${Math.round(length / 1024).toLocaleString("en-US")} KB (Content-Length ${length.toLocaleString("en-US")})`,
          url: img.url,
        },
      ];
    });
  },
});
