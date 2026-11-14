import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  SANITY_SLOT_FACTOR,
  SANITY_SLOT_SLACK_PX,
  assetLabel,
  deliveredWidth,
  sanityImageUses,
} from "./images/sanity-url.js";
import { firstFew } from "./site-helpers.js";

export const sanityImageOversized = defineCheck<PageSnapshot>({
  id: "sanity-image-oversized",
  size: "S",
  done: "No Sanity image is delivered at more than twice the width its slot shows.",
  estimateChanges:
    "One width in the image helper, or the sizes list in a responsive image component.",
  area: "Visitors",
  severity: "medium",
  title: "Sanity images are delivered far larger than they are shown",
  what: "An image from cdn.sanity.io is asked for at a width much greater than the width attribute on the page, and the page offers no smaller version.",
  why: "The visitor downloads several times the pixels they can see. On a phone that is seconds of waiting and mobile data spent on detail the screen throws away.",
  fix: "Ask Sanity for about twice the width the image is shown at (for a 400 px slot, w=800), or give the image a srcset with smaller widths and a sizes attribute so each screen picks one.",
  tech: `an img with a width attribute whose smallest Sanity address (src, srcset or picture source) delivers more than ${SANITY_SLOT_FACTOR} times that width and at least ${SANITY_SLOT_SLACK_PX} px more; delivered is w times dpr, never above the upload, and the upload's own width when no w is given (read from the file name); an img with no width attribute is not judged; no rendering, so a width set only in CSS is not seen`,
  run(page) {
    const found: string[] = [];
    for (const use of sanityImageUses(page)) {
      const slot = use.declaredWidth;
      if (slot === undefined) continue;
      const smallest = use.candidates
        .map((c) => ({ c, px: deliveredWidth(c.image) }))
        .sort((a, b) => a.px - b.px)[0];
      if (!smallest) continue;
      if (
        smallest.px > slot * SANITY_SLOT_FACTOR &&
        smallest.px - slot * SANITY_SLOT_FACTOR >= SANITY_SLOT_SLACK_PX
      )
        found.push(
          `${assetLabel(smallest.c.image)} is ${smallest.px} px wide for a ${slot} px slot (${Math.round((smallest.px / slot) ** 2)}x the pixels)`,
        );
    }
    if (found.length === 0) return [];
    return [
      {
        checkId: "sanity-image-oversized",
        severity: "medium",
        title: this.title,
        evidence: `${found.length} Sanity ${found.length === 1 ? "image is" : "images are"} delivered larger than shown: ${firstFew(found, 2)}`,
        url: page.finalUrl,
      },
    ];
  },
});
