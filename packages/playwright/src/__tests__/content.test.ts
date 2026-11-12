import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFetcher } from "@gaugeline/core";
import { sanityCountsTransport, type SeenSanityRequest } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import {
  createContent,
  defaultFetcher,
  readerFromEnv,
  resolveUrl,
  type ContentOptions,
  type PublishedDoc,
} from "../content.js";

interface Dataset {
  documents: Record<string, unknown>[];
}
const DATASET = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/dataset.json", import.meta.url)), "utf8"),
) as Dataset;

// Built at run time: a token-shaped string must not sit in the repository as one piece.
const TOKEN = ["sk", "viewer", "tidewater", "0042"].join("");
const ENV = { SANITY_PROJECT_ID: "tidewater1", SANITY_DATASET: "production", SANITY_TOKEN: TOKEN };
const ROUTES = { product: "/products/{slug}" };
const ROUTES_OPT = { routes: ROUTES };
/** The products that have a page (the gift card has no slug and no address). */
const WITH_PAGES = DATASET.documents.filter((d) => d._id !== "p-gift");

interface Rig {
  seen: SeenSanityRequest[];
  annotations: string[];
  content: ReturnType<typeof createContent>;
}

/** Content over the invented dataset, read through the real Sanity reader and a stand-in network. */
function rig(options: ContentOptions = {}, documents = DATASET.documents): Rig {
  const seen: SeenSanityRequest[] = [];
  const annotations: string[] = [];
  const transport = sanityCountsTransport({ types: {}, content: { all: documents } }, seen);
  const read = readerFromEnv(ENV, createFetcher({ transport, timeoutMs: 5000 }));
  const content = createContent(
    { routes: ROUTES, seed: "fixed", read, ...options },
    { annotate: (type, description) => annotations.push(`${type}: ${description}`), env: {} },
  );
  return { seen, annotations, content };
}

async function collect(docs: AsyncIterable<PublishedDoc>): Promise<PublishedDoc[]> {
  const out: PublishedDoc[] = [];
  for await (const doc of docs) out.push(doc);
  return out;
}

describe("resolveUrl: unit", () => {
  const doc = { _id: "a", slug: { current: "ember" } };
  it("prefers the url field, then a route built from the slug", () => {
    expect(resolveUrl({ ...doc, url: "/from-field" }, "product", {})).toEqual({
      url: "/from-field",
    });
    expect(resolveUrl(doc, "product", ROUTES_OPT)).toEqual({ url: "/products/ember" });
    expect(resolveUrl({ _id: "a", slug: "plain" }, "product", ROUTES_OPT)).toEqual({
      url: "/products/plain",
    });
  });

  it("keeps an absolute https address and a path as they are", () => {
    expect(resolveUrl({ _id: "a", url: "https://shop.example/p/1" }, "product", {})).toEqual({
      url: "https://shop.example/p/1",
    });
  });

  it("gives a reason, not an address, when nothing resolves", () => {
    expect(resolveUrl({ _id: "a" }, "product", {})).toMatchObject({ reason: expect.any(String) });
    expect(resolveUrl(doc, "page", ROUTES_OPT)).toMatchObject({ reason: expect.any(String) });
    expect(resolveUrl({ _id: "a", slug: { current: "" } }, "product", ROUTES_OPT)).toMatchObject({
      reason: expect.any(String),
    });
  });

  it("refuses addresses that are not a path or an http(s) address", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/hosts",
      "//other.example/x",
      "data:text/html,x",
      "products/relative",
      "",
    ])
      expect(resolveUrl({ _id: "a", url }, "product", {})).toMatchObject({
        reason: expect.any(String),
      });
  });

  it("refuses private, loopback, link-local and metadata addresses unless allowPrivate is set", () => {
    const local = ["local", "host"].join("");
    for (const url of [
      "http://127.0.0.1:3000/p",
      "http://[::1]/p",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.8/p",
      "http://192.168.1.20/p",
      "http://2130706433/p",
      `http://${local}:3000/p`,
      `http://shop.${local}/p`,
    ])
      expect(resolveUrl({ _id: "a", url }, "product", {})).toMatchObject({
        reason: expect.stringContaining("private"),
      });
    expect(
      resolveUrl({ _id: "a", url: "http://127.0.0.1:3000/p" }, "product", { allowPrivate: true }),
    ).toEqual({
      url: "http://127.0.0.1:3000/p",
    });
  });
});
describe("content.published: integration over recorded content", () => {
  it("yields { url, ...fields } for every published document of the type", async () => {
    const { content } = rig();
    const products = await collect(content.published("product"));
    expect(products.map((p) => p.url)).toEqual([
      "/products/ember-house-blend",
      "/products/paper-filters",
      "/products/harbour-decaf",
      "/products/gooseneck-kettle",
    ]); // in _id order, the order the pages are walked
    expect(products[0]).toMatchObject({ _id: "p-ember", checkoutPrice: "$14.00" });
  });

  it("never reads a draft: the draft price is not seen", async () => {
    const { content, seen } = rig();
    const products = await collect(content.published("product"));
    expect(JSON.stringify(products)).not.toContain("$99.00");
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(new URL(r.url).searchParams.get("perspective")).toBe("published");
  });

  it("only reads: every request is a GET, and the token travels in a header, never in an address", async () => {
    const { content, seen } = rig();
    await collect(content.published("product"));
    await collect(content.sample("product", 2));
    for (const r of seen) {
      expect(r.method).toBe("GET");
      expect(r.url).not.toContain(TOKEN);
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("pages through a type, so a long list is never one huge request", async () => {
    const { content, seen } = rig({ pageSize: 2 });
    const products = await collect(content.published("product"));
    expect(products).toHaveLength(4);
    expect(seen.length).toBe(3); // 2 + 2 + 1: a short page ends the walk
  });

  it("skips a document with no resolvable address, lists it, and tells the test about it", async () => {
    const { content, annotations } = rig();
    const products = await collect(content.published("product"));
    expect(products.map((p) => p._id)).not.toContain("p-gift");
    expect(content.skipped).toEqual([
      { id: "p-gift", type: "product", reason: expect.stringContaining("no url") },
    ]);
    expect(annotations).toEqual([expect.stringMatching(/^gaugeline-skipped: p-gift/)]);
  });
});

describe("content.sample: seeded", () => {
  it("returns the same documents for the same seed, in the same order", async () => {
    const a = await collect(rig({ seed: "release-7" }, WITH_PAGES).content.sample("product", 3));
    const b = await collect(rig({ seed: "release-7" }, WITH_PAGES).content.sample("product", 3));
    expect(a.map((d) => d._id)).toEqual(b.map((d) => d._id));
    expect(a).toHaveLength(3);
  });

  it("returns a different sample for a different seed", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const docs = await collect(rig({ seed: `s${i}` }, WITH_PAGES).content.sample("product", 2));
      seen.add(docs.map((d) => d._id).join());
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("takes the seed from GAUGELINE_SEED, then from the date, and writes it into the test report", async () => {
    const { annotations } = rig({ seed: undefined });
    const fromEnv = createContent(
      { read: () => Promise.resolve([]), routes: ROUTES },
      { annotate: (t, d) => annotations.push(`${t}: ${d}`), env: { GAUGELINE_SEED: "from-env" } },
    );
    expect(fromEnv.seed).toBe("from-env");
    const byDate = createContent(
      { read: () => Promise.resolve([]) },
      { annotate: () => undefined, env: {}, now: () => new Date("2026-11-12T08:00:00Z") },
    );
    expect(byDate.seed).toBe("2026-11-12");
  });

  it("records the seed as an annotation when a sample is drawn", async () => {
    const { content, annotations } = rig({ seed: "replay-me" }, WITH_PAGES);
    await collect(content.sample("product", 2));
    expect(annotations).toContain("gaugeline-seed: replay-me");
  });

  it("returns every document when n is larger than the type, and refuses a bad n", async () => {
    const { content } = rig({}, WITH_PAGES);
    expect((await collect(content.sample("product", 500))).length).toBe(4);
    await expect(collect(content.sample("product", 0))).rejects.toThrow(/whole number/);
  });
});

describe("loud failures: edge cases", () => {
  it("fails on zero documents of a type instead of passing an empty loop", async () => {
    const { content } = rig();
    await expect(collect(content.published("producct"))).rejects.toThrow(
      /No published "producct" documents/,
    );
    await expect(collect(content.sample("producct", 3))).rejects.toThrow(
      /No published "producct" documents/,
    );
  });

  it("says what to check when a type is empty: a renamed type, a draft-only type, a private dataset", async () => {
    const { content } = rig();
    const err = await collect(content.published("producct")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/renamed/);
    expect((err as Error).message).toMatch(/published/);
  });

  it("fails when documents exist but none has an address, naming how many were skipped", async () => {
    const { content } = rig({ routes: {} });
    await expect(collect(content.published("product"))).rejects.toThrow(/5 of 5 .* no address/s);
  });

  it("refuses a type name that is not a plain identifier, before any request", async () => {
    const { content, seen } = rig();
    await expect(collect(content.published('product"] | {"x'))).rejects.toThrow(/document type/);
    expect(seen).toHaveLength(0);
  });

  it("does not put the token in the error when Sanity refuses it", async () => {
    const seen: SeenSanityRequest[] = [];
    const transport = sanityCountsTransport(
      { types: {}, content: { all: [] }, token: "other" },
      seen,
    );
    const read = readerFromEnv(ENV, createFetcher({ transport, timeoutMs: 5000 }));
    const content = createContent({ read, routes: ROUTES }, { annotate: () => undefined, env: {} });
    const err = await collect(content.published("product")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Viewer|refused/i);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("a missing project id is a clear error, not a request", async () => {
    expect(() => readerFromEnv({}, createFetcher({ timeoutMs: 1000 }))).toThrow(
      /SANITY_PROJECT_ID is not set/,
    );
  });
});

describe("rule 6: the helper reads Sanity through the fetcher, which refuses private addresses", () => {
  it("the default fetcher refuses a Sanity host that resolves to a private address", async () => {
    const fetcher = defaultFetcher({
      resolver: () => Promise.resolve([{ address: "127.0.0.1", family: 4 as const }]),
    });
    await expect(
      fetcher.get("https://tidewater1.api.sanity.io/v2021-10-21/data/query/production?query=1"),
    ).rejects.toThrow(/loopback|private/i);
  });
});
