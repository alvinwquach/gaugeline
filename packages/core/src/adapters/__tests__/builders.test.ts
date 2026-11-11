import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import {
  BUILDERS,
  BUILDER_IDS,
  builderById,
  builderCannotRead,
  createBuilderAdapter,
  suggestBuilder,
} from "../builders.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapter, resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck } from "../types.js";
import {
  TIDEWATER,
  TIDEWATER_HOME,
  TIDEWATER_MARKERS,
  tidewaterRoutes,
  tidewaterServe,
  tidewaterWithout,
} from "./builders-fixture.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import { urlset, type Reply } from "./sitemap-feed-fixture.js";

function build(
  id: string,
  routes: Record<string, Reply> = tidewaterRoutes(),
  options: {
    site?: string | undefined;
    settings?: Parameters<typeof createBuilderAdapter>[1]["settings"];
  } = {},
) {
  const platform = builderById(id);
  if (platform === undefined) throw new Error(`no builder ${id}`);
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(tidewaterServe(routes), seen),
    timeoutMs: 5000,
  });
  const adapter = createBuilderAdapter(platform, {
    fetcher,
    site: "site" in options ? options.site : TIDEWATER,
    settings: options.settings,
    sleep: () => Promise.resolve(),
  });
  return { adapter, seen };
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

describe("the builder adapters describe themselves", () => {
  it("has one adapter id per platform, each built, none planned", () => {
    expect(BUILDER_IDS).toEqual([
      "squarespace",
      "duda",
      "tilda",
      "godaddy",
      "weebly",
      "carrd",
      "strikingly",
    ]);
    for (const b of BUILDERS) {
      expect(BUILT_ADAPTERS.get(b.id)?.describe.name).toBe(b.name);
      expect(PLANNED_ADAPTERS.some((p) => p.id === b.id)).toBe(false);
    }
    expect(PLANNED_ADAPTERS.some((p) => p.id === "builders")).toBe(false);
    expect(resolveAdapters({ adapters: [{ id: "squarespace" }] }).map((b) => b.id)).toEqual([
      "squarespace",
    ]);
  });

  it("each asks for no key, says so in the run header and links its own section", () => {
    for (const b of BUILDERS) {
      const d = build(b.id).adapter.describe();
      expect(d.noKey).toBe(true);
      expect(d.keyKind).toBe("read-only");
      expect(adapterHeader(d)).toBe(
        `Content system: ${b.name}, with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/builders#${b.anchor}`,
      );
    }
  });

  it("ids and anchors are unique and valid settings ids", () => {
    expect(new Set(BUILDER_IDS).size).toBe(BUILDERS.length);
    expect(new Set(BUILDERS.map((b) => b.anchor)).size).toBe(BUILDERS.length);
    for (const id of BUILDER_IDS)
      expect(adaptersConfigSchema.safeParse({ adapters: [{ id }] }).success).toBe(true);
  });
});

describe.each(BUILDERS.map((b) => b.id))("a healthy site on %s (sitemap)", (id) => {
  it("counts the groups of addresses the sitemap lists", async () => {
    expect(await build(id).adapter.types()).toEqual([
      { name: "blog", count: 1 },
      { name: "shop", count: 2 },
      { name: "top-level", count: 3 },
    ]);
  });

  it("gives each address with the date the sitemap gives, and no field hash", async () => {
    const { docs, partial } = await collectPublished(build(id).adapter, { types: ["shop"] });
    expect(partial).toBeUndefined();
    expect(docs).toEqual([
      {
        id: `${TIDEWATER}/shop/sea-glass-pendant`,
        type: "shop",
        url: `${TIDEWATER}/shop/sea-glass-pendant`,
        slug: "sea-glass-pendant",
        updatedAt: "2026-11-09T00:00:00.000Z",
        fieldHashes: {},
      },
      {
        id: `${TIDEWATER}/shop/driftwood-studs`,
        type: "shop",
        url: `${TIDEWATER}/shop/driftwood-studs`,
        slug: "driftwood-studs",
        updatedAt: "2026-10-12T00:00:00.000Z",
        fieldHashes: {},
      },
    ]);
  });

  it("fields are could-not-check with the platform's reason; drafts are not-applicable; asks for nothing", async () => {
    const { adapter, seen } = build(id);
    const reason = await reasonOf(adapter.fieldCounts("shop", ["title"]));
    const platform = builderById(id);
    expect(reason).toBe(builderCannotRead(platform ?? BUILDERS[0]!));
    expect(reason).toMatch(/^Not applicable/);
    expect(reason).toContain(platform?.name ?? "");
    expect(await adapter.draftsReachable()).toBe("not-applicable");
    expect(adapter.members).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("returns none of the site's text, and only ever sends GET or HEAD to the site", async () => {
    const { adapter, seen } = build(id);
    const text = JSON.stringify([await adapter.types(), (await collectPublished(adapter)).docs]);
    for (const marker of Object.values(TIDEWATER_MARKERS)) expect(text).not.toContain(marker);
    for (const s of seen) expect(new URL(s.url).host).toBe(new URL(TIDEWATER).host);
    expect(requestProblems(seen)).toEqual([]);
    // No page of the site is asked for besides the home page (for feed links): the sitemap is the list.
    expect(seen.some((s) => new URL(s.url).pathname.startsWith("/shop/"))).toBe(false);
  });
});

describe("a site with no sitemap or feed is could-not-check, never an empty list", () => {
  it.each(BUILDER_IDS)("%s: names where it looked", async (id) => {
    const { adapter } = build(id, tidewaterWithout("/sitemap.xml", "/robots.txt"));
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("No sitemap or feed could be read");
    expect(reason).toContain("/sitemap.xml");
    await expect(collectPublished(adapter)).rejects.toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("a sitemap behind a login (HTTP 403) is could-not-check with the status", async () => {
    const { adapter } = build("squarespace", {
      ...tidewaterRoutes(),
      "/sitemap.xml": { status: 403, body: "no" },
    });
    expect(await reasonOf(adapter.types())).toContain("403");
  });

  it("no site address is could-not-check in the platform's words, and nothing is requested", async () => {
    const { adapter, seen } = build("weebly", tidewaterRoutes(), { site: undefined });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("Weebly");
    expect(reason).toContain("weebly entry");
    expect(reason).not.toContain("sitemap-feed");
    await reasonOf(collectPublished(adapter));
    expect(seen).toEqual([]);
  });

  it("an address that is not a web address is could-not-check", async () => {
    const { adapter, seen } = build("carrd", tidewaterRoutes(), { site: "ftp://x.example" });
    await reasonOf(adapter.types());
    expect(seen).toEqual([]);
  });
});

describe("settings", () => {
  it("site, sitemaps and feeds are accepted for every builder, as for sitemap-feed", () => {
    for (const id of BUILDER_IDS) {
      const r = adaptersConfigSchema.safeParse({
        adapters: [
          { id, site: TIDEWATER, sitemaps: ["/sitemap.xml"], feeds: ["/blog?format=rss"] },
        ],
      });
      expect(r.success, id).toBe(true);
    }
  });

  it("fingerprint and urls are refused for every builder, naming it", () => {
    for (const id of BUILDER_IDS)
      for (const bad of [
        { fingerprint: { blog: ["title"] } },
        { urls: { blog: "/blog/{slug}" } },
      ]) {
        const r = adaptersConfigSchema.safeParse({ adapters: [{ id, ...bad }] });
        expect(r.success, id).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toContain(id);
      }
  });

  it("site is still refused for an adapter that does not read pages", () => {
    expect(
      adaptersConfigSchema.safeParse({ adapters: [{ id: "sanity", site: TIDEWATER }] }).success,
    ).toBe(false);
  });

  it("the settings entry's site wins, and sitemaps replace the guesses", async () => {
    const routes = {
      ...tidewaterWithout("/sitemap.xml", "/robots.txt"),
      "/pages-sitemap.xml": urlset([{ loc: `${TIDEWATER}/visit`, lastmod: "2026-11-08" }]),
    };
    const { adapter, seen } = build("squarespace", routes, {
      site: "https://elsewhere.example",
      settings: { id: "squarespace", site: TIDEWATER, sitemaps: ["/pages-sitemap.xml"] },
    });
    expect(await adapter.types()).toEqual([{ name: "top-level", count: 1 }]);
    expect(seen.some((s) => s.url.endsWith("/robots.txt"))).toBe(false);
  });
});

describe("no key is read, sent or logged", () => {
  it("a key in the environment reaches no request and no message", async () => {
    const key = testKey("builders");
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(tidewaterServe(tidewaterRoutes()), seen),
      timeoutMs: 5000,
    });
    const built = BUILT_ADAPTERS.get("squarespace");
    const adapter = built
      ? await createAdapter(
          built,
          {
            env: { SQUARESPACE_API_KEY: key, SQUARESPACE_TOKEN: key },
            fetcher,
            site: TIDEWATER,
            sleep: () => Promise.resolve(),
          },
          { id: "squarespace" },
        )
      : undefined;
    if (!adapter) throw new Error("not built");
    const out = [
      JSON.stringify(adapter.describe()),
      JSON.stringify(await adapter.types()),
      JSON.stringify((await collectPublished(adapter)).docs),
      await reasonOf(adapter.fieldCounts("shop", ["title"])),
    ].join("\n");
    expect(out).not.toContain(key);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(JSON.stringify(s)).not.toContain(key);
      const names = Object.keys(s.headers).map((h) => h.toLowerCase());
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("cookie");
    }
  });

  it("the adapter's source never looks at the environment or opens a socket", () => {
    const source = readFileSync(fileURLToPath(new URL("../builders.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\benv\b\s*[.[]/);
    expect(source).not.toMatch(/process\./);
    expect(source).not.toMatch(/\bWebSocket\(/);
    expect(source).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
  });
});

describe("suggestBuilder: a hint from the page's own markup, never a decision", () => {
  it("reads the generator tag", () => {
    expect(
      suggestBuilder(
        '<head><meta name="generator" content="Squarespace 7.1"></head>',
        `${TIDEWATER}/`,
      ),
    ).toEqual({ id: "squarespace", name: "Squarespace", evidence: "generator tag" });
    expect(
      suggestBuilder(
        '<meta content="Go Daddy Website Builder 8.0" name="Generator">',
        `${TIDEWATER}/`,
      )?.id,
    ).toBe("godaddy");
  });

  it("reads the hosts a page's scripts, styles and images come from", () => {
    const cases: [string, string][] = [
      ['<script src="https://static.tildacdn.com/js/tilda.js"></script>', "tilda"],
      ['<img src="https://irp.cdn-website.com/abc/x.jpg">', "duda"],
      ['<link rel="stylesheet" href="https://cdn2.editmysite.com/css/x.css">', "weebly"],
      ['<img src="//static-assets.strikinglycdn.com/x.png">', "strikingly"],
      ['<script src="https://img1.wsimg.com/x.js"></script>', "godaddy"],
      ['<script src="https://static1.squarespace.com/x.js"></script>', "squarespace"],
    ];
    for (const [html, id] of cases) expect(suggestBuilder(html, `${TIDEWATER}/`)?.id, id).toBe(id);
  });

  it("is the same answer every time, and finds the Tidewater home page", () => {
    const first = suggestBuilder(TIDEWATER_HOME, `${TIDEWATER}/`);
    expect(first).toEqual({ id: "squarespace", name: "Squarespace", evidence: "generator tag" });
    expect(suggestBuilder(TIDEWATER_HOME, `${TIDEWATER}/`)).toEqual(first);
  });

  it("a link or a word in the text is not a sign, and a page with no sign gives nothing", () => {
    expect(
      suggestBuilder(
        '<a href="https://www.squarespace.com/">Built with Squarespace</a><link rel="canonical" href="https://static1.squarespace.com/x"><p>Tilda static.tildacdn.com</p>',
        `${TIDEWATER}/`,
      ),
    ).toBeUndefined();
    expect(suggestBuilder("<html></html>", `${TIDEWATER}/`)).toBeUndefined();
  });

  it("a look-alike host is not a sign", () => {
    expect(
      suggestBuilder('<script src="https://notsquarespace.com/x.js"></script>', `${TIDEWATER}/`),
    ).toBeUndefined();
  });

  it("makes no request and changes nothing: the registry is the same with and without it", () => {
    const before = [...BUILT_ADAPTERS.keys()];
    suggestBuilder(TIDEWATER_HOME, `${TIDEWATER}/`);
    expect([...BUILT_ADAPTERS.keys()]).toEqual(before);
  });
});
