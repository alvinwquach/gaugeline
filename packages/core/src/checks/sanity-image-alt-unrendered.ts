import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { agreedAlt, pageUploads, reportUnread } from "./images/sanity-studio.js";
import { assetLabel } from "./images/sanity-url.js";
import { firstFew } from "./site-helpers.js";

export const sanityImageAltUnrendered = defineCheck<PageSnapshot>({
  id: "sanity-image-alt-unrendered",
  size: "S",
  done: "Every Sanity image whose editor wrote alt text in Studio has that text in its alt attribute on the page.",
  estimateChanges:
    "One line in the image component when the alt is never passed. Allow longer when the field has to be added to the query first.",
  area: "Visitors",
  severity: "medium",
  title: "Alt text written in Sanity is not on the page",
  what: "An editor wrote alt text for a picture in Sanity Studio, and the img on the page has no alt attribute or an empty one.",
  why: "Screen readers skip an image with an empty alt and read the file name when there is none, so the description the editor took the time to write never reaches the visitor who needs it, and search engines never see it.",
  fix: "Add the alt field to the query that loads the image and pass it to the img: alt={image.alt}. If the picture is only decoration, clear the alt text in Studio so the two agree.",
  tech: 'reads the Sanity dataset named by SANITY_PROJECT_ID and SANITY_DATASET with GET (published perspective, a Viewer token in a header): the published documents that refer to each upload on the page; an image value counts as having alt text when its alt field is text that is not blank; reported when every document using the upload has alt text and the img on the page has no alt attribute or alt=""; an upload used in several places where only some have alt text, or in no published document, is could not check; only a field named alt is read; the text itself is never kept or printed',
  async run(page, ctx) {
    const uploads = pageUploads(page);
    if (uploads.size === 0) return [];
    const read = await ctx.sanityImages?.();
    if (read === undefined) return [];
    if (!reportUnread(ctx, page, read, "uses")) return [];
    const found: string[] = [];
    const unclear = new Map<string, number>();
    for (const [id, upload] of uploads) {
      const asset = read.assets.get(id);
      if (asset?.uses === undefined) continue;
      const agreed = agreedAlt(asset.uses);
      if (!agreed.ok) {
        unclear.set(agreed.reason, (unclear.get(agreed.reason) ?? 0) + 1);
        continue;
      }
      if (!agreed.value) continue;
      for (const { use, candidates } of upload.images) {
        const alt = use.alt;
        if (alt !== null && alt.trim() !== "") continue;
        const first = candidates[0];
        if (!first) continue;
        found.push(
          `${assetLabel(first.image)} (${alt === null ? "no alt attribute" : "empty alt"} on the page)`,
        );
      }
    }
    for (const [reason, n] of [...unclear].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      ctx.couldNotCheck?.(page.finalUrl, `${n} ${n === 1 ? "upload" : "uploads"}: ${reason}`);
    if (found.length === 0) return [];
    return [
      {
        checkId: "sanity-image-alt-unrendered",
        severity: "medium",
        title: this.title,
        evidence: `${found.length} Sanity ${found.length === 1 ? "image has" : "images have"} alt text in Studio that the page does not show: ${firstFew(found, 3)}`,
        url: page.finalUrl,
      },
    ];
  },
});
