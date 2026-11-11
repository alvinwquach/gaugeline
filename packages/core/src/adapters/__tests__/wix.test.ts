import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck } from "../types.js";
import { WIX_CMS_READ_PATH, WIX_DESCRIPTION, createWixAdapter } from "../wix.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import { urlset, type Reply } from "./sitemap-feed-fixture.js";
import { MARLOW, MARLOW_MARKERS, marlowRoutes, marlowServe, marlowWithout } from "./wix-fixture.js";

afterEach(() => vi.restoreAllMocks());

function build(
  routes: Record<string, Reply> = marlowRoutes(),
  options: {
    site?: string | undefined;
    settings?: Parameters<typeof createWixAdapter>[0]["settings"];
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(marlowServe(routes), seen),
    timeoutMs: 5000,
  });
  const adapter = createWixAdapter({
    fetcher,
    site: "site" in options ? options.site : MARLOW,
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

describe("the Wix adapter describes itself", () => {
  it("asks for no key and says so in the run header", () => {
    const d = build().adapter.describe();
    expect(d).toEqual(WIX_DESCRIPTION);
    expect(d.name).toBe("Wix");
    expect(d.noKey).toBe(true);
    expect(d.keyKind).toBe("read-only");
    expect(adapterHeader(d)).toBe(
      "Content system: Wix, with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/wix",
    );
  });

  it("is built, not planned, and a settings file can name it", () => {
    expect(BUILT_ADAPTERS.get("wix")?.describe).toEqual(WIX_DESCRIPTION);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "wix")).toBe(false);
    expect(resolveAdapters({ adapters: [{ id: "wix" }] }).map((b) => b.id)).toEqual(["wix"]);
  });
});

describe("a healthy Wix site: what the live site publishes", () => {
  it("counts the groups of addresses the sitemap lists", async () => {
    expect(await build().adapter.types()).toEqual([
      { name: "post", count: 3 },
      { name: "programs", count: 2 },
      { name: "top-level", count: 3 },
    ]);
  });

  it("gives each published address with the date the sitemap gives, and no field hash", async () => {
    const { docs, partial } = await collectPublished(build().adapter, { types: ["programs"] });
    expect(partial).toBeUndefined();
    expect(docs).toEqual([
      {
        id: `${MARLOW}/programs/spring-cohort`,
        type: "programs",
        url: `${MARLOW}/programs/spring-cohort`,
        slug: "spring-cohort",
        updatedAt: "2026-11-09T00:00:00.000Z",
        fieldHashes: {},
      },
      {
        id: `${MARLOW}/programs/one-to-one`,
        type: "programs",
        url: `${MARLOW}/programs/one-to-one`,
        slug: "one-to-one",
        updatedAt: "2026-10-28T00:00:00.000Z",
        fieldHashes: {},
      },
    ]);
  });

  it("filters by the date a sitemap gives", async () => {
    const { docs } = await collectPublished(build().adapter, { since: "2026-11-01" });
    expect(docs.map((d) => d.id).sort()).toEqual(
      [
        `${MARLOW}/`,
        `${MARLOW}/book-a-call`,
        `${MARLOW}/post/salary-first-call`,
        `${MARLOW}/programs/spring-cohort`,
      ].sort(),
    );
  });

  it("reads only the files a visitor can read: robots.txt, the sitemaps, the home page for feed links and the usual feed paths", async () => {
    const { adapter, seen } = build();
    await adapter.types();
    const paths = new Set(seen.map((s) => new URL(s.url).pathname));
    expect([...paths].sort()).toEqual(
      [
        "/",
        "/atom.xml",
        "/blog-posts-sitemap.xml",
        "/dynamic-programs-sitemap.xml",
        "/feed",
        "/feed.json",
        "/feed.xml",
        "/pages-sitemap.xml",
        "/robots.txt",
        "/rss.xml",
        "/sitemap.xml",
      ].sort(),
    );
    // A page of the site is never asked for: the sitemap is the list, and its pages are other checks' business.
    expect(paths.has("/programs/spring-cohort")).toBe(false);
  });

  it("never asks Wix: every request goes to the site, every one is a GET or HEAD, and none carries a key", async () => {
    const { adapter, seen } = build();
    await adapter.types();
    await collectPublished(adapter);
    await adapter.draftsReachable();
    await adapter.fieldCounts("programs", ["name"]).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(new URL(s.url).host).toBe(new URL(MARLOW).host);
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
    }
    expect(requestProblems(seen)).toEqual([]);
  });

  it("returns none of the site's text", async () => {
    const { adapter } = build();
    const text = JSON.stringify([await adapter.types(), (await collectPublished(adapter)).docs]);
    for (const marker of Object.values(MARLOW_MARKERS)) expect(text).not.toContain(marker);
  });

  it("lists a program the CMS has taken offline when the sitemap still names it, and does not fetch it", async () => {
    // The sitemap says /programs/summer-intensive exists; the page answers 404 (not in the routes). The
    // adapter reports what the sitemap says. Whether the page answers is the sitemap-dead check's question.
    const routes = {
      ...marlowRoutes(),
      "/dynamic-programs-sitemap.xml": urlset([
        { loc: `${MARLOW}/programs/summer-intensive`, lastmod: "2026-03-01" },
        { loc: `${MARLOW}/programs/spring-cohort`, lastmod: "2026-11-09" },
      ]),
    };
    const { adapter, seen } = build(routes);
    const { docs } = await collectPublished(adapter, { types: ["programs"] });
    expect(docs.map((d) => d.slug)).toEqual(["summer-intensive", "spring-cohort"]);
    expect(seen.some((s) => s.url.endsWith("/programs/summer-intensive"))).toBe(false);
  });

  it("a hidden collection item that is not in the sitemap is not found, and the adapter does not pretend to look", async () => {
    // The CMS-side question (is an item hidden in the CMS, and does its page still answer) needs the item
    // list, which is a POST. The adapter reports only what the sitemap says and asks for no unlisted page.
    const routes = {
      ...marlowRoutes(),
      "/programs/old-retreat": {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body>Retreat that was hidden in the CMS and still answers</body></html>",
      },
    };
    const { adapter, seen } = build(routes);
    const { docs } = await collectPublished(adapter);
    expect(docs.some((d) => d.slug === "old-retreat")).toBe(false);
    expect(seen.some((s) => s.url.endsWith("/programs/old-retreat"))).toBe(false);
  });
});

describe("the CMS collections: could-not-check, with the reason, for that part only", () => {
  it("fieldCounts says Not applicable, names the POST query and the rule, and asks for nothing", async () => {
    const { adapter, seen } = build();
    const reason = await reasonOf(adapter.fieldCounts("programs", ["title"]));
    expect(reason).toMatch(/^Not applicable/);
    expect(reason).toContain("Query Data Items");
    expect(reason).toContain("POST");
    expect(reason).toContain("GET and HEAD");
    expect(reason).toBe(WIX_CMS_READ_PATH.reason);
    expect(seen).toEqual([]);
  });

  it("the rest of the adapter still answers on the same adapter", async () => {
    const { adapter } = build();
    await reasonOf(adapter.fieldCounts("programs", ["title"]));
    expect((await adapter.types()).length).toBe(3);
    expect((await collectPublished(adapter)).docs).toHaveLength(8);
  });

  it("a field hash is never made: fields asked for are ignored, not guessed from the page", async () => {
    const { adapter, seen } = build();
    const { docs } = await collectPublished(adapter, { fields: { programs: ["title"] } });
    for (const d of docs) expect(d.fieldHashes).toEqual({});
    expect(seen.some((s) => /programs\//.test(s.url))).toBe(false);
  });

  it("draftsReachable is not-applicable and asks for nothing: draft items live in the CMS", async () => {
    const { adapter, seen } = build();
    expect(await adapter.draftsReachable()).toBe("not-applicable");
    expect(seen).toEqual([]);
  });

  it("has no members, and the endpoint named as unusable is the one the docs name", () => {
    expect(build().adapter.members).toBeUndefined();
    expect(WIX_CMS_READ_PATH.method).toBe("POST");
    expect(WIX_CMS_READ_PATH.path).toBe("/wix-data/v2/items/query");
  });
});

describe("a Wix API key is never read, sent or logged", () => {
  const key = testKey("wix-api");

  it("a key in the environment reaches no request and no message", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(marlowServe(marlowRoutes()), seen),
      timeoutMs: 5000,
    });
    const built = BUILT_ADAPTERS.get("wix");
    expect(built).toBeDefined();
    const adapter = built?.create(
      {
        env: { WIX_API_KEY: key, WIX_SITE_ID: key, GAUGELINE_WIX_KEY: key },
        fetcher,
        site: MARLOW,
        sleep: () => Promise.resolve(),
      },
      { id: "wix" },
    );
    expect(adapter).toBeDefined();
    if (!adapter) return;
    const out = [
      JSON.stringify(adapter.describe()),
      JSON.stringify(await adapter.types()),
      JSON.stringify((await collectPublished(adapter)).docs),
      await reasonOf(adapter.fieldCounts("programs", ["title"])),
      String(await adapter.draftsReachable()),
    ].join("\n");
    expect(out).not.toContain(key);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(JSON.stringify(s)).not.toContain(key);
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
  });

  it("the adapter's source reads no environment and builds no request of its own", () => {
    const source = readFileSync(fileURLToPath(new URL("../wix.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\benv\b\s*[.[]/);
    expect(source).not.toMatch(/process\./);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/\bgetJson\b|\bconnectorGet\b|\bpostJson\b/);
    expect(source).not.toMatch(/\.request\(|\.post\(|\.put\(|\.delete\(/);
  });
});

describe("when the site gives nothing to read", () => {
  it("a site with no sitemap is could-not-check, not an empty list", async () => {
    const { adapter } = build(marlowWithout("/sitemap.xml", "/robots.txt"));
    expect(await reasonOf(adapter.types())).toContain("No sitemap or feed could be read");
    await expect(collectPublished(adapter)).rejects.toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("a sitemap behind a login (HTTP 403) is could-not-check with the status", async () => {
    const { adapter } = build({
      ...marlowRoutes(),
      "/sitemap.xml": { status: 403, body: "no" },
    });
    expect(await reasonOf(adapter.types())).toContain("403");
  });

  it("one refused sitemap file makes the whole read could-not-check, never a list with a hole in it", async () => {
    const { adapter } = build({
      ...marlowRoutes(),
      "/dynamic-programs-sitemap.xml": { status: 403, body: "members only" },
    });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("dynamic-programs-sitemap.xml");
    expect(reason).toContain("403");
    await expect(collectPublished(adapter)).rejects.toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("no site address is could-not-check in Wix's words, and nothing is requested", async () => {
    const { adapter, seen } = build(marlowRoutes(), { site: undefined });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("wix");
    expect(reason).not.toContain("sitemap-feed");
    expect(seen).toEqual([]);
    await reasonOf(collectPublished(adapter));
    expect(seen).toEqual([]);
  });

  it("an address that is not a web address is could-not-check", async () => {
    const { adapter, seen } = build(marlowRoutes(), { site: "ftp://marlow-coaching.example" });
    await reasonOf(adapter.types());
    expect(seen).toEqual([]);
  });
});

describe("settings", () => {
  it("site, sitemaps and feeds are accepted for wix, as for sitemap-feed", () => {
    const parsed = adaptersConfigSchema.parse({
      adapters: [{ id: "wix", site: MARLOW, sitemaps: ["/sitemap.xml"], feeds: ["/feed.xml"] }],
    });
    expect(parsed.adapters[0]?.id).toBe("wix");
  });

  it("fingerprint and urls are refused for wix: there are no fields it can read", () => {
    for (const bad of [
      { fingerprint: { programs: ["title"] } },
      { urls: { programs: "/programs/{slug}" } },
    ]) {
      const r = adaptersConfigSchema.safeParse({ adapters: [{ id: "wix", ...bad }] });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("wix");
    }
  });

  it("site is still refused for an adapter that does not read pages", () => {
    const r = adaptersConfigSchema.safeParse({ adapters: [{ id: "sanity", site: MARLOW }] });
    expect(r.success).toBe(false);
  });

  it("the settings entry's site wins, and sitemaps replace the guesses", async () => {
    const routes = {
      ...marlowWithout("/sitemap.xml", "/robots.txt"),
    };
    const { adapter, seen } = build(routes, {
      site: "https://elsewhere.example",
      settings: { id: "wix", site: MARLOW, sitemaps: ["/pages-sitemap.xml"] },
    });
    expect(await adapter.types()).toEqual([{ name: "top-level", count: 3 }]);
    expect(seen.some((s) => s.url.endsWith("/pages-sitemap.xml"))).toBe(true);
    expect(seen.some((s) => s.url.endsWith("/robots.txt"))).toBe(false);
  });
});
