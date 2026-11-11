import { parse } from "groq-js";
import { describe, expect, it } from "vitest";
import {
  HARBOUR,
  HARBOUR_ASSETS,
  HARBOUR_MARKER,
  HARBOUR_PROJECT,
  OTHER_PROJECT,
  harbourAssetId,
  harbourContent,
  harbourUrl,
  sanityCountsTransport,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { parseSanityImageUrl } from "../../checks/images/sanity-url.js";
import { createFetcher } from "../../fetcher.js";
import {
  SANITY_ASSET_CAP,
  SIZE_BATCH,
  USES_BATCH,
  assetDocumentId,
  readSanityImages,
  sizeQuery,
  studioUses,
  usesQuery,
} from "../read.js";

// Built at run time so no key-shaped string sits in the source.
const TOKEN = ["sk", "H4rb0urViewer", "0123456789abcdefghij"].join("");
const ENV = {
  SANITY_PROJECT_ID: HARBOUR_PROJECT,
  SANITY_DATASET: "production",
  SANITY_TOKEN: TOKEN,
};
const noWait = (): Promise<void> => Promise.resolve();

const pageOf = (...srcs: string[]) => ({
  finalUrl: "https://harbourlane.test/",
  images: srcs.map((src) => ({ src, alt: "x" })),
});

function world(spec = HARBOUR, seen: SeenSanityRequest[] = []) {
  const dataset = sanityCountsTransport(spec, seen);
  return createFetcher({
    transport: (url, req) =>
      url.hostname === `${HARBOUR_PROJECT}.api.sanity.io`
        ? dataset(url, req)
        : Promise.reject(new Error(`unexpected host ${url.hostname}`)),
  });
}

describe("asset document ids and the queries built from them: unit", () => {
  it("an address names the asset document `image-<hash>-<w>x<h>-<format>`", () => {
    const p = parseSanityImageUrl(harbourUrl("team", "?w=800"));
    expect(p && assetDocumentId(p)).toBe(harbourAssetId("team"));
    expect(harbourAssetId("logo")).toBe(`image-${HARBOUR_ASSETS.logo.hash}-800x300-png`);
  });

  it("the queries are valid GROQ and carry each id as a JSON string", () => {
    const ids = [harbourAssetId("team"), harbourAssetId("menu")];
    for (const q of [sizeQuery(ids), usesQuery(ids)]) expect(() => parse(q)).not.toThrow();
    expect(sizeQuery(ids)).toContain(JSON.stringify(ids[0]));
    expect(usesQuery(ids)).toContain(`references(${JSON.stringify(ids[1])})`);
    expect(usesQuery(ids)).toMatch(/\[0\.\.\.31\]$/);
  });

  it("an id that is not the shape of an asset id never reaches a query", () => {
    for (const bad of [
      'image-abcdefgh12-100x100-jpg"] || true || ["',
      "image-abc-1x1-jpg",
      "x",
      "",
      `${harbourAssetId("team")}\n`,
    ]) {
      expect(() => sizeQuery([bad])).toThrow();
      expect(() => usesQuery([bad])).toThrow();
    }
    expect(() => sizeQuery([])).toThrow();
  });
});

describe("studioUses: unit", () => {
  const want = new Set([harbourAssetId("team")]);
  const value = {
    _type: "image",
    asset: { _type: "reference", _ref: harbourAssetId("team") },
    crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 },
    hotspot: { x: 0.25, y: 0.3, width: 0.4, height: 0.4 },
    alt: `${HARBOUR_MARKER} the team`,
  };

  it("finds image values at any depth, in arrays and objects, and keeps only numbers and a yes or no", () => {
    const doc = { _id: "d", sections: [{ blocks: [{ cta: { image: value } }, { other: 1 }] }] };
    const found = studioUses(doc, want);
    expect(found).toEqual([
      {
        id: harbourAssetId("team"),
        use: {
          crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 },
          hotspot: { x: 0.25, y: 0.3 },
          alt: true,
        },
      },
    ]);
    // The text an editor wrote is not in what is kept.
    expect(JSON.stringify(found)).not.toContain(HARBOUR_MARKER);
  });

  it("ignores references to other assets and objects that are not image values", () => {
    const other = { asset: { _ref: harbourAssetId("menu") } };
    expect(studioUses({ a: other, b: { author: { _ref: harbourAssetId("team") } } }, want)).toEqual(
      [],
    );
  });

  it("alt: blank or missing is false; crop and hotspot outside 0 to 1 or not numbers are dropped", () => {
    const base = { asset: { _ref: harbourAssetId("team") } };
    const a = studioUses({ x: { ...base, alt: "  " } }, want)?.[0]?.use;
    expect(a).toEqual({ alt: false });
    const b = studioUses(
      {
        x: {
          ...base,
          crop: { left: 2, top: 0, right: 0, bottom: 0 },
          hotspot: { x: "0.5", y: 0.5 },
        },
      },
      want,
    )?.[0]?.use;
    expect(b).toEqual({ alt: false });
  });

  it("a document nested past the depth cap or past the node cap is not read to the end", () => {
    let deep: unknown = value;
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(studioUses(deep, want)).toBeUndefined();
    expect(studioUses({ list: Array.from({ length: 60_000 }, () => ({})) }, want)).toBeUndefined();
  });
});

describe("readSanityImages: integration (a fake Sanity query endpoint over invented documents)", () => {
  const page = pageOf(
    harbourUrl("team", "?w=800&h=800&fit=crop"),
    harbourUrl("menu", "?w=600"),
    harbourUrl("gallery", "?w=900"),
    harbourUrl("logo", "?w=200"),
    harbourUrl("banner"),
    harbourUrl("split", "?w=300"),
    harbourUrl("gone", "?w=400"),
    harbourUrl("team", "?w=400"),
    harbourUrl("logo", "", OTHER_PROJECT),
  );

  it("reads each upload's size (whole bytes) and what Studio set, published documents only", async () => {
    const seen: SeenSanityRequest[] = [];
    const read = await readSanityImages({
      page,
      env: ENV,
      fetcher: world(HARBOUR, seen),
      sleep: noWait,
    });
    expect(read.problem).toBeUndefined();
    expect(read.project).toBe(HARBOUR_PROJECT);
    // One entry for the team photo although two imgs use it; sorted by id.
    expect([...read.assets.keys()]).toEqual(
      ["team", "menu", "gallery", "logo", "banner", "split", "gone"]
        .map((n) => harbourAssetId(n as keyof typeof HARBOUR_ASSETS))
        .sort(),
    );
    const of = (n: keyof typeof HARBOUR_ASSETS) => read.assets.get(harbourAssetId(n));
    expect(of("team")?.size).toBe(1_480_000);
    expect(Number.isInteger(of("banner")?.size)).toBe(true);
    // The draft's hotspot (0.5, 0.5) is not seen: the published value is.
    expect(of("team")?.uses).toEqual([
      { crop: { left: 0, top: 0, right: 0, bottom: 0 }, hotspot: { x: 0.25, y: 0.3 }, alt: true },
    ]);
    expect(of("menu")?.uses?.[0]).toMatchObject({ crop: { left: 0.1, right: 0.1 }, alt: true });
    expect(of("logo")?.uses).toEqual([{ alt: false }]);
    expect(of("split")?.uses).toHaveLength(2);
    // Deleted from the dataset: no size, and the reason says so. No document uses it either.
    expect(of("gone")?.size).toBeUndefined();
    expect(of("gone")?.sizeProblem).toMatch(/no upload with this id/);
    expect(of("gone")?.uses).toEqual([]);
    // Another project's upload is listed, never asked.
    expect(read.foreign).toHaveLength(1);
    expect(read.skipped).toBe(0);
    // Counted against the sorted ids: 7 uploads, so one size request and one uses request (batches of 40 and 10).
    expect(seen.filter((r) => r.query.includes("_id in")).length).toBe(1);
    expect(seen.filter((r) => r.query.includes("references(")).length).toBe(1);
  });

  it("is read-only and keeps the token out of every address, and nothing but the dataset's host is asked", async () => {
    const seen: SeenSanityRequest[] = [];
    await readSanityImages({
      page,
      env: ENV,
      fetcher: world({ ...HARBOUR, token: TOKEN }, seen),
      sleep: noWait,
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.method).toBe("GET");
      expect(r.url).not.toContain(TOKEN);
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(new URL(r.url).hostname).toBe(`${HARBOUR_PROJECT}.api.sanity.io`);
      expect(new URL(r.url).searchParams.get("perspective")).toBe("published");
    }
  });

  it("asks in batches of at most 40 sizes and 10 uses, and reads at most 100 uploads", async () => {
    const hashes = Array.from({ length: 125 }, (_, i) =>
      `a${String(i).padStart(3, "0")}`.padEnd(40, "c"),
    );
    const many = pageOf(
      ...hashes.map(
        (h) => `https://cdn.sanity.io/images/${HARBOUR_PROJECT}/production/${h}-800x600.jpg?w=400`,
      ),
    );
    const seen: SeenSanityRequest[] = [];
    const read = await readSanityImages({
      page: many,
      env: ENV,
      fetcher: world(HARBOUR, seen),
      sleep: noWait,
    });
    expect(read.assets.size).toBe(SANITY_ASSET_CAP);
    expect(read.skipped).toBe(25);
    expect(seen.filter((r) => r.query.includes("_id in")).length).toBe(
      Math.ceil(SANITY_ASSET_CAP / SIZE_BATCH),
    );
    expect(seen.filter((r) => r.query.includes("references(")).length).toBe(
      Math.ceil(SANITY_ASSET_CAP / USES_BATCH),
    );
    for (const r of seen) expect(r.url.length).toBeLessThan(8000);
  });

  it("an upload used in more documents than one run reads is could-not-check, never a partial answer", async () => {
    const content = harbourContent();
    content.extra = Array.from({ length: 40 }, (_, i) => ({
      _id: `extra-${i}`,
      _type: "event",
      photo: { asset: { _ref: harbourAssetId("logo") }, alt: "x" },
    }));
    const read = await readSanityImages({
      page: pageOf(harbourUrl("logo", "?w=200"), harbourUrl("menu", "?w=200")),
      env: ENV,
      fetcher: world({ types: {}, content }),
      sleep: noWait,
    });
    expect(read.assets.get(harbourAssetId("logo"))?.uses).toBeUndefined();
    expect(read.assets.get(harbourAssetId("logo"))?.usesProblem).toMatch(/more than 30 documents/);
    // The size read is unaffected.
    expect(read.assets.get(harbourAssetId("logo"))?.size).toBe(40_000);
  });

  it("no project id, a malformed one or no Sanity image on the page: a problem or an empty read, never a throw", async () => {
    const none = await readSanityImages({ page, env: {}, fetcher: world(), sleep: noWait });
    expect(none.problem).toMatch(/SANITY_PROJECT_ID is not set/);
    const bad = await readSanityImages({
      page,
      env: { SANITY_PROJECT_ID: "Bad Id!" },
      fetcher: world(),
      sleep: noWait,
    });
    expect(bad.problem).toMatch(/not a Sanity project id/);
    const seen: SeenSanityRequest[] = [];
    const empty = await readSanityImages({
      page: pageOf("https://other.example/a.jpg"),
      env: ENV,
      fetcher: world(HARBOUR, seen),
      sleep: noWait,
    });
    expect(empty.problem).toBeUndefined();
    expect(empty.assets.size).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("a dataset set to another name than the page's images is listed as foreign, not asked", async () => {
    const seen: SeenSanityRequest[] = [];
    const read = await readSanityImages({
      page,
      env: { ...ENV, SANITY_DATASET: "staging" },
      fetcher: world(HARBOUR, seen),
      sleep: noWait,
    });
    expect(read.assets.size).toBe(0);
    expect(read.foreign.length).toBe(8);
    expect(seen).toHaveLength(0);
  });

  it("a refused token stops the read with the Viewer-role hint and never repeats the token", async () => {
    const seen: SeenSanityRequest[] = [];
    const read = await readSanityImages({
      page,
      env: { ...ENV, SANITY_TOKEN: `${TOKEN}-wrong` },
      fetcher: world({ ...HARBOUR, token: TOKEN }, seen),
      sleep: noWait,
    });
    expect(read.problem).toMatch(/Viewer role/);
    expect(JSON.stringify([...read.assets])).not.toContain("-wrong");
    expect(read.problem).not.toContain(TOKEN);
    // The first refusal stops it: one request, not one per batch.
    expect(seen).toHaveLength(1);
  });

  it("a query Sanity rejects (HTTP 400) is a reason on the affected uploads, and the other part still reads", async () => {
    const dataset = sanityCountsTransport(HARBOUR);
    const fetcher = createFetcher({
      transport: (url, req) =>
        (url.searchParams.get("query") ?? "").includes("references(")
          ? dataset(new URL(`${url.origin}/v2021-06-07/data/query/production?query=%7B`), req)
          : dataset(url, req),
    });
    const read = await readSanityImages({ page, env: ENV, fetcher, sleep: noWait });
    const logo = read.assets.get(harbourAssetId("logo"));
    expect(logo?.size).toBe(40_000);
    expect(logo?.uses).toBeUndefined();
    expect(logo?.usesProblem).toMatch(/could not run the query/);
  });
});
