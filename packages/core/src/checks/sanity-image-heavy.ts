import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  SANITY_HEAVY_BYTES,
  SANITY_HUGE_BYTES,
  formatBytes,
  heavyUploads,
  pageUploads,
  reportUnread,
} from "./images/sanity-studio.js";
import { assetLabel } from "./images/sanity-url.js";

/** How many uploads the evidence names: the rest are counted. */
const LISTED = 10;

export const sanityImageHeavy = defineCheck<PageSnapshot>({
  id: "sanity-image-heavy",
  size: "M",
  done: "No Sanity upload the page uses is over 500 KB, or each one that is has been replaced by a smaller file.",
  estimateChanges:
    "Re-exporting one photo is minutes; a whole media library uploaded at camera size is an afternoon, and the editors need a size rule so it does not come back. Allow longer if the originals are needed for print.",
  area: "Visitors",
  severity: "medium",
  title: "Uploads the page uses are heavy in Sanity",
  what: "Pictures the page uses are stored in Sanity at more than 500 KB, and some at more than 1 MB: a count, and the list, largest first.",
  why: "The upload is what an unresized address delivers whole, what every new size is made from, and what the client's Sanity plan stores and serves. A 4 MB phone photo in a hero costs the visitor seconds on mobile data and the client bandwidth on every view.",
  fix: "Re-export the largest files at the width the site needs (about 2000 px for a full-width banner) and re-upload them, and ask for a width and auto=format in every address so the visitor never downloads the upload as it was. Ask editors to resize before they upload.",
  tech: `reads the Sanity dataset named by SANITY_PROJECT_ID and SANITY_DATASET with GET (published perspective, a Viewer token in a header): the size field, in whole bytes, of the asset document of each upload the page's image addresses name (at most 100 per run, in groups of 40); an upload is heavy when it is more than ${SANITY_HEAVY_BYTES} bytes (500 KB, 1024-based, the threshold images-heavy uses) and huge when it is more than ${SANITY_HUGE_BYTES} bytes (1 MB, 1024-based), so a file of exactly 512,000 bytes is not heavy; the list is sorted by size, largest first, then by asset id; it is the upload's size, not the size delivered, so a resized address is much smaller (the evidence says which uploads the page serves whole)`,
  async run(page, ctx) {
    const uploads = pageUploads(page);
    if (uploads.size === 0) return [];
    const read = await ctx.sanityImages?.();
    if (read === undefined) return [];
    if (!reportUnread(ctx, page, read, "size")) return [];
    const heavy = heavyUploads(uploads, read);
    if (heavy.length === 0) return [];
    const huge = heavy.filter((h) => h.size > SANITY_HUGE_BYTES).length;
    const heavyOnly = heavy.length - huge;
    const named = heavy.slice(0, LISTED).map((h) => {
      const first = uploads.get(h.id)?.images[0]?.candidates[0]?.image;
      return `${first ? assetLabel(first) : h.id} ${formatBytes(h.size)}${h.whole ? " (served whole)" : ""}`;
    });
    const counts = [
      huge > 0 ? `${huge} over 1 MB` : "",
      heavyOnly > 0 ? `${heavyOnly} between 500 KB and 1 MB` : "",
    ].filter((s) => s !== "");
    return [
      {
        checkId: "sanity-image-heavy",
        severity: "medium",
        title: this.title,
        evidence: `${heavy.length} Sanity ${heavy.length === 1 ? "upload" : "uploads"} used on this page ${heavy.length === 1 ? "is" : "are"} heavy (${counts.join(", ")}), largest first: ${named.join(", ")}${heavy.length > LISTED ? ` and ${heavy.length - LISTED} more` : ""}`,
        url: page.finalUrl,
      },
    ];
  },
});
