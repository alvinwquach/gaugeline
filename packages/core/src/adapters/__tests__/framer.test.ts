import { afterEach, describe, expect, it, vi } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { FRAMER_CMS_READ_PATH, FRAMER_DESCRIPTION, createFramerAdapter } from "../framer.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapter, resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  LANTERN,
  LANTERN_MARKERS,
  lanternRoutes,
  lanternServe,
  lanternWithout,
} from "./framer-fixture.js";
import { urlset, type Reply } from "./sitemap-feed-fixture.js";

afterEach(() => vi.restoreAllMocks());

function build(
  routes: Record<string, Reply> = lanternRoutes(),
  options: {
    site?: string | undefined;
    settings?: Parameters<typeof createFramerAdapter>[0]["settings"];
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(lanternServe(routes), seen),
    timeoutMs: 5000,
  });
  const adapter = createFramerAdapter({
    fetcher,
    site: "site" in options ? options.site : LANTERN,
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

describe("the Framer adapter describes itself", () => {
  it("is beta, asks for no key, and says so in the run header", () => {
    const d = build().adapter.describe();
    expect(d).toEqual(FRAMER_DESCRIPTION);
    expect(d.name).toBe("Framer");
    expect(d.beta).toBe(true);
    expect(d.noKey).toBe(true);
    expect(d.keyKind).toBe("read-only");
    expect(adapterHeader(d)).toBe(
      "Content system: Framer (beta), with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/framer",
    );
  });

  it("an adapter that is not beta prints no beta word", () => {
    const sitemap = BUILT_ADAPTERS.get("sitemap-feed")?.describe;
    expect(sitemap?.beta).toBeUndefined();
    expect(adapterHeader(sitemap ?? FRAMER_DESCRIPTION)).not.toContain("beta");
  });

  it("is built, not planned, and a settings file can name it", () => {
    expect(BUILT_ADAPTERS.get("framer")?.describe).toEqual(FRAMER_DESCRIPTION);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "framer")).toBe(false);
    expect(resolveAdapters({ adapters: [{ id: "framer" }] }).map((b) => b.id)).toEqual(["framer"]);
  });
});

describe("a healthy Framer site: what the live site publishes", () => {
  it("counts the groups of addresses the sitemap lists", async () => {
    expect(await build().adapter.types()).toEqual([
      { name: "drops", count: 2 },
      { name: "journal", count: 2 },
      { name: "top-level", count: 3 },
    ]);
  });

  it("gives each published address with the date the sitemap gives, and no field hash", async () => {
    const { docs, partial } = await collectPublished(build().adapter, { types: ["drops"] });
    expect(partial).toBeUndefined();
    expect(docs).toEqual([
      {
        id: `${LANTERN}/drops/moonglaze-mugs`,
        type: "drops",
        url: `${LANTERN}/drops/moonglaze-mugs`,
        slug: "moonglaze-mugs",
        updatedAt: "2026-11-09T00:00:00.000Z",
        fieldHashes: {},
      },
      {
        id: `${LANTERN}/drops/ember-bowls`,
        type: "drops",
        url: `${LANTERN}/drops/ember-bowls`,
        slug: "ember-bowls",
        updatedAt: "2026-10-28T00:00:00.000Z",
        fieldHashes: {},
      },
    ]);
  });

  it("reads only the files a visitor can read: robots.txt, the sitemap, the home page for feed links and the usual feed paths", async () => {
    const { adapter, seen } = build();
    await adapter.types();
    const paths = new Set(seen.map((s) => new URL(s.url).pathname));
    expect([...paths].sort()).toEqual(
      [
        "/",
        "/atom.xml",
        "/feed",
        "/feed.json",
        "/feed.xml",
        "/robots.txt",
        "/rss.xml",
        "/sitemap.xml",
      ].sort(),
    );
    // A page of the site is never asked for: the sitemap is the list, and its pages are other checks' business.
    expect(paths.has("/drops/moonglaze-mugs")).toBe(false);
  });

  it("never asks Framer: every request goes to the site, and every one is a GET or HEAD", async () => {
    const { adapter, seen } = build();
    await adapter.types();
    await collectPublished(adapter);
    await adapter.draftsReachable();
    await adapter.fieldCounts("drops", ["name"]).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(new URL(s.url).host).toBe(new URL(LANTERN).host);
    expect(requestProblems(seen)).toEqual([]);
  });

  it("returns none of the site's text", async () => {
    const { adapter } = build();
    const text = JSON.stringify([await adapter.types(), (await collectPublished(adapter)).docs]);
    for (const marker of Object.values(LANTERN_MARKERS)) expect(text).not.toContain(marker);
  });

  it("lists a page the CMS has taken offline when the sitemap still names it, and does not fetch it", async () => {
    // The sitemap says /drops/last-years-vases exists; the page answers 404 (not in the routes). The
    // adapter reports what the sitemap says. Whether the page answers is the sitemap-dead check's question.
    const routes = {
      ...lanternRoutes(),
      "/sitemap.xml": urlset([
        { loc: `${LANTERN}/drops/last-years-vases`, lastmod: "2026-03-01" },
        { loc: `${LANTERN}/drops/moonglaze-mugs`, lastmod: "2026-11-09" },
      ]),
    };
    const { adapter, seen } = build(routes);
    const { docs } = await collectPublished(adapter, { types: ["drops"] });
    expect(docs.map((d) => d.slug)).toEqual(["last-years-vases", "moonglaze-mugs"]);
    expect(seen.some((s) => s.url.endsWith("/drops/last-years-vases"))).toBe(false);
  });
});

describe("the CMS collections: could-not-check, with the reason, for that part only", () => {
  it("fieldCounts says Not applicable, names the Server API, and asks for nothing", async () => {
    const { adapter, seen } = build();
    const reason = await reasonOf(adapter.fieldCounts("journal", ["title"]));
    expect(reason).toMatch(/^Not applicable/);
    expect(reason).toContain("Framer Server API");
    expect(reason).toContain("WebSocket");
    expect(reason).toContain("GET and HEAD");
    expect(reason).toBe(FRAMER_CMS_READ_PATH.reason);
    expect(seen).toEqual([]);
  });

  it("the rest of the adapter still answers on the same adapter", async () => {
    const { adapter } = build();
    await reasonOf(adapter.fieldCounts("journal", ["title"]));
    expect((await adapter.types()).length).toBe(3);
    expect((await collectPublished(adapter)).docs).toHaveLength(7);
  });

  it("a field hash is never made: fields asked for are ignored, not guessed from the page", async () => {
    const { adapter, seen } = build();
    const { docs } = await collectPublished(adapter, { fields: { journal: ["title"] } });
    for (const d of docs) expect(d.fieldHashes).toEqual({});
    expect(seen.some((s) => /journal\//.test(s.url))).toBe(false);
  });

  it("draftsReachable is not-applicable and asks for nothing: unpublished work lives in the project", async () => {
    const { adapter, seen } = build();
    expect(await adapter.draftsReachable()).toBe("not-applicable");
    expect(seen).toEqual([]);
  });

  it("has no members, and the reason the CMS cannot be read is the same text the docs give", () => {
    expect(build().adapter.members).toBeUndefined();
    expect(FRAMER_CMS_READ_PATH.endpoint).toBe("wss://api.framer.com/channel/headless-plugin");
    expect(FRAMER_CMS_READ_PATH.package).toBe("framer-api");
  });
});

describe("a project API key is never read, sent or logged", () => {
  const key = testKey("framer-project");

  it("a key in the environment (FRAMER_API_KEY) reaches no request and no message", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(lanternServe(lanternRoutes()), seen),
      timeoutMs: 5000,
    });
    const built = BUILT_ADAPTERS.get("framer");
    expect(built).toBeDefined();
    const adapter = built
      ? await createAdapter(
          built,
          {
            env: { FRAMER_API_KEY: key, GAUGELINE_FRAMER_KEY: key },
            fetcher,
            site: LANTERN,
            sleep: () => Promise.resolve(),
          },
          { id: "framer" },
        )
      : undefined;
    expect(adapter).toBeDefined();
    if (!adapter) return;
    const out = [
      JSON.stringify(adapter.describe()),
      JSON.stringify(await adapter.types()),
      JSON.stringify((await collectPublished(adapter)).docs),
      await reasonOf(adapter.fieldCounts("drops", ["name"])),
      String(await adapter.draftsReachable()),
    ].join("\n");
    expect(out).not.toContain(key);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(JSON.stringify(s)).not.toContain(key);
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
    }
  });

  it("the adapter's source never names the key variable: nothing in it can read it", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../framer.ts", import.meta.url)), "utf8");
    // The docs and the reason may name it; code may not look it up (no env access of any kind).
    expect(source).not.toMatch(/\benv\b\s*[.[]/);
    expect(source).not.toMatch(/process\./);
    expect(source).not.toMatch(/\bWebSocket\(/);
  });
});

describe("when the site gives nothing to read", () => {
  it("a site with no sitemap is could-not-check, not an empty list", async () => {
    const { adapter } = build(lanternWithout("/sitemap.xml", "/robots.txt"));
    expect(await reasonOf(adapter.types())).toContain("No sitemap or feed could be read");
    await expect(collectPublished(adapter)).rejects.toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("a sitemap behind a login (HTTP 403) is could-not-check with the status", async () => {
    const { adapter } = build({
      ...lanternRoutes(),
      "/sitemap.xml": { status: 403, body: "no" },
    });
    expect(await reasonOf(adapter.types())).toContain("403");
  });

  it("no site address is could-not-check in Framer's words, and nothing is requested", async () => {
    const { adapter, seen } = build(lanternRoutes(), { site: undefined });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("framer");
    expect(reason).not.toContain("sitemap-feed");
    expect(seen).toEqual([]);
    await reasonOf(collectPublished(adapter));
    expect(seen).toEqual([]);
  });

  it("an address that is not a web address is could-not-check", async () => {
    const { adapter, seen } = build(lanternRoutes(), { site: "ftp://lantern-row.example" });
    await reasonOf(adapter.types());
    expect(seen).toEqual([]);
  });
});

describe("settings", () => {
  it("site, sitemaps and feeds are accepted for framer, as for sitemap-feed", () => {
    const parsed = adaptersConfigSchema.parse({
      adapters: [
        {
          id: "framer",
          site: LANTERN,
          sitemaps: ["/sitemap.xml"],
          feeds: ["/feed.xml"],
        },
      ],
    });
    expect(parsed.adapters[0]?.id).toBe("framer");
  });

  it("fingerprint and urls are refused for framer: there are no fields it can read", () => {
    for (const bad of [
      { fingerprint: { journal: ["title"] } },
      { urls: { journal: "/journal/{slug}" } },
    ]) {
      const r = adaptersConfigSchema.safeParse({ adapters: [{ id: "framer", ...bad }] });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("framer");
    }
  });

  it("site is still refused for an adapter that does not read pages", () => {
    const r = adaptersConfigSchema.safeParse({ adapters: [{ id: "sanity", site: LANTERN }] });
    expect(r.success).toBe(false);
  });

  it("the settings entry's site wins, and sitemaps replace the guesses", async () => {
    const routes = {
      ...lanternWithout("/sitemap.xml", "/robots.txt"),
      "/pages-sitemap.xml": urlset([{ loc: `${LANTERN}/visit`, lastmod: "2026-11-08" }]),
    };
    const { adapter, seen } = build(routes, {
      site: "https://elsewhere.example",
      settings: { id: "framer", site: LANTERN, sitemaps: ["/pages-sitemap.xml"] },
    });
    expect(await adapter.types()).toEqual([{ name: "top-level", count: 1 }]);
    expect(seen.some((s) => s.url.endsWith("/pages-sitemap.xml"))).toBe(true);
    expect(seen.some((s) => s.url.endsWith("/robots.txt"))).toBe(false);
  });
});
