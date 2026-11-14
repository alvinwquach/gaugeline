import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";
import { imageRefs } from "./images/refs.js";

export const imagesAltMissing = defineCheck<PageSnapshot>({
  id: "images-alt-missing",
  size: "S",
  done: 'Every img has an alt attribute: a description, or alt="" for decoration.',
  estimateChanges: "Images inside CMS content are edited one by one.",
  area: "Visitors",
  severity: "low",
  title: "Some images have no alt attribute",
  what: "Some images have no alt attribute at all, not even an empty one.",
  why: 'Without alt, screen readers read the file name aloud. An empty alt="" tells them to skip a decorative image; a missing one does not.',
  fix: 'Add alt to every img: a short description, or alt="" for decorative images.',
  tech: "img elements with no alt attribute (one finding with a count and the first three)",
  run(page) {
    const missing = imageRefs(page).filter((r) => r.alt === null);
    if (missing.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    return [
      {
        checkId: "images-alt-missing",
        severity: "low",
        title: this.title,
        evidence: `${missing.length} ${missing.length === 1 ? "image has" : "images have"} no alt: ${firstFew(missing.map((r) => shortUrl(r.src, origin)))}`,
        url: page.finalUrl,
      },
    ];
  },
});
