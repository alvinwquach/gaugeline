import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { hasModernCandidate } from "./images/refs.js";
import { firstFew, shortUrl } from "./site-helpers.js";

const LEGACY = /^image\/(?:jpeg|jpg|pjpeg|png|gif)\b/i;

export const imagesLegacyFormat = defineCheck<PageSnapshot>({
  id: "images-legacy-format",
  area: "Visitors",
  severity: "low",
  title: "Images use older, heavier file formats",
  what: "Images are served as JPEG, PNG or GIF with no WebP or AVIF version offered.",
  why: "WebP and AVIF are usually a quarter to a half smaller for the same picture, so the page loads faster.",
  fix: "Offer WebP or AVIF with a <picture> element or srcset, or let your image CDN or framework image component pick the format.",
  tech: "a sampled image's Content-Type is image/jpeg, image/png or image/gif and it has no WebP or AVIF candidate (SVG is never reported)",
  async run(page, ctx) {
    const sample = await ctx.images?.();
    if (!sample) return [];
    const origin = new URL(page.finalUrl).origin;
    const legacy = sample.taken.filter((img) => {
      const last = img.hops.at(-1);
      return (
        last &&
        last.status < 400 &&
        LEGACY.test(last.headers["content-type"] ?? "") &&
        !hasModernCandidate(img.ref)
      );
    });
    if (legacy.length === 0) return [];
    return [
      {
        checkId: "images-legacy-format",
        severity: "low",
        title: this.title,
        evidence: `${legacy.length} of ${sample.taken.length} sampled images are JPEG, PNG or GIF only: ${firstFew(legacy.map((i) => shortUrl(i.ref.src, origin)))}`,
        url: legacy[0]?.url ?? page.finalUrl,
      },
    ];
  },
});
