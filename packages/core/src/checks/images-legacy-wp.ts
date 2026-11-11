import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { imageRefs } from "./images/refs.js";
import { firstFew, shortUrl } from "./site-helpers.js";

const WP = /\/wp-content\/uploads\//;

export const imagesLegacyWp = defineCheck<PageSnapshot>({
  id: "images-legacy-wp",
  size: "M",
  done: "The images live in the new site's own media library and no address points at the old site.",
  estimateChanges:
    "The number of images, and links inside CMS content that still name the old address.",
  area: "Visitors",
  severity: "medium",
  title: "Images still load from an old WordPress site",
  what: "Images on the page are served from /wp-content/uploads/, usually left over from a WordPress site the new site replaced.",
  why: "When the old WordPress install or its host is switched off, every one of these images breaks at once.",
  fix: "Move the images into the new site's own media library or asset folder and update the addresses.",
  tech: "img src or srcset candidates under /wp-content/uploads/",
  run(page) {
    const wp = imageRefs(page).filter(
      (r) =>
        WP.test(r.src) || r.srcset.some((c) => WP.test(c.url)) || WP.test(r.nextImageSource ?? ""),
    );
    if (wp.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    return [
      {
        checkId: "images-legacy-wp",
        severity: "medium",
        title: this.title,
        evidence: `${wp.length} ${wp.length === 1 ? "image loads" : "images load"} from /wp-content/uploads/: ${firstFew(wp.map((r) => r.nextImageSource ?? shortUrl(r.src, origin)))}`,
        url: page.finalUrl,
      },
    ];
  },
});
