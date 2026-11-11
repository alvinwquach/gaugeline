import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { assetLabel, sanityImageUses, type SanityImageUrl } from "./images/sanity-url.js";
import { firstFew } from "./site-helpers.js";

/** The parameters in a fixed order, so w=400&auto=format and auto=format&w=400 are one variant. */
const variantOf = (image: SanityImageUrl): string =>
  [...image.params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

const queryOf = (image: SanityImageUrl): string => new URL(image.url).search.replace(/^\?/, "");

export const sanityImageDuplicate = defineCheck<PageSnapshot>({
  id: "sanity-image-duplicate",
  size: "S",
  done: "Each Sanity asset on a page is requested with one set of parameters, and differing sizes come from one srcset.",
  estimateChanges: "Usually one shared image helper used by every component that shows the image.",
  area: "Visitors",
  severity: "low",
  title: "One Sanity image is processed and downloaded more than once",
  what: "The same uploaded image is requested with different parameters by different images on the page, such as one width in the header and another in a card.",
  why: "Each variant is a separate file for Sanity's CDN to make and for the visitor to download, and none of them is in the browser's cache for the others.",
  fix: "Use one address for the image and let CSS size it, or give it one srcset the browser chooses from. If a card needs a different crop, that is a different picture: upload it as its own image.",
  tech: "the same asset id (the hash in the file name; the same bytes are the same asset) in two or more img elements with different parameter sets; an img's own srcset and picture sources are one image and are not compared with each other; parameter order is ignored; the page's own HTML only",
  run(page) {
    // Map of asset id -> variant -> its address: insertion order, O(1) lookups, no list scan.
    const byAsset = new Map<string, Map<string, { image: SanityImageUrl; shown: string }>>();
    for (const use of sanityImageUses(page)) {
      const first = use.candidates[0]?.image;
      if (!first) continue;
      const variants = byAsset.get(first.assetId) ?? new Map();
      const key = variantOf(first);
      // Compared in a fixed order, shown as written in the page.
      if (!variants.has(key)) variants.set(key, { image: first, shown: queryOf(first) });
      byAsset.set(first.assetId, variants);
    }
    const doubled = [...byAsset.values()].filter((v) => v.size > 1);
    if (doubled.length === 0) return [];
    const lines = doubled.map((v) => {
      const all = [...v.values()];
      return `${assetLabel((all[0] as { image: SanityImageUrl }).image)} as ${v.size} different addresses (${all.map((a) => a.shown).join("; ")})`;
    });
    return [
      {
        checkId: "sanity-image-duplicate",
        severity: "low",
        title: this.title,
        evidence: `${doubled.length} ${doubled.length === 1 ? "asset is" : "assets are"} processed more than once on this page: ${firstFew(lines, 2)}`,
        url: page.finalUrl,
      },
    ];
  },
});
