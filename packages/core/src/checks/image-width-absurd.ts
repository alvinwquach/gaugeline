import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { IMAGE_ABSURD_WIDTH, imageRefs, widthParam } from "./images/refs.js";
import { firstFew } from "./site-helpers.js";

export const imageWidthAbsurd = defineCheck<PageSnapshot>({
  id: "image-width-absurd",
  area: "Visitors",
  severity: "medium",
  title: "Images are requested at an enormous width",
  what: "An image is offered or requested 3840 pixels wide or more, wider than almost any screen shows it.",
  why: "Phones and laptops may download a 4K-wide picture to show it a few hundred pixels across, which wastes data and slows the page.",
  fix: "Cap the widths your image component generates (for Next.js, deviceSizes and imageSizes in next.config) and set the sizes attribute.",
  tech: "a srcset candidate with a w descriptor, or a w= parameter, of 3840 or more",
  run(page) {
    const found: string[] = [];
    for (const r of imageRefs(page)) {
      const widths = [
        r.nextImageWidth,
        widthParam(r.src),
        ...r.srcset.flatMap((c) => [c.w, widthParam(c.url)]),
      ].filter((w): w is number => w !== undefined && w >= IMAGE_ABSURD_WIDTH);
      if (widths.length > 0) found.push(`${r.nextImageSource ?? r.src} (${Math.max(...widths)}w)`);
    }
    if (found.length === 0) return [];
    return [
      {
        checkId: "image-width-absurd",
        severity: "medium",
        title: this.title,
        evidence: `${found.length} ${found.length === 1 ? "image is" : "images are"} offered at 3840 pixels or wider: ${firstFew(found)}`,
        url: page.finalUrl,
      },
    ];
  },
});
