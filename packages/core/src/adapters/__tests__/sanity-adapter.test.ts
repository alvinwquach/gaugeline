import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { ConnectorRateLimitedError } from "../../connectors/http.js";
import { createSanityRead } from "../../connectors/sanity.js";
import { ConfigError } from "../../errors.js";
import { adapterHeader, collectPublished, describePartial } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { fillUrlTemplate, hashValue, isUrlTemplate } from "../fingerprint.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapters } from "../registry.js";
import { createSanityAdapter } from "../sanity.js";
import { AdapterCouldNotCheck } from "../types.js";
import { rateLimited, recording, requestProblems, type Seen } from "./contract.js";
import { CONTENT_MARKERS, FERNHILL, sanityTransport } from "./sanity-fixture.js";

const ENV = { SANITY_PROJECT_ID: "fern8hl1", SANITY_DATASET: "production" };

function adapterOver(
  content = FERNHILL,
  extra: Partial<Parameters<typeof createSanityAdapter>[0]> = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(sanityTransport(content), seen),
    timeoutMs: 5000,
  });
  const adapter = createSanityAdapter({
    env: ENV,
    fetcher,
    sleep: () => Promise.resolve(),
    ...extra,
  });
  return { adapter, seen };
}

describe("Sanity on ContentAdapter: unit", () => {
  it("asks for a read-only (Viewer) token and says where to read how", () => {
    const { adapter } = adapterOver();
    expect(adapter.describe()).toEqual({
      name: "Sanity",
      docsUrl: "https://gaugeline.dev/docs/private-datasets",
      keyKind: "read-only",
    });
    expect(adapterHeader(adapter.describe())).toBe(
      "Content system: Sanity, with a read-only key. Endpoints and how to make the key: https://gaugeline.dev/docs/private-datasets",
    );
  });

  it("fieldCounts counts a system field as every document and a nested path by its parent", async () => {
    const { adapter } = adapterOver();
    expect(
      await adapter.fieldCounts("post", ["_id", "_updatedAt", "slug.current", "title"]),
    ).toEqual({
      _id: 3,
      _updatedAt: 3,
      "slug.current": 3,
      title: 3,
    });
  });

  it("published() pages through a type by id and stops at the limit", async () => {
    const { adapter, seen } = adapterOver(FERNHILL, { pageSize: 1 });
    const all = await collectPublished(adapter, { types: ["post"] });
    expect(all.docs.map((d) => d.id)).toEqual(["post-faq", "post-spring", "post-welcome"]);
    // One request per item, and one more that comes back empty because the last page was full.
    expect(seen.length).toBe(4);
    const two = await collectPublished(adapterOver(FERNHILL, { pageSize: 1 }).adapter, {
      types: ["post"],
      limit: 2,
    });
    expect(two.docs.map((d) => d.id)).toEqual(["post-faq", "post-spring"]);
  });

  it("published() with `since` leaves out what has not changed", async () => {
    const { adapter } = adapterOver();
    const got = await collectPublished(adapter, { types: ["post"], since: "2026-10-01T00:00:00Z" });
    expect(got.docs.map((d) => d.id)).toEqual(["post-spring", "post-welcome"]);
    await expect(collectPublished(adapter, { since: "last week" })).rejects.toThrow(TypeError);
  });

  it("published() gives slug, publish time and update time as ISO strings, and omits what is absent", async () => {
    const { adapter } = adapterOver();
    const docs = (await collectPublished(adapter, { types: ["post"] })).docs;
    const faq = docs.find((d) => d.id === "post-faq");
    expect(faq).toEqual({
      id: "post-faq",
      type: "post",
      slug: "faq",
      updatedAt: "2026-08-12T10:00:00.000Z",
      fieldHashes: {},
    });
    expect(docs.find((d) => d.id === "post-welcome")?.publishedAt).toBe("2026-09-01T08:00:00.000Z");
  });

  it("published() reads no draft, and without settings asks for no field value", async () => {
    const { adapter, seen } = adapterOver();
    const got = await collectPublished(adapter);
    expect(got.docs.some((d) => d.id.startsWith("drafts."))).toBe(false);
    for (const s of seen) expect(new URL(s.url).searchParams.get("perspective")).toBe("published");
  });

  it("the settings name the fields to hash and where each type lives", async () => {
    const { adapter } = adapterOver(FERNHILL, {
      settings: {
        id: "sanity",
        fingerprint: { post: ["title"] },
        urls: { post: "/blog/{slug}", package: "https://fernhill.example/work-with-me/{slug}" },
      },
    });
    const docs = (await collectPublished(adapter, { types: ["post", "package"] })).docs;
    const welcome = docs.find((d) => d.id === "post-welcome");
    expect(welcome?.url).toBe("/blog/finding-your-next-step");
    expect(welcome?.fieldHashes).toEqual({ title: hashValue(CONTENT_MARKERS.welcome) });
    expect(docs.find((d) => d.id === "package-group")?.url).toBe(
      "https://fernhill.example/work-with-me/group-programme",
    );
    expect(adapter.resolveUrl?.({ id: "x", type: "post", slug: "a b" })).toBe("/blog/a%20b");
    expect(adapter.resolveUrl?.({ id: "x", type: "post" })).toBe("");
    expect(adapter.resolveUrl?.({ id: "x", type: "testimonial", slug: "a" })).toBe("");
  });

  it("an edit to a field changes its hash and nothing else's", async () => {
    const edited = FERNHILL.map((d) =>
      d._id === "post-welcome" ? { ...d, title: "A new headline" } : d,
    );
    const settings = { id: "sanity", fingerprint: { post: ["title", "summary"] } };
    const before = (
      await collectPublished(adapterOver(FERNHILL, { settings }).adapter, { types: ["post"] })
    ).docs;
    const after = (
      await collectPublished(adapterOver(edited, { settings }).adapter, { types: ["post"] })
    ).docs;
    const pick = (docs: typeof before) => docs.find((d) => d.id === "post-welcome")?.fieldHashes;
    expect(pick(after)?.title).not.toBe(pick(before)?.title);
    expect(pick(after)?.summary).toBe(pick(before)?.summary);
  });

  it("draftsReachable is false when the key sees no draft", async () => {
    const published = FERNHILL.filter((d) => !String(d._id).startsWith("drafts."));
    expect(await adapterOver(published).adapter.draftsReachable()).toBe(false);
    expect(await adapterOver().adapter.draftsReachable()).toBe(true);
  });

  it("draftsReachable asks for a count of drafts, not for a draft", async () => {
    const { adapter, seen } = adapterOver();
    await adapter.draftsReachable();
    expect(decodeURIComponent(seen[0]?.url ?? "")).toContain('count(*[_id in path("drafts.**")])');
    expect(new URL(seen[0]?.url ?? "").searchParams.get("perspective")).toBe("raw");
  });

  it("no project id is could-not-check with the variable named, before any request", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(sanityTransport(), seen),
      timeoutMs: 5000,
    });
    const adapter = createSanityAdapter({ env: {}, fetcher });
    const err = await adapter.types().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain("SANITY_PROJECT_ID");
    expect(seen).toEqual([]);
  });

  it("members() without a token says so instead of asking", async () => {
    const { adapter, seen } = adapterOver();
    const err = await adapter.members?.().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain("SANITY_TOKEN");
    expect(requestProblems(seen)).toEqual([]);
  });
});

describe("the Sanity reader behind it keeps its old behaviour", () => {
  it("without a sleep, a 429 is thrown at once, as before", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(rateLimited(sanityTransport(), { after: 0, times: 5 }), seen),
      timeoutMs: 5000,
    });
    const read = createSanityRead(ENV, fetcher);
    await expect(read.query("count(*)")).rejects.toBeInstanceOf(ConnectorRateLimitedError);
    expect(seen).toHaveLength(1);
  });
});

describe("collect: unit", () => {
  it("describePartial says how many were read and what to do", () => {
    expect(describePartial({ reason: "rate-limited", delivered: 1, retry: "in 120 seconds" })).toBe(
      "Read 1 item, then the platform asked Gaugeline to slow down. Try again in 120 seconds. The rest was not read, so what is listed is not everything.",
    );
    expect(describePartial({ reason: "rate-limited", delivered: 0 })).toContain("Read 0 items");
  });

  it("a failure that is not a rate limit is thrown, not turned into an empty list", async () => {
    const { adapter } = adapterOver(FERNHILL, { env: {} });
    await expect(collectPublished(adapter)).rejects.toBeInstanceOf(AdapterCouldNotCheck);
  });
});

describe("fingerprints: unit", () => {
  it("equal values hash alike whatever their key order, different values differ", () => {
    expect(hashValue({ a: 1, b: [1, 2] })).toBe(hashValue({ b: [1, 2], a: 1 }));
    expect(hashValue("a")).not.toBe(hashValue("b"));
    expect(hashValue("1")).not.toBe(hashValue(1));
    expect(hashValue("a")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("no value is no hash, and an empty string is a value", () => {
    expect(hashValue(null)).toBeUndefined();
    expect(hashValue(undefined)).toBeUndefined();
    expect(hashValue("")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("url templates take a path or an https address and only {slug} and {id}", () => {
    expect(isUrlTemplate("/blog/{slug}")).toBe(true);
    expect(isUrlTemplate("https://fernhill.example/{id}/{slug}")).toBe(true);
    for (const bad of [
      "blog/{slug}",
      "http://x.example/{slug}",
      "/a/{title}",
      "/a b",
      "/a/{slug",
      "javascript:{slug}",
    ])
      expect(isUrlTemplate(bad)).toBe(false);
    expect(fillUrlTemplate("/blog/{slug}", { id: "i", slug: "a/b?c" })).toBe("/blog/a%2Fb%3Fc");
    expect(fillUrlTemplate("/id/{id}", { id: "x y" })).toBe("/id/x%20y");
    // A dot segment would make the address another page ("/blog/.." is "/"), so it is no address at all.
    expect(fillUrlTemplate("/blog/{slug}", { id: "i", slug: ".." })).toBe("");
    expect(fillUrlTemplate("/blog/{slug}", { id: "i", slug: "." })).toBe("");
    expect(fillUrlTemplate("/blog/{slug}", { id: "i", slug: "..." })).toBe("/blog/...");
  });
});

describe("the adapters entry in gaugeline.adapters.json: unit", () => {
  const ok = {
    adapters: [
      {
        id: "sanity",
        fingerprint: { post: ["title", "slug.current"] },
        urls: { post: "/blog/{slug}" },
      },
    ],
  };

  it("accepts an id with fields to hash and where items live", () => {
    expect(adaptersConfigSchema.parse(ok)).toEqual(ok);
    expect(adaptersConfigSchema.parse({ adapters: [{ id: "sanity" }] })).toEqual({
      adapters: [{ id: "sanity" }],
    });
  });

  it("refuses what could carry a query or a key", () => {
    const bad = [
      { adapters: [] },
      { adapters: [{ id: "Sanity" }] },
      { adapters: [{ id: "sanity", token: "x" }] },
      { adapters: [{ id: "sanity", fingerprint: { post: ["title) || true"] } }] },
      { adapters: [{ id: "sanity", fingerprint: { post: [] } }] },
      { adapters: [{ id: "sanity", urls: { post: "javascript:alert(1)" } }] },
      { adapters: [{ id: "sanity" }], extra: true },
    ];
    for (const b of bad) expect(adaptersConfigSchema.safeParse(b).success).toBe(false);
  });

  it("createAdapters builds Sanity and refuses a planned or unknown id with a hint", async () => {
    const fetcher = createFetcher({ transport: sanityTransport(), timeoutMs: 5000 });
    const [built] = await createAdapters(adaptersConfigSchema.parse(ok), { env: ENV, fetcher });
    expect(built?.id).toBe("sanity");
    // Which adapters are planned changes with every merge (none may be left): test the first one if there is one.
    const planned = PLANNED_ADAPTERS[0];
    if (planned)
      await expect(
        createAdapters({ adapters: [{ id: planned.id }] }, { env: ENV, fetcher }),
      ).rejects.toThrow(new RegExp(`"${planned.id}" adapter is planned \\(${planned.branch}\\)`));
    await expect(
      createAdapters({ adapters: [{ id: "nope" }] }, { env: ENV, fetcher }),
    ).rejects.toThrow(ConfigError);
  });

  it("no id is both built and planned", () => {
    for (const p of PLANNED_ADAPTERS) expect(BUILT_ADAPTERS.has(p.id)).toBe(false);
  });
});
