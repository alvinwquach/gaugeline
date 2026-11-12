import type { FakeSanity } from "./sanity-counts.js";

/**
 * Every alt text in the invented Harbour Lane dataset starts with this, so a test can search a request
 * log, an output or a finding for it and know that a value an editor wrote got out.
 */
export const HARBOUR_MARKER = "HARBOUR-MARKER";

/** The invented project the Harbour Lane Tap Room's pictures live in, and one that is not theirs. */
export const HARBOUR_PROJECT = "hl9t4vz6";
export const OTHER_PROJECT = "zq8w7e5r";

/**
 * Invented hashes (forty hex digits, the shape of a Sanity asset's) and the sizes in the file names.
 * None belongs to a real upload.
 */
export const HARBOUR_ASSETS = {
  /** The team photo: a hotspot on the left, and 1.4 MB as uploaded. */
  team: {
    hash: "3a9f0c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f901",
    dims: "4000x3000",
    ext: "jpg",
    size: 1_480_000,
  },
  /** The cocktail menu board: cropped in Studio, alt text written, 640 KB. */
  menu: {
    hash: "7c1e2d3f4a5b6c7d8e9f0a1b2c3d4e5f60718293",
    dims: "2400x1600",
    ext: "jpg",
    size: 640_000,
  },
  /** The Friday gallery shot: a hotspot, handled correctly by the page, 180 KB. */
  gallery: {
    hash: "b5a4c3d2e1f0918273645546372819a0b1c2d3e4",
    dims: "1800x1200",
    ext: "jpg",
    size: 180_000,
  },
  /** The logo: no crop, no hotspot, an empty alt in Studio, 40 KB. */
  logo: {
    hash: "e0d1c2b3a49586776655443322110ffeeddccbba",
    dims: "800x300",
    ext: "png",
    size: 40_000,
  },
  /** The harbour at dusk banner: 2.2 MB, and the page serves it whole. */
  banner: {
    hash: "c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f901a2b3c4",
    dims: "5000x2000",
    ext: "jpg",
    size: 2_310_000,
  },
  /** Used in two documents with two different crops. */
  split: {
    hash: "99aabbccddeeff00112233445566778899aabbcc",
    dims: "2000x1500",
    ext: "jpg",
    size: 90_000,
  },
  /** On the page, and deleted from the dataset: Sanity has no asset document for it. */
  gone: {
    hash: "1122334455667788990011223344556677889900",
    dims: "3000x2000",
    ext: "jpg",
    size: 0,
  },
} as const;

export type HarbourAsset = keyof typeof HARBOUR_ASSETS;

/** The asset document id of one of them: `image-<hash>-<width>x<height>-<format>`. */
export const harbourAssetId = (name: HarbourAsset): string => {
  const a = HARBOUR_ASSETS[name];
  return `image-${a.hash}-${a.dims}-${a.ext}`;
};

/** The address of one of them on Sanity's image network, with a query such as `?w=800`. */
export const harbourUrl = (name: HarbourAsset, query = "", project = HARBOUR_PROJECT): string => {
  const a = HARBOUR_ASSETS[name];
  return `https://cdn.sanity.io/images/${project}/production/${a.hash}-${a.dims}.${a.ext}${query}`;
};

const ref = (name: HarbourAsset) => ({ _type: "reference", _ref: harbourAssetId(name) });
const assetDoc = (name: Exclude<HarbourAsset, "gone">) => {
  const a = HARBOUR_ASSETS[name];
  const [width, height] = a.dims.split("x").map(Number) as [number, number];
  return {
    _id: harbourAssetId(name),
    _type: "sanity.imageAsset",
    assetId: a.hash,
    extension: a.ext,
    mimeType: `image/${a.ext === "jpg" ? "jpeg" : a.ext}`,
    size: a.size,
    originalFilename: `${HARBOUR_MARKER}-${name}.${a.ext}`,
    metadata: { dimensions: { width, height } },
  };
};
const hotspot = (x: number, y: number) => ({
  _type: "sanity.imageHotspot",
  x,
  y,
  width: 0.4,
  height: 0.4,
});
const crop = (left: number, top: number, right: number, bottom: number) => ({
  _type: "sanity.imageCrop",
  left,
  top,
  right,
  bottom,
});

/**
 * The Harbour Lane Tap Room's invented dataset for the Sanity image checks: seven uploads (six with an
 * asset document, one deleted), the published documents that use them, and a draft that must not count.
 * Alt text starts with HARBOUR_MARKER. Nothing here was recorded from a real dataset.
 */
export function harbourContent(): Record<string, Record<string, unknown>[]> {
  const assets = (["team", "menu", "gallery", "logo", "banner", "split"] as const).map(assetDoc);
  return {
    "sanity.imageAsset": assets,
    documents: [
      {
        _id: "page-home",
        _type: "page",
        title: `${HARBOUR_MARKER} title`,
        hero: {
          _type: "image",
          asset: ref("team"),
          hotspot: hotspot(0.25, 0.3),
          crop: crop(0, 0, 0, 0),
          alt: `${HARBOUR_MARKER} the team behind the bar`,
        },
        banner: {
          _type: "image",
          asset: ref("banner"),
          alt: `${HARBOUR_MARKER} the harbour at dusk`,
        },
      },
      // The editor's unpublished change: a published read never sees it.
      {
        _id: "drafts.page-home",
        _type: "page",
        hero: { _type: "image", asset: ref("team"), hotspot: hotspot(0.5, 0.5), alt: "" },
      },
      {
        _id: "page-menu",
        _type: "page",
        board: {
          _type: "image",
          asset: ref("menu"),
          crop: crop(0.1, 0, 0.1, 0),
          alt: `${HARBOUR_MARKER} cocktail menu board`,
        },
      },
      {
        _id: "event-friday",
        _type: "event",
        gallery: [
          {
            _type: "image",
            _key: "g1",
            asset: ref("gallery"),
            hotspot: hotspot(0.6, 0.4),
            crop: crop(0, 0, 0, 0),
            alt: `${HARBOUR_MARKER} friday crowd`,
          },
        ],
      },
      {
        _id: "settings",
        _type: "siteSettings",
        logo: { _type: "image", asset: ref("logo"), alt: "" },
      },
      {
        _id: "event-a",
        _type: "event",
        photo: {
          _type: "image",
          asset: ref("split"),
          crop: crop(0.2, 0, 0.2, 0),
          alt: `${HARBOUR_MARKER} a`,
        },
      },
      {
        _id: "event-b",
        _type: "event",
        photo: { _type: "image", asset: ref("split"), crop: crop(0, 0, 0, 0), alt: "" },
      },
    ],
  };
}

export const HARBOUR: FakeSanity = { types: {}, content: harbourContent() };
