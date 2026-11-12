import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import type { HARBOUR_ASSETS } from "../../../../testkit/src/index.js";
import {
  HARBOUR,
  HARBOUR_MARKER,
  HARBOUR_PROJECT,
  harbourAssetId,
  harbourUrl,
  sanityCountsTransport,
  staticSite,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { SANITY_IMAGE_CHECKS } from "../../presets.js";
import type { AssetRead, SanityImageRead, StudioUse } from "../../sanity-images/read.js";
import { notConfigured } from "../../sanity-images/read.js";
import { checkSite } from "../../site.js";
import {
  SANITY_HEAVY_BYTES,
  SANITY_HUGE_BYTES,
  agreedAlt,
  agreedUse,
  cropIsSet,
  formatBytes,
  heavyUploads,
  hotspotIsSet,
  pageUploads,
  shapeDiffers,
} from "../images/sanity-studio.js";
import { sanityImageAltUnrendered } from "../sanity-image-alt-unrendered.js";
import { sanityImageCropIgnored } from "../sanity-image-crop-ignored.js";
import { sanityImageHeavy } from "../sanity-image-heavy.js";
import { page } from "./helpers.js";

type Name = keyof typeof HARBOUR_ASSETS;
const id = (n: Name) => harbourAssetId(n);
const img = (src: string, alt: string | null = "x") => ({ src, alt });

const read = (
  assets: Partial<Record<Name, AssetRead>>,
  extra: Partial<SanityImageRead> = {},
): SanityImageRead => ({
  project: HARBOUR_PROJECT,
  dataset: "production",
  assets: new Map(Object.entries(assets).map(([n, a]) => [id(n as Name), a])),
  foreign: [],
  skipped: 0,
  ...extra,
});

/** A context that gives the checks a prepared read and records what they could not check. */
function ctxWith(r: SanityImageRead | undefined) {
  const notes: Array<[string, string]> = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push([url, reason]),
    ...(r ? { sanityImages: () => Promise.resolve(r) } : {}),
  };
  return { ctx, notes };
}

const hotspotAt = (x: number, y: number): StudioUse => ({ hotspot: { x, y }, alt: "none" });
const cropOf = (left: number, right: number): StudioUse => ({
  crop: { left, top: 0, right, bottom: 0 },
  alt: "none",
});

describe("studio helpers: unit", () => {
  it("a crop edge under 1 percent and a hotspot within 2 percent of the middle are not set", () => {
    expect(cropIsSet(cropOf(0.009, 0))).toBe(false);
    expect(cropIsSet(cropOf(0.01, 0))).toBe(true);
    expect(cropIsSet({ alt: "text" })).toBe(false);
    expect(hotspotIsSet(hotspotAt(0.51, 0.49))).toBe(false);
    expect(hotspotIsSet(hotspotAt(0.5, 0.52))).toBe(true);
  });

  it("shapeDiffers: the asked shape against the cropped picture; a crop that leaves nothing is undefined, not a guess", () => {
    const img = { width: 4000, height: 3000 };
    expect(shapeDiffers(img, undefined, 800, 800)).toBe(true);
    expect(shapeDiffers(img, undefined, 800, 600)).toBe(false);
    expect(shapeDiffers(img, { left: 0.25, top: 0, right: 0.25, bottom: 0 }, 400, 600)).toBe(false);
    for (const crop of [
      { left: 0.5, top: 0, right: 0.5, bottom: 0 },
      { left: 0.7, top: 0, right: 0.5, bottom: 0 },
      { left: 0, top: 0.6, right: 0, bottom: 0.4 },
      { left: 0, top: 1, right: 0, bottom: 1 },
    ])
      expect(shapeDiffers(img, crop, 800, 800)).toBeUndefined();
    expect(shapeDiffers({ width: 0, height: 3000 }, undefined, 800, 800)).toBeUndefined();
    expect(shapeDiffers(img, undefined, 0, 800)).toBeUndefined();
  });

  it("agreedUse: none, one, identical and conflicting placements", () => {
    expect(agreedUse(undefined).ok).toBe(false);
    expect(agreedUse([])).toMatchObject({ ok: false });
    expect(agreedUse([cropOf(0.1, 0.1), cropOf(0.1, 0.1)])).toMatchObject({ ok: true });
    expect(agreedUse([cropOf(0.1, 0.1), cropOf(0, 0)])).toMatchObject({ ok: false });
  });

  it("agreedAlt: all, none, and mixed", () => {
    expect(agreedAlt([{ alt: "text" }, { alt: "text" }])).toEqual({ ok: true, value: true });
    expect(agreedAlt([{ alt: "none" }])).toEqual({ ok: true, value: false });
    expect(agreedAlt([{ alt: "text" }, { alt: "none" }]).ok).toBe(false);
    expect(agreedAlt([]).ok).toBe(false);
    const unknown = agreedAlt([{ alt: "unknown" }, { alt: "text" }]);
    expect(unknown).toMatchObject({ ok: false });
    expect(agreedAlt([{ alt: "unknown" }])).toMatchObject({ ok: false });
  });

  it("formatBytes uses whole numbers and tenths by integer arithmetic", () => {
    expect(formatBytes(512_000)).toBe("500 KB");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(1_480_000)).toBe("1.4 MB");
    expect(formatBytes(2_310_000)).toBe("2.2 MB");
    expect(SANITY_HEAVY_BYTES).toBe(512_000);
    expect(SANITY_HUGE_BYTES).toBe(1_048_576);
  });

  it("pageUploads keys one entry per upload and keeps each img with its alt", () => {
    const p = page({
      images: [
        img(harbourUrl("logo", "?w=200"), "a"),
        img(harbourUrl("logo", "?w=400"), null),
        img("https://other.example/a.jpg"),
      ],
    });
    const u = pageUploads(p);
    expect([...u.keys()]).toEqual([id("logo")]);
    expect(u.get(id("logo"))?.images.map((i) => i.use.alt)).toEqual(["a", null]);
  });
});

describe("sanity-image-heavy: unit", () => {
  const sizes = (...pairs: Array<[Name, number | undefined]>): SanityImageRead =>
    read(
      Object.fromEntries(
        pairs.map(([n, size]) => [n, size === undefined ? { sizeProblem: "gone" } : { size }]),
      ),
    );

  it("counts 500 KB and 1 MB uploads and lists them largest first, ties by asset id", async () => {
    const p = page({
      images: [
        img(harbourUrl("menu", "?w=600")),
        img(harbourUrl("team", "?w=800")),
        img(harbourUrl("banner")),
        img(harbourUrl("gallery", "?w=900")),
        img(harbourUrl("split", "?w=300")),
      ],
    });
    const r = sizes(
      ["menu", 640_000],
      ["team", 1_480_000],
      ["banner", 1_480_000],
      ["gallery", 180_000],
      ["split", 512_001],
    );
    const { ctx, notes } = ctxWith(r);
    const out = await sanityImageHeavy.run(p, ctx);
    expect(out).toHaveLength(1);
    // team and banner tie at 1,480,000: the id with the smaller text comes first (c4d5... after 3a9f...).
    expect(out[0]?.evidence).toBe(
      "4 Sanity uploads used on this page are heavy (2 over 1 MB, 2 between 500 KB and 1 MB), largest first: 3a9f0c1d-4000x3000.jpg 1.4 MB, c4d5e6f7-5000x2000.jpg 1.4 MB (served whole), 7c1e2d3f-2400x1600.jpg 625 KB, 99aabbcc-2000x1500.jpg 500 KB",
    );
    expect(out[0]?.severity).toBe("medium");
    expect(notes).toEqual([]);
  });

  it("the thresholds are strictly over, as images-heavy has them: 512,000 and 1,048,576 bytes are not heavy or huge", async () => {
    const p = page({
      images: [
        img(harbourUrl("menu", "?w=1")),
        img(harbourUrl("team", "?w=1")),
        img(harbourUrl("banner", "?w=1")),
      ],
    });
    const at = ctxWith(sizes(["menu", 512_000], ["team", 1_048_576], ["banner", 511_999]));
    const out = await sanityImageHeavy.run(p, at.ctx);
    // 1,048,576 is over 500 KB but not over 1 MB; 512,000 is not over 500 KB; 511,999 is neither.
    expect(out[0]?.evidence).toBe(
      "1 Sanity upload used on this page is heavy (1 between 500 KB and 1 MB), largest first: 3a9f0c1d-4000x3000.jpg 1.0 MB",
    );
    const above = ctxWith(sizes(["menu", 512_001], ["team", 1_048_577], ["banner", 511_999]));
    const out2 = await sanityImageHeavy.run(p, above.ctx);
    expect(out2[0]?.evidence).toContain("(1 over 1 MB, 1 between 500 KB and 1 MB)");
    expect(
      await sanityImageHeavy.run(
        page({ images: [img(harbourUrl("menu", "?w=1"))] }),
        ctxWith(sizes(["menu", 512_000])).ctx,
      ),
    ).toEqual([]);
  });

  it("an upload just under 500 KB, and one with no size, do not count; the one with no size is could-not-check", async () => {
    const p = page({ images: [img(harbourUrl("logo", "?w=1")), img(harbourUrl("gone", "?w=1"))] });
    const { ctx, notes } = ctxWith(sizes(["logo", 511_999], ["gone", undefined]));
    expect(await sanityImageHeavy.run(p, ctx)).toEqual([]);
    expect(notes).toEqual([[p.finalUrl, "1 upload: gone"]]);
  });

  it("lists ten and counts the rest, and a heavy upload used twice is one entry", async () => {
    const imgs = Array.from({ length: 12 }, (_, i) =>
      img(
        `https://cdn.sanity.io/images/${HARBOUR_PROJECT}/production/${`b${String(i).padStart(2, "0")}`.padEnd(40, "d")}-4000x3000.jpg?w=400`,
      ),
    );
    const assets = new Map<string, AssetRead>();
    for (const i of imgs) {
      const m = /production\/(\w+)-4000x3000/.exec(i.src);
      assets.set(`image-${m?.[1]}-4000x3000-jpg`, { size: 2_000_000 });
    }
    const p = page({ images: [...imgs, imgs[0]!] });
    const { ctx } = ctxWith({ ...read({}), assets });
    const out = await sanityImageHeavy.run(p, ctx);
    expect(out[0]?.evidence).toContain("12 Sanity uploads");
    expect(out[0]?.evidence).toMatch(/ and 2 more$/);
  });

  it("a page with no Sanity image reads nothing and passes; a read that failed is could-not-check, not a pass", async () => {
    const calls: number[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      sanityImages: () => (calls.push(1), Promise.resolve(read({}))),
    };
    expect(
      await sanityImageHeavy.run(page({ images: [img("https://other.example/a.jpg")] }), ctx),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
    const p = page({ images: [img(harbourUrl("team", "?w=1"))] });
    const failed = ctxWith(read({}, { problem: "Sanity did not accept SANITY_TOKEN." }));
    expect(await sanityImageHeavy.run(p, failed.ctx)).toEqual([]);
    expect(failed.notes).toEqual([[p.finalUrl, "Sanity did not accept SANITY_TOKEN."]]);
  });

  it("another project's uploads and uploads beyond the cap are could-not-check lines", async () => {
    const p = page({ images: [img(harbourUrl("team", "?w=1"))] });
    const { ctx, notes } = ctxWith(
      read({ team: { size: 600_000 } }, { foreign: ["x/y/z"], skipped: 3 }),
    );
    const out = await sanityImageHeavy.run(p, ctx);
    expect(out).toHaveLength(1);
    expect(notes.map((n) => n[1])).toEqual([
      "1 upload on this page belongs to another Sanity project or dataset than SANITY_PROJECT_ID and SANITY_DATASET name, so it was not read.",
      "3 uploads were not read: a run reads at most 100 uploads of one page.",
    ]);
  });

  it("heavyUploads on a Map is stable: the same sizes in any page order give the same list", () => {
    const a = page({ images: [img(harbourUrl("menu", "?w=1")), img(harbourUrl("team", "?w=1"))] });
    const b = page({ images: [img(harbourUrl("team", "?w=1")), img(harbourUrl("menu", "?w=1"))] });
    const r = read({ menu: { size: 700_000 }, team: { size: 700_000 } });
    expect(heavyUploads(pageUploads(a), r).map((h) => h.id)).toEqual(
      heavyUploads(pageUploads(b), r).map((h) => h.id),
    );
  });
});

describe("sanity-image-crop-ignored: unit", () => {
  const run = async (
    images: ReturnType<typeof img>[],
    assets: Partial<Record<Name, AssetRead>>,
  ) => {
    const { ctx, notes } = ctxWith(read(assets));
    const out = await sanityImageCropIgnored.run(page({ images }), ctx);
    return { out, notes };
  };

  it("a crop set in Studio and no rect in the address is ignored; a rect, even a different one, uses it", async () => {
    const studio: AssetRead = { uses: [cropOf(0.1, 0.1)] };
    const bad = await run([img(harbourUrl("menu", "?w=600"))], { menu: studio });
    expect(bad.out[0]?.evidence).toBe(
      "1 Sanity image ignores what the editor set in Studio: 7c1e2d3f-2400x1600.jpg (crop set in Studio, no rect in the address)",
    );
    const good = await run([img(harbourUrl("menu", "?rect=240,0,1920,1600&w=600"))], {
      menu: studio,
    });
    expect(good.out).toEqual([]);
    // A focal point overrides the crop in @sanity/image-url, so a crop with only fp-x is still ignored.
    const fp = await run([img(harbourUrl("menu", "?fp-x=0.5&fp-y=0.5&w=600"))], { menu: studio });
    expect(fp.out).toHaveLength(1);
  });

  it("a hotspot is ignored only when the address cuts to a different shape with fit=crop and carries no rect, fp or crop", async () => {
    const studio: AssetRead = { uses: [hotspotAt(0.25, 0.3)] };
    const cut = await run([img(harbourUrl("team", "?w=800&h=800&fit=crop"))], { team: studio });
    expect(cut.out[0]?.evidence).toContain(
      "hotspot set in Studio, cut to 800 by 800 around the middle",
    );
    // The same shape as the picture (4000x3000 is 4:3): nothing is cut, so nothing is lost.
    const same = await run([img(harbourUrl("team", "?w=800&h=600&fit=crop"))], { team: studio });
    expect(same.out).toEqual([]);
    for (const q of [
      "?w=800&h=800&fit=crop&rect=0,0,3000,3000",
      "?w=800&h=800&fit=crop&crop=focalpoint&fp-x=0.25&fp-y=0.3",
    ]) {
      expect((await run([img(harbourUrl("team", q))], { team: studio })).out).toEqual([]);
    }
  });

  it("a hotspot on an address with no width and height is could-not-check (CSS may crop), not a pass or a finding", async () => {
    const r = await run(
      [
        img(harbourUrl("team", "?w=800&auto=format")),
        img(harbourUrl("team", "?w=800&h=800&fit=max")),
      ],
      { team: { uses: [hotspotAt(0.25, 0.3)] } },
    );
    expect(r.out).toEqual([]);
    expect(r.notes[0]?.[1]).toContain(
      "If the page crops it with CSS (object-fit and object-position), that is not read.",
    );
  });

  it("an off-centre hotspot with a crop: the shape is judged against the cropped picture", async () => {
    // 4000x3000 cropped 25 percent off each side is 2000x3000: 2:3. Asking for 2:3 cuts nothing.
    const uses: AssetRead = {
      uses: [
        {
          crop: { left: 0.25, top: 0, right: 0.25, bottom: 0 },
          hotspot: { x: 0.25, y: 0.3 },
          alt: "none",
        },
      ],
    };
    const r = await run([img(harbourUrl("team", "?rect=1000,0,2000,3000&w=400&h=600&fit=crop"))], {
      team: uses,
    });
    expect(r.out).toEqual([]);
  });

  it("no crop or hotspot in Studio, an upload used with different crops, and an upload no published document uses", async () => {
    const r = await run(
      [
        img(harbourUrl("logo", "?w=200")),
        img(harbourUrl("split", "?w=300")),
        img(harbourUrl("gone", "?w=400")),
      ],
      {
        logo: { uses: [{ alt: "text" }] },
        split: { uses: [cropOf(0.2, 0.2), cropOf(0, 0)] },
        gone: { uses: [] },
      },
    );
    expect(r.out).toEqual([]);
    expect(r.notes.map((n) => n[1])).toEqual([
      "1 upload: it is used in several places with different crops or hotspots, so Gaugeline cannot tell which one this picture is",
      "1 upload: no published document uses it as an image value",
    ]);
  });

  it("an upload whose use could not be read is could-not-check once, by reason", async () => {
    const r = await run([img(harbourUrl("menu", "?w=1")), img(harbourUrl("team", "?w=1"))], {
      menu: { usesProblem: "A document that uses these uploads is too large to read." },
      team: { usesProblem: "A document that uses these uploads is too large to read." },
    });
    expect(r.out).toEqual([]);
    expect(r.notes).toEqual([
      [URL_PAGE, "2 uploads: A document that uses these uploads is too large to read."],
    ]);
  });

  it("srcset: the img uses the crop when any of its candidates carries the rect", async () => {
    const studio: AssetRead = { uses: [cropOf(0.1, 0.1)] };
    const p = page({
      images: [
        {
          src: harbourUrl("menu", "?w=600"),
          alt: "x",
          srcset: `${harbourUrl("menu", "?rect=1,1,1,1&w=1200")} 1200w`,
        },
      ],
    });
    const { ctx } = ctxWith(read({ menu: studio }));
    expect(await sanityImageCropIgnored.run(p, ctx)).toEqual([]);
  });
});
const URL_PAGE = page().finalUrl;

describe("sanity-image-alt-unrendered: unit", () => {
  const run = async (
    images: ReturnType<typeof img>[],
    assets: Partial<Record<Name, AssetRead>>,
  ) => {
    const { ctx, notes } = ctxWith(read(assets));
    const out = await sanityImageAltUnrendered.run(page({ images }), ctx);
    return { out, notes };
  };

  it("alt in Studio and none on the page is reported, saying which kind of none, and never the text", async () => {
    const r = await run(
      [
        img(harbourUrl("menu", "?w=600"), ""),
        img(harbourUrl("team", "?w=600"), null),
        img(harbourUrl("gallery", "?w=600"), "Crowd"),
      ],
      {
        menu: { uses: [{ alt: "text" }] },
        team: { uses: [{ alt: "text" }] },
        gallery: { uses: [{ alt: "text" }] },
      },
    );
    expect(r.out[0]?.evidence).toBe(
      "2 Sanity images have alt text in Studio that the page does not show: 7c1e2d3f-2400x1600.jpg (empty alt on the page), 3a9f0c1d-4000x3000.jpg (no alt attribute on the page)",
    );
    expect(JSON.stringify(r)).not.toContain(HARBOUR_MARKER);
  });

  it("a blank alt on the page (spaces) counts as not rendered; alt written on the page passes", async () => {
    const studio: AssetRead = { uses: [{ alt: "text" }] };
    expect(
      (await run([img(harbourUrl("menu", "?w=1"), "   ")], { menu: studio })).out,
    ).toHaveLength(1);
    expect(
      (await run([img(harbourUrl("menu", "?w=1"), "Menu board")], { menu: studio })).out,
    ).toEqual([]);
  });

  it("no alt in Studio means nothing is unrendered, even when the page has none", async () => {
    expect(
      (await run([img(harbourUrl("logo", "?w=1"), "")], { logo: { uses: [{ alt: "none" }] } })).out,
    ).toEqual([]);
  });

  it("alt stored as a localized or structured value is could-not-check, never a finding and never a pass", async () => {
    const r = await run([img(harbourUrl("menu", "?w=1"), "")], {
      menu: { uses: [{ alt: "unknown" }] },
    });
    expect(r.out).toEqual([]);
    expect(r.notes).toEqual([
      [
        URL_PAGE,
        "1 upload: its alt text is stored as a localized or structured value, which Gaugeline does not read",
      ],
    ]);
  });

  it("an upload used in several places where only some have alt text is could-not-check", async () => {
    const r = await run([img(harbourUrl("split", "?w=1"), "")], {
      split: { uses: [{ alt: "text" }, { alt: "none" }] },
    });
    expect(r.out).toEqual([]);
    expect(r.notes[0]?.[1]).toContain("only some have alt text");
  });
});

describe("the three checks without a read configured", () => {
  it("asked by id with no Sanity settings, each says it could not check and none passes", async () => {
    const p = page({ images: [img(harbourUrl("team", "?w=1"))] });
    for (const check of [sanityImageCropIgnored, sanityImageAltUnrendered, sanityImageHeavy]) {
      const { ctx, notes } = ctxWith(notConfigured());
      expect(await check.run(p, ctx)).toEqual([]);
      expect(notes[0]?.[1]).toContain("gaugeline.adapters.json does not name sanity");
    }
  });
});

describe("sanity studio images: integration (a fetched page and a fake dataset, whole run)", () => {
  const ORIGIN = "https://harbourlane.test";
  function world(seen: SeenSanityRequest[] = []) {
    const dataset = sanityCountsTransport(HARBOUR, seen);
    return createFetcher({
      transport: staticSite(
        "harbourlane.test",
        join(SITES_DIR, "sanity-studio-images"),
        (url, req) =>
          url.hostname === `${HARBOUR_PROJECT}.api.sanity.io`
            ? dataset(url, req)
            : Promise.reject(new Error(`unexpected host ${url.hostname}`)),
        { origin: ORIGIN },
      ),
    });
  }
  const env = { SANITY_PROJECT_ID: HARBOUR_PROJECT, SANITY_DATASET: "production" };

  it("with sanity configured, finds what the invented page gets wrong and says what it could not check", async () => {
    const seen: SeenSanityRequest[] = [];
    const { result } = await checkSite({
      address: ORIGIN,
      fetcher: world(seen),
      only: [...SANITY_IMAGE_CHECKS],
      sanityImages: { env },
      sanityImagesSleep: () => Promise.resolve(),
    });
    const by = Object.fromEntries(result.findings.map((f) => [f.checkId, f.evidence]));
    expect(by["sanity-image-crop-ignored"]).toBe(
      "2 Sanity images ignore what the editor set in Studio: 3a9f0c1d-4000x3000.jpg (hotspot set in Studio, cut to 800 by 800 around the middle), 7c1e2d3f-2400x1600.jpg (crop set in Studio, no rect in the address)",
    );
    expect(by["sanity-image-alt-unrendered"]).toBe(
      "1 Sanity image has alt text in Studio that the page does not show: 7c1e2d3f-2400x1600.jpg (empty alt on the page)",
    );
    expect(by["sanity-image-heavy"]).toBe(
      "3 Sanity uploads used on this page are heavy (2 over 1 MB, 1 between 500 KB and 1 MB), largest first: c4d5e6f7-5000x2000.jpg 2.2 MB (served whole), 3a9f0c1d-4000x3000.jpg 1.4 MB, 7c1e2d3f-2400x1600.jpg 625 KB",
    );
    const cnc = result.couldNotCheck.map((c) => `${c.id}: ${c.reason}`);
    expect(
      cnc.some((c) =>
        c.startsWith("sanity-image-crop-ignored: 1 upload: no published document uses it"),
      ),
    ).toBe(true);
    expect(
      cnc.some((c) =>
        c.startsWith("sanity-image-heavy: 1 upload: Sanity has no upload with this id"),
      ),
    ).toBe(true);
    expect(cnc.filter((c) => c.includes("belongs to another Sanity project"))).toHaveLength(3);
    // Every request to Sanity is a GET of the query endpoint, one per batch.
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(seen.every((s) => new URL(s.url).hostname === `${HARBOUR_PROJECT}.api.sanity.io`)).toBe(
      true,
    );
  });

  it("without sanity configured the three checks are not run, and nothing is asked of Sanity", async () => {
    const seen: SeenSanityRequest[] = [];
    const { result } = await checkSite({ address: ORIGIN, fetcher: world(seen) });
    for (const id of SANITY_IMAGE_CHECKS) {
      expect(result.findings.some((f) => f.checkId === id)).toBe(false);
      expect(result.passed).not.toContain(id);
    }
    // (The existing dataset checks may ask for counts; none asks for an asset or a reference.)
    expect(seen.filter((r) => /_id in|references\(/.test(r.query))).toHaveLength(0);
  });

  it("a refused token ends in could-not-check for each check and never in a pass", async () => {
    const token = ["sk", "H4rb0urViewer", "0123456789abcdefghij"].join("");
    const dataset = sanityCountsTransport({ ...HARBOUR, token: token });
    const fetcher = createFetcher({
      transport: staticSite(
        "harbourlane.test",
        join(SITES_DIR, "sanity-studio-images"),
        (url, req) => dataset(url, req),
        { origin: ORIGIN },
      ),
    });
    const { result } = await checkSite({
      address: ORIGIN,
      fetcher,
      only: [...SANITY_IMAGE_CHECKS],
      sanityImages: { env: { ...env, SANITY_TOKEN: "wrong" } },
      sanityImagesSleep: () => Promise.resolve(),
    });
    expect(result.findings).toEqual([]);
    expect(result.passed).toEqual([]);
    expect(result.couldNotCheck.map((c) => c.id).sort()).toEqual([...SANITY_IMAGE_CHECKS].sort());
    expect(JSON.stringify(result)).not.toContain("wrong");
  });
});
