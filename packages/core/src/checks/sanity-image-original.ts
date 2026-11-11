import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  SANITY_ORIGINAL_MIN_PX,
  assetLabel,
  isResized,
  sanityImageUses,
} from "./images/sanity-url.js";
import { firstFew } from "./site-helpers.js";

export const sanityImageOriginal = defineCheck<PageSnapshot>({
  id: "sanity-image-original",
  size: "S",
  done: "Every Sanity image on the page asks for a width, and for auto format, in its address.",
  estimateChanges:
    "Usually one image helper in the front end. Images written by hand into rich text are edited one by one.",
  area: "Visitors",
  severity: "medium",
  title: "Sanity images are served at the size they were uploaded",
  what: "An image from cdn.sanity.io is requested with no width or height, so the visitor gets the file as it was uploaded: often 3000 to 6000 pixels wide.",
  why: "A phone photo from the shop owner is several megabytes. Shown a few hundred pixels across, it still downloads whole, and the page is slow on a phone for no visible gain.",
  fix: "Ask for the size you show: add w (and h with fit=crop if the shape is fixed) and auto=format to the address, or build it with @sanity/image-url: urlFor(image).width(800).auto('format').url().",
  tech: `an img src, srcset or picture source on cdn.sanity.io/images with none of w, h, max-w, max-h, min-w or min-h, whose upload is wider than ${SANITY_ORIGINAL_MIN_PX} px (the size is in the file name, so nothing is downloaded); other hosts, and addresses on a custom domain for Sanity's CDN, are not read; one finding per page; the page's own HTML only`,
  run(page) {
    const found = new Map<string, string>();
    for (const use of sanityImageUses(page))
      for (const { image } of use.candidates)
        if (!isResized(image) && Math.max(image.width, image.height) > SANITY_ORIGINAL_MIN_PX)
          found.set(image.url, assetLabel(image));
    if (found.size === 0) return [];
    const labels = [...new Set(found.values())];
    return [
      {
        checkId: "sanity-image-original",
        severity: "medium",
        title: this.title,
        evidence: `${found.size} Sanity ${found.size === 1 ? "image is" : "images are"} served at the size ${found.size === 1 ? "it was" : "they were"} uploaded: ${firstFew(labels)}`,
        url: page.finalUrl,
      },
    ];
  },
});
