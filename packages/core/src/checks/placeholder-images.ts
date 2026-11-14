import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { contentIndex } from "./content/parse.js";
import { PLACEHOLDER_IMAGE_HOSTS, hostIn } from "./content/lists.js";
import { firstFew } from "./site-helpers.js";

export const placeholderImages = defineCheck<PageSnapshot>({
  id: "placeholder-images",
  size: "S",
  done: "The real images are uploaded and the img tags point at them.",
  estimateChanges: "The number of images, and whether the real ones exist yet.",
  area: "Visitors",
  severity: "medium",
  title: "The page shows placeholder images",
  what: "Images on the page come from a placeholder service such as placehold.co, dummyimage.com or picsum.photos.",
  why: "Visitors see grey boxes or random stock photos where the real product or team picture should be.",
  fix: "Upload the real images and point the img tags at them.",
  tech: `img src on ${PLACEHOLDER_IMAGE_HOSTS.join(", ")} (or a subdomain)`,
  run(page) {
    const hits = contentIndex(page).images.filter((src) => {
      try {
        return hostIn(new URL(src).hostname, PLACEHOLDER_IMAGE_HOSTS);
      } catch {
        return false;
      }
    });
    if (hits.length === 0) return [];
    return [
      {
        checkId: "placeholder-images",
        severity: "medium",
        title: this.title,
        evidence: `${hits.length} placeholder ${hits.length === 1 ? "image" : "images"}: ${firstFew(hits)}`,
        url: page.finalUrl,
      },
    ];
  },
});
