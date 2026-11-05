import type { Fetcher, Hop } from "../../fetcher.js";
import type { Budget } from "../../limits.js";
import { probe } from "../../probe.js";
import { normaliseUrl } from "../../normalise.js";
import { isSameSite } from "../../sample.js";
import type { PageSnapshot } from "../../snapshot.js";

/** Thresholds, named here so the checks reference states them once. */
export const IMAGE_HEAVY_BYTES = 500 * 1024;
export const IMAGE_ABSURD_WIDTH = 3840;

/** One img, parsed once for every image check. */
export interface ImageRef {
  src: string;
  alt: string | null;
  srcset: { url: string; w?: number; x?: number }[];
  /** For /_next/image addresses: the url= parameter, the original image. */
  nextImageSource?: string;
  /** For /_next/image addresses: the w= parameter. */
  nextImageWidth?: number;
  /** <picture> <source> types and candidate URLs, for the format check. */
  sources: { type?: string; urls: string[] }[];
}

/**
 * A srcset attribute's candidates, after the HTML standard's algorithm: a URL runs to the next
 * whitespace (so commas inside a URL stay in it), a URL ending in commas ends the candidate, and
 * descriptors run to the next comma outside parentheses.
 */
export function parseSrcset(value: string): { url: string; w?: number; x?: number }[] {
  const out: { url: string; w?: number; x?: number }[] = [];
  let i = 0;
  const n = value.length;
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  while (i < n) {
    while (i < n && (space(value[i]) || value[i] === ",")) i++;
    if (i >= n) break;
    let url = "";
    while (i < n && !space(value[i])) url += value[i++];
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      while (i < n) {
        const c = value[i] ?? "";
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) break;
        descriptors += c;
        i++;
      }
      i++; // the comma
    }
    if (url === "") continue;
    const cand: { url: string; w?: number; x?: number } = { url };
    for (const d of descriptors.trim().split(/\s+/)) {
      const m = /^(\d+(?:\.\d+)?)([wx])$/.exec(d);
      if (m?.[2] === "w") cand.w = Number(m[1]);
      else if (m?.[2] === "x") cand.x = Number(m[1]);
    }
    out.push(cand);
  }
  return out;
}

function resolve(url: string, base: string): string | undefined {
  try {
    return new URL(url, base).href;
  } catch {
    return undefined;
  }
}

/** /_next/image?url=%2Fhero.jpg&w=3840 -> { source: "/hero.jpg", width: 3840 }. */
export function nextImage(src: string): { source?: string; width?: number } {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return {};
  }
  if (!/\/_next\/image\/?$/.test(u.pathname)) return {};
  const source = u.searchParams.get("url") ?? undefined;
  const w = Number(u.searchParams.get("w"));
  return { ...(source ? { source } : {}), ...(Number.isFinite(w) && w > 0 ? { width: w } : {}) };
}

/** The w= query parameter of any image address (image CDNs and Next.js use it). */
export function widthParam(url: string): number | undefined {
  try {
    const w = Number(new URL(url).searchParams.get("w"));
    return Number.isFinite(w) && w > 0 ? w : undefined;
  } catch {
    return undefined;
  }
}

/** Every img, with data: URIs skipped everywhere (they are part of the page, not requests). */
export function imageRefs(page: Pick<PageSnapshot, "images" | "finalUrl">): ImageRef[] {
  const base = page.finalUrl;
  return page.images.flatMap((img) => {
    if (img.src.startsWith("data:")) return [];
    const srcset = parseSrcset(img.srcset ?? "")
      .filter((c) => !c.url.startsWith("data:"))
      .flatMap((c) => {
        const url = resolve(c.url, base);
        return url ? [{ ...c, url }] : [];
      });
    const next = nextImage(img.src);
    const sources = (img.sources ?? []).map((s) => ({
      ...(s.type ? { type: s.type } : {}),
      urls: parseSrcset(s.srcset).flatMap((c) =>
        c.url.startsWith("data:") ? [] : [resolve(c.url, base) ?? c.url],
      ),
    }));
    return [
      {
        src: img.src,
        alt: img.alt,
        srcset,
        ...(next.source ? { nextImageSource: next.source } : {}),
        ...(next.width ? { nextImageWidth: next.width } : {}),
        sources,
      },
    ];
  });
}

/** True when the img offers WebP or AVIF: a <source> type, a candidate's extension, or /_next/image. */
export function hasModernCandidate(ref: ImageRef): boolean {
  const modern = /\.(?:webp|avif)(?:$|[?#])/i;
  if (
    ref.sources.some(
      (s) => /image\/(?:webp|avif)/.test(s.type ?? "") || s.urls.some((u) => modern.test(u)),
    )
  )
    return true;
  if (ref.srcset.some((c) => modern.test(c.url)) || modern.test(ref.src)) return true;
  // Next.js negotiates WebP or AVIF from the Accept header, so its optimiser counts as a candidate.
  return ref.nextImageSource !== undefined;
}

/** One sampled image: its probe hops (headers only). */
export interface ImageResult {
  url: string;
  ref: ImageRef;
  hops: Hop[];
}

export interface ImageSample {
  seen: number;
  taken: ImageResult[];
}

export interface ImageSampleOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/** Same-site images, de-duplicated, the first 20 probed: HEAD, or GET only after a 405 or 501. */
export async function sampleImages({
  page,
  fetcher,
  budget,
}: ImageSampleOptions): Promise<ImageSample> {
  // A Map keyed by normalised URL: first-seen order, one entry per address, O(1) lookups.
  const byUrl = new Map<string, ImageRef>();
  for (const r of imageRefs(page)) {
    if (!isSameSite(r.src, page.finalUrl)) continue;
    let key: string;
    try {
      key = normaliseUrl(r.src);
    } catch {
      continue;
    }
    if (!byUrl.has(key)) byUrl.set(key, r);
  }
  const unique = [...byUrl.keys()];
  const taken = budget.take("images", unique);
  const hops = await Promise.all(taken.map((url) => probe(url, fetcher)));
  return {
    seen: unique.length,
    taken: taken.flatMap((url, i) => {
      const ref = byUrl.get(url);
      return ref ? [{ url, ref, hops: hops[i] ?? [] }] : [];
    }),
  };
}

/** The shared image sample, built on first call. `peek` returns it only if something already asked. */
export interface LazyImageSample {
  (): Promise<ImageSample>;
  peek(): Promise<ImageSample> | undefined;
}

export function lazyImageSample(opts: ImageSampleOptions): LazyImageSample {
  let pending: Promise<ImageSample> | undefined;
  const get = () => (pending ??= sampleImages(opts));
  return Object.assign(get, { peek: () => pending });
}
