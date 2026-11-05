import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { imageRefs } from "./images/refs.js";

export const imagesAltEmpty = defineCheck<PageSnapshot>({
  id: "images-alt-empty",
  area: "Visitors",
  severity: "medium",
  title: "None of the images on this page are described",
  what: "The page has images, and not one has alt text that says what it shows.",
  why: "Screen reader users hear nothing about any picture, and search engines have no words to index the images by.",
  fix: 'Give each meaningful image an alt that says what it shows. alt="" is right for decorative images, but a page where every image is decorative is rare.',
  tech: "every img has a missing, empty or whitespace-only alt",
  run(page) {
    const refs = imageRefs(page);
    if (refs.length === 0 || refs.some((r) => (r.alt ?? "").trim() !== "")) return [];
    return [
      {
        checkId: "images-alt-empty",
        severity: "medium",
        title: this.title,
        evidence: `${refs.length} ${refs.length === 1 ? "image" : "images"}, none with alt text`,
        url: page.finalUrl,
      },
    ];
  },
});
