import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFetcher } from "@gaugeline/core";
import { sanityCountsTransport, type SeenSanityRequest } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import {
  createContent,
  defaultFetcher,
  hasHiddenCharacter,
  MAX_REQUESTS,
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
const TOKEN = ["sk", "viewer", "fernhill", "0042"].join("");
const ENV = { SANITY_PROJECT_ID: "fernhill1", SANITY_DATASET: "production", SANITY_TOKEN: TOKEN };
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

  it("keeps a path, and an absolute address only on the site's own origin or an allowed one", () => {
    const base = { baseURL: "https://shop.example" };
    expect(resolveUrl({ _id: "a", url: "/p/1?x=2" }, "product", base)).toEqual({ url: "/p/1?x=2" });
    // Same origin: handed back as a path, never as the raw string.
    expect(resolveUrl({ _id: "a", url: "https://shop.example/p/1#top" }, "product", base)).toEqual({
      url: "/p/1",
    });
    expect(resolveUrl({ _id: "a", url: "HTTPS://SHOP.EXAMPLE/p/1" }, "product", base)).toEqual({
      url: "/p/1",
    });
    // Another origin only when it is listed.
    const other = { _id: "a", url: "https://cdn.shop.example/p/1" };
    expect(resolveUrl(other, "product", base)).toMatchObject({ reason: expect.any(String) });
    expect(
      resolveUrl(other, "product", { ...base, allowedOrigins: ["https://cdn.shop.example"] }),
    ).toEqual({ url: "https://cdn.shop.example/p/1" });
  });

  it("refuses private, loopback, link-local and metadata addresses even when their origin is allowed, unless allowPrivate is set", () => {
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
    ]) {
      const allowedOrigins = [new URL(url).origin];
      expect(resolveUrl({ _id: "a", url }, "product", { allowedOrigins })).toMatchObject({
        reason: expect.stringContaining("private"),
      });
      expect(
        resolveUrl({ _id: "a", url }, "product", { allowedOrigins, allowPrivate: true }),
      ).toEqual({ url: new URL(url).href });
    }
  });
});

/** Built at run time: an address with user info is not stored as one piece. */
const AT = "@";

describe("resolveUrl: content is data, so a document cannot send the browser elsewhere", () => {
  const base = { baseURL: "https://shop.example" };
  const refused = (url: string, extra: Record<string, unknown> = {}) =>
    resolveUrl({ _id: "a", url }, "product", { ...base, ...extra });

  it.each([
    ["another site", "https://evil.example/x"],
    ["an upper-case scheme", "HTTPS://evil.example"],
    ["user info", ["http://user", "evil.example"].join(AT)],
    ["user info that names the real host", ["https://shop.example", "evil.example/"].join(AT)],
    ["a protocol-relative address", "//evil.example"],
    ["a backslash that the parser reads as a slash", "/\\evil.example"],
    ["a tab inside the slashes", "/\t/evil.example"],
    ["a newline inside the slashes", "/\n/evil.example"],
    ["a carriage return", "/\r/evil.example"],
    ["a C1 control character", "/\u0085/evil.example"],
    ["a null byte", "/a\u0000b"],
    ["a backslash anywhere", "/a\\b"],
    ["a cloud metadata name", "http://metadata.google.internal/"],
    ["a javascript address", "javascript:alert(1)"],
    ["a data address", "data:text/html,x"],
    ["a file address", "file:///etc/hosts"],
    ["a path that changes when normalised (dot segments)", "/a/../../b"],
    ["a path that changes when normalised (a space)", "/a b"],
    ["a relative path", "products/x"],
  ])("refuses %s", (_name, url) => {
    expect(refused(url)).toMatchObject({ reason: expect.any(String) });
  });

  it("refuses a user-info and a private-name address on an allowed origin too", () => {
    expect(
      refused(["http://user", "cdn.shop.example/x"].join(AT), {
        allowedOrigins: ["http://cdn.shop.example"],
      }),
    ).toMatchObject({ reason: expect.stringContaining("user") });
    expect(
      refused("http://metadata.google.internal/", {
        allowedOrigins: ["http://metadata.google.internal"],
      }),
    ).toMatchObject({ reason: expect.stringContaining("private") });
  });

  it("keeps an encoded slash or backslash as text: it opens a path on the same site", () => {
    for (const path of ["/%2f%2fevil.example", "/%5cevil.example", "/a%2Fb"]) {
      const got = refused(path);
      expect(got).toEqual({ url: path });
      expect(new URL((got as { url: string }).url, base.baseURL).origin).toBe(base.baseURL);
    }
  });

  it("with no baseURL only paths are accepted, and a path never leaves the site", () => {
    expect(resolveUrl({ _id: "a", url: "/p" }, "product", {})).toEqual({ url: "/p" });
    expect(resolveUrl({ _id: "a", url: "https://shop.example/p" }, "product", {})).toMatchObject({
      reason: expect.any(String),
    });
    expect(resolveUrl({ _id: "a", url: "/\\evil.example" }, "product", {})).toMatchObject({
      reason: expect.any(String),
    });
  });

  it("a route's slug is encoded, so a slug cannot add a path segment or a host", () => {
    const routes = { product: "/products/{slug}" };
    expect(resolveUrl({ _id: "a", slug: "../../x" }, "product", { ...base, routes })).toEqual({
      url: "/products/..%2F..%2Fx",
    });
    expect(resolveUrl({ _id: "a", slug: ".." }, "product", { ...base, routes })).toMatchObject({
      reason: expect.any(String),
    });
    expect(resolveUrl({ _id: "a", slug: "a/b" }, "product", { ...base, routes })).toEqual({
      url: "/products/a%2Fb",
    });
    expect(
      resolveUrl({ _id: "a", slug: "//evil.example" }, "product", { ...base, routes }),
    ).toEqual({ url: "/products/%2F%2Fevil.example" });
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
      fetcher.get("https://fernhill1.api.sanity.io/v2021-10-21/data/query/production?query=1"),
    ).rejects.toThrow(/loopback|private/i);
  });
});

/** A reader over a made-up list of documents of one type, in _id order, answering the walk's two question shapes. */
function listReader(ids: () => Iterable<string>, seen: { requests: number }) {
  return (groq: string): Promise<unknown> => {
    seen.requests++;
    const after = /_id > "([^"]*)"/.exec(groq)?.[1] ?? "";
    const size = Number(/\[0\.\.\.(\d+)\]/.exec(groq)?.[1] ?? "100");
    const wanted = /_id in \[([^\]]*)\]/.exec(groq)?.[1];
    const all = [...ids()];
    if (wanted !== undefined) {
      const set = new Set((JSON.parse(`[${wanted}]`) as string[]) ?? []);
      return Promise.resolve(
        all.filter((id) => set.has(id)).map((_id) => ({ _id, _type: "post", url: `/p/${_id}` })),
      );
    }
    return Promise.resolve(
      all
        .filter((id) => id > after)
        .slice(0, size)
        .map((_id) => ({ _id, _type: "post", url: `/p/${_id}` })),
    );
  };
}

const quiet = { annotate: () => undefined, env: {} };

describe("a reader that never ends cannot loop forever: requests, documents and ids are capped", () => {
  it("stops with a clear error when a page repeats and the cursor does not move forward", async () => {
    const seen = { requests: 0 };
    const stuck = () => {
      seen.requests++;
      return Promise.resolve([
        { _id: "post-1", url: "/p/1" },
        { _id: "post-2", url: "/p/2" },
      ]);
    };
    const content = createContent({ read: stuck, pageSize: 2 }, quiet);
    await expect(collect(content.published("post"))).rejects.toThrow(/did not move forward/);
    expect(seen.requests).toBeLessThan(5);
  });

  it("stops when the cursor goes backwards", async () => {
    let n = 0;
    const content = createContent(
      {
        read: () =>
          Promise.resolve(
            n++ === 0
              ? [
                  { _id: "b", url: "/b" },
                  { _id: "c", url: "/c" },
                ]
              : [
                  { _id: "a", url: "/a" },
                  { _id: "b", url: "/b" },
                ],
          ),
        pageSize: 2,
      },
      quiet,
    );
    await expect(collect(content.published("post"))).rejects.toThrow(/did not move forward/);
  });

  it("stops at the document cap, saying what to do, and never asks for more than the cap allows", async () => {
    const seen = { requests: 0 };
    // An endless list, a page at a time: the reader hands out only what was asked for.
    const read = (groq: string) => {
      seen.requests++;
      const size = Number(/\[0\.\.\.(\d+)\]/.exec(groq)?.[1]);
      const start = Number(/_id > "post-(\d+)"/.exec(groq)?.[1] ?? "-1") + 1;
      return Promise.resolve(
        Array.from({ length: size }, (_, i) => ({
          _id: `post-${String(start + i).padStart(9, "0")}`,
          url: "/p",
        })),
      );
    };
    const content = createContent({ read, maxDocuments: 250, pageSize: 100 }, quiet);
    let got = 0;
    await expect(
      (async () => {
        for await (const doc of content.published("post")) got += doc._id === "" ? 0 : 1;
      })(),
    ).rejects.toThrow(/more than 250 .*sample/s);
    expect(got).toBe(250);
    expect(seen.requests).toBeLessThanOrEqual(4);
  });

  it("stops at the request cap when a reader answers with ever-new ids in tiny pages", async () => {
    const seen = { requests: 0 };
    const read = () => {
      const i = seen.requests++;
      return Promise.resolve([{ _id: `post-${String(i).padStart(9, "0")}`, url: "/p" }]);
    };
    const content = createContent({ read, pageSize: 1, maxDocuments: 50_000 }, quiet);
    await expect(collect(content.published("post"))).rejects.toThrow(/more than \d+ requests/);
    expect(seen.requests).toBeLessThanOrEqual(MAX_REQUESTS + 1);
  });

  it("a sample stops collecting ids at the cap instead of holding millions in memory", async () => {
    const seen = { requests: 0 };
    const read = (groq: string) => {
      const size = Number(/\[0\.\.\.(\d+)\]/.exec(groq)?.[1]);
      const start = seen.requests++ * size;
      return Promise.resolve(
        Array.from({ length: size }, (_, i) => ({
          _id: `post-${String(start + i).padStart(9, "0")}`,
        })),
      );
    };
    const content = createContent({ read }, quiet);
    await expect(collect(content.sample("post", 5))).rejects.toThrow(/more than 50,?000/);
    expect(seen.requests).toBeLessThanOrEqual(60);
  });

  it("a sample's own requests are capped too, and n is held to the document cap", async () => {
    const seen = { requests: 0 };
    const ids = Array.from({ length: 30 }, (_, i) => `post-${String(i).padStart(3, "0")}`);
    const content = createContent({ read: listReader(() => ids, seen), maxDocuments: 10 }, quiet);
    const got = await collect(content.sample("post", 1000));
    expect(got).toHaveLength(10);
  });

  it("a reader that behaves is not affected: a long list under the caps is read to the end", async () => {
    const seen = { requests: 0 };
    const ids = Array.from({ length: 450 }, (_, i) => `post-${String(i).padStart(4, "0")}`);
    const content = createContent({ read: listReader(() => ids, seen), pageSize: 100 }, quiet);
    expect(await collect(content.published("post"))).toHaveLength(450);
    expect(seen.requests).toBe(5);
  });

  it("refuses an option that would defeat the caps", () => {
    const read = () => Promise.resolve([]);
    expect(() => createContent({ read, maxDocuments: 0 }, quiet)).toThrow(RangeError);
    expect(() => createContent({ read, maxDocuments: 1_000_000 }, quiet)).toThrow(/50,?000/);
    expect(() => createContent({ read, pageSize: 0 }, quiet)).toThrow(RangeError);
    expect(() => createContent({ read, pageSize: 5000 }, quiet)).toThrow(RangeError);
    expect(() => createContent({ read, pageSize: 1.5 }, quiet)).toThrow(RangeError);
  });
});

describe("ids from content are data: drafts are skipped and the annotation is clean", () => {
  it("skips drafts. and versions. ids from any reader, and does not count them as documents", async () => {
    const docs = [
      { _id: "drafts.a", url: "/a" },
      { _id: "post-1", url: "/p/1" },
      { _id: "versions.r1.post-2", url: "/p/2" },
      { _id: "post-3", url: "/p/3" },
    ];
    const content = createContent({ read: () => Promise.resolve(docs), pageSize: 100 }, quiet);
    expect((await collect(content.published("post"))).map((d) => d._id)).toEqual([
      "post-1",
      "post-3",
    ]);
  });

  it("a page that holds only drafts does not end the walk early", async () => {
    const pages = [[{ _id: "drafts.a" }, { _id: "drafts.b" }], [{ _id: "post-1", url: "/p/1" }]];
    let n = 0;
    const content = createContent(
      { read: () => Promise.resolve(pages[n++] ?? []), pageSize: 2 },
      quiet,
    );
    expect((await collect(content.published("post"))).map((d) => d._id)).toEqual(["post-1"]);
  });

  it("strips control characters and cuts a long id before it reaches the report", async () => {
    const annotations: string[] = [];
    const hostile = `x\u001b[31m\n${"y".repeat(500)}`;
    const content = createContent(
      { read: () => Promise.resolve([{ _id: hostile }, { _id: "post-ok", url: "/p" }]) },
      { annotate: (t, d) => annotations.push(`${t}: ${d}`), env: {} },
    );
    await collect(content.published("post"));
    expect(annotations).toHaveLength(1);
    const line = annotations[0] ?? "";
    expect([...line].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(false);
    expect(line.length).toBeLessThan(400);
    expect(content.skipped[0]?.id.length).toBeLessThan(200);
  });
});

describe("hasHiddenCharacter", () => {
  it("is true for a backslash and for every control character a URL parser strips or rewrites", () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x85, 0x9f])
      expect(hasHiddenCharacter(`/a${String.fromCharCode(code)}b`)).toBe(true);
    expect(hasHiddenCharacter("/a\\b")).toBe(true);
  });

  it("is false for ordinary paths, addresses and letters of any script", () => {
    for (const text of [
      "/products/ember",
      "https://shop.example/p?x=1#y",
      "/caf%C3%A9",
      "/\u00e9",
      "/\u4e2d",
    ])
      expect(hasHiddenCharacter(text)).toBe(false);
  });

  it("is what turns such an address away, with its own reason", () => {
    for (const url of ["/\\evil.example", "/\t/evil.example", "/a\u0085b"])
      expect(resolveUrl({ _id: "a", url }, "product", { baseURL: "https://shop.example" })).toEqual(
        { reason: expect.stringContaining("backslash or a control character") },
      );
  });
});

describe("a sample's request caps are sized for the sample", () => {
  const idsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => `post-${String(i).padStart(6, "0")}`);

  it("draws 10,000 of 50,000 documents: 50 id requests and 250 fetches, more than the cap together, and it works", async () => {
    const seen = { requests: 0 };
    const ids = idsOf(50_000);
    const content = createContent({ read: listReader(() => ids, seen) }, quiet);
    const got = await collect(content.sample("post", 10_000));
    expect(got).toHaveLength(10_000);
    expect(seen.requests).toBeGreaterThan(MAX_REQUESTS);
  }, 60_000);

  it("a reader that hides ever-new drafts in full pages stops with a message that is not about sampling", async () => {
    let i = 0;
    const read = () =>
      Promise.resolve(
        Array.from({ length: 1000 }, () => ({ _id: `drafts.d-${String(i++).padStart(9, "0")}` })),
      );
    const content = createContent({ read }, quiet);
    const err = (await collect(content.sample("post", 5)).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Stopped after 300 requests/);
    expect(err.message).not.toMatch(/Use content\.sample/);
  });

  it("published still tells a user with a huge type to use sample", async () => {
    let i = 0;
    const read = () =>
      Promise.resolve([{ _id: `post-${String(i++).padStart(9, "0")}`, url: "/p" }]);
    const content = createContent({ read, pageSize: 1, maxDocuments: 50_000 }, quiet);
    await expect(collect(content.published("post"))).rejects.toThrow(/Use content\.sample/);
  });
});
