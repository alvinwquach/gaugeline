import type { PageSnapshot } from "../../snapshot.js";
import { parseSrcset } from "./refs.js";

/**
 * Sanity image addresses on cdn.sanity.io. The shape and the parameter names come from the
 * @sanity/image-url 1.1.0 package (lib/node/urlForImage.js, parseAssetId.js): the file is
 * `<asset id>-<width>x<height>.<format>` under /images/<project>/<dataset>/, and the width and
 * height of the upload are in the name, so no request is needed to know them.
 */

/** An original wider than this is worth resizing; a logo or an icon is not. */
export const SANITY_ORIGINAL_MIN_PX = 1200;
/** A slot may be filled at twice its width for sharp screens; beyond that, pixels are wasted. */
export const SANITY_SLOT_FACTOR = 2;
/** And the excess must be at least this many pixels, so a few percent is not reported. */
export const SANITY_SLOT_SLACK_PX = 200;

const FILE = /^([A-Za-z0-9]{8,64})-(\d{1,6})x(\d{1,6})\.([a-z0-9]{2,5})$/;
/** The parameters that give the picture a size: any one of them stops it being the upload as it was. */
const SIZING = ["w", "h", "max-w", "max-h", "min-w", "min-h"] as const;

export interface SanityImageUrl {
  url: string;
  projectId: string;
  dataset: string;
  /** The hash that names the upload; the same bytes are always the same asset. */
  assetId: string;
  /** The upload's size in pixels, from its file name. */
  width: number;
  height: number;
  format: string;
  params: URLSearchParams;
}

/** The parts of a cdn.sanity.io image address, or undefined for any other address. */
export function parseSanityImageUrl(url: string): SanityImageUrl | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.hostname.toLowerCase() !== "cdn.sanity.io") return undefined;
  const [kind, projectId, dataset, file] = u.pathname.split("/").filter((s) => s !== "");
  if (kind !== "images" || !projectId || !dataset || !file) return undefined;
  const m = FILE.exec(file);
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return undefined;
  return {
    url,
    projectId,
    dataset,
    assetId: m[1],
    width: Number(m[2]),
    height: Number(m[3]),
    format: m[4],
    params: u.searchParams,
  };
}

const numberParam = (p: SanityImageUrl, name: string): number | undefined => {
  const n = Number(p.params.get(name));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** True when the address asks Sanity for a width or a height. */
export function isResized(p: SanityImageUrl): boolean {
  return SIZING.some((name) => numberParam(p, name) !== undefined);
}

/** The width in pixels the address delivers: `w` times `dpr`, never above the upload; the upload's own when no width is asked for. */
export function deliveredWidth(p: SanityImageUrl): number {
  const w = numberParam(p, "w");
  const h = numberParam(p, "h");
  const dpr = Math.min(numberParam(p, "dpr") ?? 1, 3);
  if (w !== undefined) return Math.min(Math.round(w * dpr), p.width);
  if (h !== undefined) return Math.min(Math.round(((h * p.width) / p.height) * dpr), p.width);
  return p.width;
}

/** A short name for a finding: the first eight characters of the asset id, then its size and format. */
export function assetLabel(p: SanityImageUrl): string {
  return `${p.assetId.slice(0, 8)}-${p.width}x${p.height}.${p.format}`;
}

export interface SanityCandidate {
  kind: "src" | "srcset" | "source";
  image: SanityImageUrl;
}

/** One img: every Sanity address it names, and the width its markup declares. */
export interface SanityImageUse {
  declaredWidth?: number;
  /** Every address on the img, src first, then its srcset, then its picture sources. */
  candidates: SanityCandidate[];
}

/** The imgs on a page that name a cdn.sanity.io image, in document order. */
export function sanityImageUses(page: Pick<PageSnapshot, "images" | "finalUrl">): SanityImageUse[] {
  const uses: SanityImageUse[] = [];
  const take = (kind: SanityCandidate["kind"], raw: string, into: SanityCandidate[]): void => {
    let abs: string;
    try {
      abs = new URL(raw, page.finalUrl).href;
    } catch {
      return;
    }
    const image = parseSanityImageUrl(abs);
    if (image) into.push({ kind, image });
  };
  for (const img of page.images) {
    const candidates: SanityCandidate[] = [];
    take("src", img.src, candidates);
    for (const c of parseSrcset(img.srcset ?? "")) take("srcset", c.url, candidates);
    for (const s of img.sources ?? [])
      for (const c of parseSrcset(s.srcset)) take("source", c.url, candidates);
    if (candidates.length > 0)
      uses.push({ ...(img.width ? { declaredWidth: img.width } : {}), candidates });
  }
  return uses;
}
