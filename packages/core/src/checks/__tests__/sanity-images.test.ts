import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { checkSite } from "../../site.js";
import {
  SANITY_ORIGINAL_MIN_PX,
  deliveredWidth,
  isResized,
  parseSanityImageUrl,
  sanityImageUses,
} from "../images/sanity-url.js";
import { sanityImageDuplicate } from "../sanity-image-duplicate.js";
import { sanityImageOriginal } from "../sanity-image-original.js";
import { sanityImageOversized } from "../sanity-image-oversized.js";
import { ctx, page } from "./helpers.js";

// Invented ids: forty hex digits, as Sanity writes them, but none belongs to a real asset.
const A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const B = "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334";
const CDN = "https://cdn.sanity.io/images/p3xk9wq2/production";
const img = (id: string, dims: string, ext: string, query = "") =>
  `${CDN}/${id}-${dims}.${ext}${query}`;

describe("sanity image urls: unit", () => {
  it("reads project, dataset, asset, size, format and parameters from the address", () => {
    const p = parseSanityImageUrl(img(A, "4032x3024", "jpg", "?w=800&h=600&fit=crop&auto=format"));
    expect(p).toMatchObject({
      projectId: "p3xk9wq2",
      dataset: "production",
      assetId: A,
      width: 4032,
      height: 3024,
      format: "jpg",
    });
    expect(p?.params.get("w")).toBe("800");
    expect(p?.params.get("auto")).toBe("format");
  });

  it("is undefined for other hosts, files, malformed names and the vanity suffix is tolerated", () => {
    expect(parseSanityImageUrl("https://cdn.example/images/p/d/x-1x1.jpg")).toBeUndefined();
    expect(parseSanityImageUrl(`https://cdn.sanity.io/files/p3xk9wq2/production/${A}.pdf`)).toBe(
      undefined,
    );
    expect(parseSanityImageUrl(`${CDN}/${A}.jpg`)).toBeUndefined();
    expect(parseSanityImageUrl("not a url")).toBeUndefined();
    expect(parseSanityImageUrl(`${img(A, "800x600", "png")}/front-door.png`)?.assetId).toBe(A);
  });

  it("isResized sees every sizing parameter and nothing else", () => {
    const of = (q: string) => parseSanityImageUrl(img(A, "4000x3000", "jpg", q));
    for (const q of ["?w=800", "?h=600", "?max-w=900", "?min-h=300", "?max-h=900", "?min-w=1"])
      expect(isResized(of(q)!)).toBe(true);
    for (const q of ["", "?auto=format", "?q=80&fm=webp", "?fit=crop", "?rect=0,0,100,100"])
      expect(isResized(of(q)!)).toBe(false);
  });

  it("deliveredWidth: w times dpr, never above the original; h alone keeps the ratio; none is the original", () => {
    const of = (q: string) => parseSanityImageUrl(img(A, "4000x3000", "jpg", q))!;
    expect(deliveredWidth(of("?w=800"))).toBe(800);
    expect(deliveredWidth(of("?w=800&dpr=2"))).toBe(1600);
    expect(deliveredWidth(of("?w=9000"))).toBe(4000);
    expect(deliveredWidth(of("?h=600"))).toBe(800);
    expect(deliveredWidth(of(""))).toBe(4000);
    expect(deliveredWidth(of("?w=abc"))).toBe(4000);
  });

  it("sanityImageUses lists src, srcset and picture candidates of each img, skipping other hosts", () => {
    const p = page({
      images: [
        {
          src: img(A, "4000x3000", "jpg", "?w=400"),
          alt: "x",
          width: 400,
          srcset: `${img(A, "4000x3000", "jpg", "?w=800")} 800w, /local.jpg 1200w`,
          sources: [{ srcset: img(A, "4000x3000", "webp", "?w=800") }],
        },
        { src: "https://other.example/a.jpg", alt: "y" },
      ],
    });
    const uses = sanityImageUses(p);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.declaredWidth).toBe(400);
    expect(uses[0]?.candidates.map((c) => c.kind)).toEqual(["src", "srcset", "source"]);
  });
});

describe("sanity-image-original: unit", () => {
  it("names images served with no width or height, with their upload size", async () => {
    const p = page({
      images: [
        { src: img(A, "4032x3024", "jpg"), alt: "Pour-over bar" },
        { src: img(B, "3000x2000", "png", "?auto=format"), alt: "Menu" },
        { src: img(B, "3000x2000", "png", "?w=600&auto=format"), alt: "Menu small" },
      ],
    });
    const out = await sanityImageOriginal.run(p, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toBe(
      `2 Sanity images are served at the size they were uploaded: ${A.slice(0, 8)}-4032x3024.jpg, ${B.slice(0, 8)}-3000x2000.png`,
    );
    expect(out[0]?.severity).toBe("medium");
  });

  it("passes resized images, small originals, other hosts and a page with no images", async () => {
    expect(await sanityImageOriginal.run(page(), ctx)).toEqual([]);
    const small = Math.floor(SANITY_ORIGINAL_MIN_PX / 2);
    const p = page({
      images: [
        { src: img(A, "4032x3024", "jpg", "?w=900&h=600&fit=crop"), alt: "a" },
        { src: img(B, `${small}x${small}`, "png"), alt: "logo" },
        { src: "https://images.example/hero-4032x3024.jpg", alt: "other" },
      ],
    });
    expect(await sanityImageOriginal.run(p, ctx)).toEqual([]);
  });

  it("looks at srcset and picture candidates too, once per address", async () => {
    const full = img(A, "4000x3000", "jpg");
    const p = page({
      images: [
        { src: full, alt: "a" },
        {
          src: img(A, "4000x3000", "jpg", "?w=400"),
          alt: "b",
          srcset: `${full} 4000w`,
          sources: [{ srcset: full }],
        },
      ],
    });
    const out = await sanityImageOriginal.run(p, ctx);
    expect(out[0]?.evidence).toMatch(/^1 Sanity image is served/);
  });
});

describe("sanity-image-oversized: unit", () => {
  const shown = (src: string, width: number, extra: object = {}) => ({
    src,
    alt: "a",
    width,
    ...extra,
  });

  it("flags an image delivered far wider than its width attribute", async () => {
    const p = page({ images: [shown(img(A, "4032x3024", "jpg", "?w=2400"), 400)] });
    const out = await sanityImageOversized.run(p, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toContain("2400 px wide for a 400 px slot");
    expect(out[0]?.evidence).toContain("36x the pixels");
  });

  it("a whole original counts as its upload width", async () => {
    const p = page({ images: [shown(img(A, "4032x3024", "jpg"), 600)] });
    expect((await sanityImageOversized.run(p, ctx))[0]?.evidence).toContain(
      "4032 px wide for a 600 px slot",
    );
  });

  it("allows up to twice the slot for sharp screens, and ignores images with no width attribute", async () => {
    const ok = page({
      images: [
        shown(img(A, "4032x3024", "jpg", "?w=800"), 400),
        { src: img(B, "4032x3024", "jpg", "?w=3000"), alt: "no width" },
      ],
    });
    expect(await sanityImageOversized.run(ok, ctx)).toEqual([]);
  });

  it("with a srcset the browser can pick a small one, so only an all-large set is flagged", async () => {
    const small = shown(img(A, "4032x3024", "jpg", "?w=800"), 400, {
      srcset: `${img(A, "4032x3024", "jpg", "?w=400")} 400w, ${img(A, "4032x3024", "jpg", "?w=2400")} 2400w`,
    });
    const large = shown(img(B, "4032x3024", "jpg", "?w=2000"), 400, {
      srcset: `${img(B, "4032x3024", "jpg", "?w=2000")} 2000w, ${img(B, "4032x3024", "jpg", "?w=3000")} 3000w`,
    });
    expect(await sanityImageOversized.run(page({ images: [small] }), ctx)).toEqual([]);
    expect((await sanityImageOversized.run(page({ images: [large] }), ctx))[0]?.evidence).toContain(
      "2000 px wide for a 400 px slot",
    );
  });

  it("a small excess is not worth a finding", async () => {
    const p = page({ images: [shown(img(A, "1000x800", "jpg"), 450)] });
    expect(await sanityImageOversized.run(p, ctx)).toEqual([]);
  });
});

describe("sanity-image-duplicate: unit", () => {
  it("flags one asset requested with different parameters in different images", async () => {
    const p = page({
      images: [
        { src: img(A, "4032x3024", "jpg", "?w=1200&auto=format"), alt: "Hero" },
        { src: img(A, "4032x3024", "jpg", "?w=400&h=400&fit=crop&auto=format"), alt: "Card" },
        { src: img(B, "3000x2000", "jpg", "?w=600"), alt: "Other" },
      ],
    });
    const out = await sanityImageDuplicate.run(p, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toBe(
      `1 asset is processed more than once on this page: ${A.slice(0, 8)}-4032x3024.jpg as 2 different addresses (w=1200&auto=format; w=400&h=400&fit=crop&auto=format)`,
    );
    expect(out[0]?.severity).toBe("low");
  });

  it("does not count one image's own srcset, the same address twice, or parameter order", async () => {
    const p = page({
      images: [
        {
          src: img(A, "4000x3000", "jpg", "?w=400&auto=format"),
          alt: "a",
          srcset: `${img(A, "4000x3000", "jpg", "?w=800&auto=format")} 800w`,
        },
        { src: img(A, "4000x3000", "jpg", "?auto=format&w=400"), alt: "same again" },
      ],
    });
    expect(await sanityImageDuplicate.run(p, ctx)).toEqual([]);
    expect(await sanityImageDuplicate.run(page(), ctx)).toEqual([]);
  });
});

describe("sanity images: integration (a fetched page)", () => {
  it("runs on the invented bakery page and the three findings come from its markup", async () => {
    const site = await startFixture("sanity-images");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["sanity-image-original", "sanity-image-oversized", "sanity-image-duplicate"],
      });
      expect(result.findings.map((f) => [f.checkId, f.severity])).toEqual([
        ["sanity-image-original", "medium"],
        ["sanity-image-oversized", "medium"],
        ["sanity-image-duplicate", "low"],
      ]);
      expect(result.findings[0]?.evidence).toBe(
        "1 Sanity image is served at the size it was uploaded: a1b2c3d4-4032x3024.jpg",
      );
      // Pure page checks: nothing but the page and its own files is requested.
      expect([...site.hits.keys()].every((k) => !k.startsWith("/images/"))).toBe(true);
    } finally {
      await site.close();
    }
  });
});
