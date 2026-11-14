import type { CheckContext } from "../../model.js";
import { assetDocumentId, type SanityImageRead, type StudioUse } from "../../sanity-images/read.js";
import type { PageSnapshot } from "../../snapshot.js";
import {
  isResized,
  sanityImageUses,
  type SanityCandidate,
  type SanityImageUse,
} from "./sanity-url.js";

/**
 * What the three Sanity checks that read the dataset share: which uploads a page uses and how each
 * img names them, what the editors set on an upload, and the could-not-check lines for the parts of
 * the read that fell short. The vocabulary (an image value's `crop`, `hotspot` and `asset._ref`, an
 * asset document's `size`) is the one in @sanity/types (SanityImageObject's `Image`, `ImageCrop`,
 * `ImageHotspot`, `Asset`); how @sanity/image-url turns a crop and a hotspot into `rect` and
 * `fp-x`/`fp-y` is in its lib/node/urlForImage.js.
 */

/** A crop edge counts as set from this fraction of the image: a smaller one removes less than a pixel row in a hundred. */
export const CROP_EDGE_MIN = 0.01;
/** A hotspot counts as set when its centre is this far from the middle of the image, as a fraction. */
export const HOTSPOT_OFF_CENTRE_MIN = 0.02;
/** A requested shape counts as different from the image's when its aspect ratio differs by more than this fraction. */
export const ASPECT_DIFFERS = 0.02;

/** The address parameters through which a page uses what Studio holds: `rect`, a focal point, or a crop mode. */
const CROP_PARAMS = ["rect", "fp-x", "fp-y", "crop"] as const;

/** One upload on a page and every img that names it, in document order. */
export interface PageUpload {
  id: string;
  /** The imgs that name it, each with the candidates (src, srcset, picture source) that are this upload. */
  images: Array<{ use: SanityImageUse; candidates: SanityCandidate[] }>;
}

/** The uploads a page uses, keyed by asset document id, in the order they first appear. */
export function pageUploads(
  page: Pick<PageSnapshot, "images" | "finalUrl">,
): Map<string, PageUpload> {
  const out = new Map<string, PageUpload>();
  for (const use of sanityImageUses(page)) {
    const byAsset = new Map<string, SanityCandidate[]>();
    for (const c of use.candidates) {
      const id = assetDocumentId(c.image);
      if (id === undefined) continue;
      byAsset.set(id, [...(byAsset.get(id) ?? []), c]);
    }
    for (const [id, candidates] of byAsset) {
      const upload = out.get(id) ?? { id, images: [] };
      upload.images.push({ use, candidates });
      out.set(id, upload);
    }
  }
  return out;
}

/** True when the address carries any parameter by which the page uses an editor's crop or hotspot. */
export function usesStudioParams(c: SanityCandidate): boolean {
  return CROP_PARAMS.some((name) => c.image.params.has(name));
}

/** The one thing every placement of an upload agrees on, or the reason there is none. */
export type Agreed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * What the editors set on an upload, when every document that uses it says the same. An upload used
 * twice with two different crops cannot be matched to the page's picture, so that is a reason, not a guess.
 */
export function agreedUse(uses: readonly StudioUse[] | undefined): Agreed<StudioUse | undefined> {
  if (uses === undefined) return { ok: false, reason: "its use in the dataset was not read" };
  if (uses.length === 0)
    return { ok: false, reason: "no published document uses it as an image value" };
  const key = (u: StudioUse): string => JSON.stringify([u.crop ?? null, u.hotspot ?? null]);
  const first = uses[0] as StudioUse;
  if (uses.some((u) => key(u) !== key(first)))
    return {
      ok: false,
      reason:
        "it is used in several places with different crops or hotspots, so Gaugeline cannot tell which one this picture is",
    };
  return { ok: true, value: first };
}

/** Whether the alt text is there, when every placement of the upload agrees on it. */
export function agreedAlt(uses: readonly StudioUse[] | undefined): Agreed<boolean> {
  if (uses === undefined) return { ok: false, reason: "its use in the dataset was not read" };
  if (uses.length === 0)
    return { ok: false, reason: "no published document uses it as an image value" };
  // Alt text stored as a localized or structured value is not read: never taken for none, never for text.
  if (uses.some((u) => u.alt === "unknown"))
    return {
      ok: false,
      reason:
        "its alt text is stored as a localized or structured value, which Gaugeline does not read",
    };
  const withAlt = uses.filter((u) => u.alt === "text").length;
  if (withAlt !== 0 && withAlt !== uses.length)
    return {
      ok: false,
      reason:
        "it is used in several places and only some have alt text, so Gaugeline cannot tell which one this picture is",
    };
  return { ok: true, value: withAlt > 0 };
}

/**
 * Whether asking for `w` by `h` cuts the picture (after the editor's crop) to a different shape: true when the
 * aspect ratios differ by more than ASPECT_DIFFERS. Undefined when it cannot be judged: a crop that leaves no
 * width or height (its edges add up to the whole picture or more), or a size that is not positive.
 */
export function shapeDiffers(
  image: { width: number; height: number },
  crop: { left: number; top: number; right: number; bottom: number } | undefined,
  w: number,
  h: number,
): boolean | undefined {
  const shownW = image.width * (1 - (crop ? crop.left + crop.right : 0));
  const shownH = image.height * (1 - (crop ? crop.top + crop.bottom : 0));
  if (!(shownW > 0) || !(shownH > 0) || !(w > 0) || !(h > 0)) return undefined;
  const have = shownW / shownH;
  return Math.abs(w / h - have) / have > ASPECT_DIFFERS;
}

export const cropIsSet = (u: StudioUse): boolean =>
  u.crop !== undefined &&
  Math.max(u.crop.left, u.crop.top, u.crop.right, u.crop.bottom) >= CROP_EDGE_MIN;

export const hotspotIsSet = (u: StudioUse): boolean =>
  u.hotspot !== undefined &&
  (Math.abs(u.hotspot.x - 0.5) >= HOTSPOT_OFF_CENTRE_MIN ||
    Math.abs(u.hotspot.y - 0.5) >= HOTSPOT_OFF_CENTRE_MIN);

/**
 * Says, once each, what the read could not give: the whole read, uploads of another project, uploads
 * beyond the cap, and the uploads whose `part` failed (grouped by reason). Returns false when nothing
 * can be judged at all.
 */
export function reportUnread(
  ctx: CheckContext,
  page: Pick<PageSnapshot, "finalUrl">,
  read: SanityImageRead,
  part: "size" | "uses",
): boolean {
  if (read.problem !== undefined) {
    ctx.couldNotCheck?.(page.finalUrl, read.problem);
    return false;
  }
  if (read.foreign.length > 0)
    ctx.couldNotCheck?.(
      page.finalUrl,
      `${read.foreign.length} ${read.foreign.length === 1 ? "upload on this page belongs" : "uploads on this page belong"} to another Sanity project or dataset than SANITY_PROJECT_ID and SANITY_DATASET name, so ${read.foreign.length === 1 ? "it was" : "they were"} not read.`,
    );
  if (read.skipped > 0)
    ctx.couldNotCheck?.(
      page.finalUrl,
      `${read.skipped} ${read.skipped === 1 ? "upload was" : "uploads were"} not read: a run reads at most 100 uploads of one page.`,
    );
  const reasons = new Map<string, number>();
  for (const a of read.assets.values()) {
    const reason = part === "size" ? a.sizeProblem : a.usesProblem;
    if (reason !== undefined) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  for (const [reason, n] of [...reasons].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    ctx.couldNotCheck?.(page.finalUrl, `${n} ${n === 1 ? "upload" : "uploads"}: ${reason}`);
  return true;
}

/** An upload of more than 500 KB (512,000 bytes) is heavy; of more than 1 MB (1,048,576 bytes), huge: strictly over, as images-heavy has it. 1024-based, whole bytes. */
export const SANITY_HEAVY_BYTES = 500 * 1024;
export const SANITY_HUGE_BYTES = 1024 * 1024;

/** "1.4 MB" or "640 KB" from whole bytes, by integer arithmetic (tenths of a megabyte, rounded). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const tenths = Math.round((bytes * 10) / (1024 * 1024));
    return `${Math.floor(tenths / 10)}.${tenths % 10} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

export interface HeavyUpload {
  id: string;
  /** Bytes, as the asset document says. */
  size: number;
  /** True when some img on the page asks for the upload with no width or height, so the visitor gets it as uploaded. */
  whole: boolean;
}

/**
 * The uploads the page uses that are heavy, largest first, ties by asset id. A Map from asset id to size
 * keeps one entry for an upload however many imgs use it; integers throughout.
 */
export function heavyUploads(
  uploads: ReadonlyMap<string, PageUpload>,
  read: SanityImageRead,
): HeavyUpload[] {
  const sizes = new Map<string, number>();
  for (const id of uploads.keys()) {
    const size = read.assets.get(id)?.size;
    if (size !== undefined && size > SANITY_HEAVY_BYTES) sizes.set(id, size);
  }
  return [...sizes]
    .sort(([ia, a], [ib, b]) => b - a || (ia < ib ? -1 : ia > ib ? 1 : 0))
    .map(([id, size]) => ({
      id,
      size,
      whole: (uploads.get(id)?.images ?? []).some(({ candidates }) =>
        candidates.some((c) => !isResized(c.image)),
      ),
    }));
}
