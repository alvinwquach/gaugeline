import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  ASPECT_DIFFERS,
  CROP_EDGE_MIN,
  HOTSPOT_OFF_CENTRE_MIN,
  agreedUse,
  cropIsSet,
  hotspotIsSet,
  pageUploads,
  reportUnread,
  usesStudioParams,
} from "./images/sanity-studio.js";
import { assetLabel } from "./images/sanity-url.js";
import { firstFew } from "./site-helpers.js";

export const sanityImageCropIgnored = defineCheck<PageSnapshot>({
  id: "sanity-image-crop-ignored",
  size: "S",
  done: "Every Sanity image on the page uses the crop and hotspot its editor set in Studio.",
  estimateChanges:
    "One image helper when the page builds its addresses by hand; each call site when the front end writes them one by one. Allow longer if the editors have not set the hotspots yet.",
  area: "Visitors",
  severity: "medium",
  title: "A crop or hotspot set in Sanity Studio is not used by the page",
  what: "An editor set a crop or a hotspot on a picture in Sanity Studio, and the address the page asks the image network for does not carry it, so the picture is shown uncropped or cut around the middle.",
  why: "The editor drew the crop and the hotspot so the face, the dish or the shopfront stays in the frame. Without them a tall or wide slot cuts the heads off a team photo, and the editor has no way to see why.",
  fix: "Build the address with the image value, not just its asset: urlFor(image).width(800).height(600).url() from @sanity/image-url writes the rect for the crop and cuts around the hotspot. If you write addresses by hand, pass the image's crop as rect and its hotspot as fp-x and fp-y with crop=focalpoint.",
  tech: `reads the Sanity dataset named by SANITY_PROJECT_ID and SANITY_DATASET with GET (published perspective, a Viewer token in a header): the published documents that refer to each upload on the page, and on their image values the crop (an edge of ${CROP_EDGE_MIN * 100} percent or more) and the hotspot (centre ${HOTSPOT_OFF_CENTRE_MIN * 100} percent or more off the middle); a crop is ignored when no address of the img has rect, fp-x, fp-y or crop; a hotspot is ignored when none has them, the address asks for both w and h with fit=crop, and the asked shape differs from the image's by more than ${ASPECT_DIFFERS * 100} percent; an upload used with different crops in several places, or in no published document, is could not check; a size set only in CSS and object-position are not read, so a hotspot on an address with no w and h is could not check; only Studio values are read, none is printed`,
  async run(page, ctx) {
    const uploads = pageUploads(page);
    if (uploads.size === 0) return [];
    const read = await ctx.sanityImages?.();
    if (read === undefined) return [];
    if (!reportUnread(ctx, page, read, "uses")) return [];
    const found: string[] = [];
    const cssOnly: string[] = [];
    const unclear = new Map<string, number>();
    for (const [id, upload] of uploads) {
      const asset = read.assets.get(id);
      if (asset?.uses === undefined) continue;
      const agreed = agreedUse(asset.uses);
      if (!agreed.ok) {
        unclear.set(agreed.reason, (unclear.get(agreed.reason) ?? 0) + 1);
        continue;
      }
      const studio = agreed.value;
      if (studio === undefined) continue;
      const first = upload.images[0]?.candidates[0]?.image;
      if (!first) continue;
      const label = assetLabel(first);
      for (const { candidates } of upload.images) {
        if (cropIsSet(studio) && !candidates.some((c) => c.image.params.has("rect"))) {
          found.push(`${label} (crop set in Studio, no rect in the address)`);
          break;
        }
        if (!hotspotIsSet(studio) || candidates.some(usesStudioParams)) continue;
        const asked = candidates
          .map((c) => ({
            c,
            w: Number(c.image.params.get("w")),
            h: Number(c.image.params.get("h")),
          }))
          .find((a) => a.w > 0 && a.h > 0 && a.c.image.params.get("fit") === "crop");
        if (!asked) {
          cssOnly.push(label);
          break;
        }
        const image = asked.c.image;
        const crop = studio.crop;
        const shownW = image.width * (1 - (crop ? crop.left + crop.right : 0));
        const shownH = image.height * (1 - (crop ? crop.top + crop.bottom : 0));
        const want = asked.w / asked.h;
        const have = shownW / shownH;
        if (Math.abs(want - have) / have > ASPECT_DIFFERS) {
          found.push(
            `${label} (hotspot set in Studio, cut to ${asked.w} by ${asked.h} around the middle)`,
          );
          break;
        }
      }
    }
    for (const [reason, n] of [...unclear].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      ctx.couldNotCheck?.(page.finalUrl, `${n} ${n === 1 ? "upload" : "uploads"}: ${reason}`);
    if (cssOnly.length > 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${cssOnly.length} ${cssOnly.length === 1 ? "image has" : "images have"} a hotspot in Studio and an address that gives no width and height to cut to (${firstFew(cssOnly, 2)}). If the page crops ${cssOnly.length === 1 ? "it" : "them"} with CSS (object-fit and object-position), that is not read.`,
      );
    if (found.length === 0) return [];
    return [
      {
        checkId: "sanity-image-crop-ignored",
        severity: "medium",
        title: this.title,
        evidence: `${found.length} Sanity ${found.length === 1 ? "image ignores" : "images ignore"} what the editor set in Studio: ${firstFew(found, 3)}`,
        url: page.finalUrl,
      },
    ];
  },
});
