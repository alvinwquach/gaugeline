import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PLANTED, withFixture } from "../../../fixtures/src/index.js";
import { createFetcher, createNetworkTransport, type Transport } from "../fetcher.js";
import { leaksView, MAX_PREVIEWS, remembered } from "../leaks-view.js";
import { checkSite } from "../site.js";
import { SANITY_QUERY } from "../sanity.js";
import type { PageSnapshot } from "../snapshot.js";
import type { TransportResponse } from "../transport.js";

const json = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: Readable.from([Buffer.from(JSON.stringify(body))]),
});

/** Sanity answers from here; the fixture server answers everything else. */
function sanityAnswering(answer: (url: URL) => TransportResponse, asked: URL[] = []): Transport {
  const local = createNetworkTransport({ allowPrivate: true });
  return (url, req) => {
    if (!url.hostname.endsWith(".api.sanity.io")) return local(url, req);
    asked.push(url);
    return Promise.resolve(answer(url));
  };
}

const TYPES = ["author", "page", "post", "product", "siteSettings", "venue"];

describe("checkSite: what the leaks, dataset and preview checks read", () => {
  it("lists the datasets, the scripts scanned and the preview links, without a key or a document", async () => {
    await withFixture("leaks", async (site) => {
      const asked: URL[] = [];
      const transport = sanityAnswering(
        () => json(200, { result: { count: 412, types: TYPES } }),
        asked,
      );
      const { leaks, result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ transport }),
      });
      expect(leaks.datasets).toEqual([
        { projectId: "ab12cd34", dataset: "production", state: "public", count: 412, types: TYPES },
      ]);
      expect(leaks.scripts).toEqual([
        {
          url: `${site.origin}/assets/app.js`,
          where: "/assets/app.js",
          status: 200,
          truncated: false,
        },
      ]);
      // The one question asked of Sanity is the count and the type names.
      expect(asked).toHaveLength(1);
      expect(decodeURIComponent(asked[0]?.searchParams.get("query") ?? "")).toBe(SANITY_QUERY);
      // The key was found, and neither the view nor anything beside the result holds its value.
      expect(result.findings.some((f) => f.checkId === "secret-in-js")).toBe(true);
      const planted = PLANTED["stripe-secret"] ?? "";
      expect(planted).not.toBe("");
      expect(JSON.stringify(leaks)).not.toContain(planted);
    });
  });

  it("a private dataset has no count and no types", async () => {
    await withFixture("leaks", async (site) => {
      const transport = sanityAnswering(() => json(401, { error: "Unauthorized" }));
      const { leaks } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ transport }),
      });
      expect(leaks.datasets).toEqual([
        { projectId: "ab12cd34", dataset: "production", state: "private" },
      ]);
    });
  });

  it("a site that names no Sanity dataset has an empty list; skipped checks leave the lists out", async () => {
    await withFixture("clean", async (site) => {
      const all = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
      });
      expect(all.leaks.datasets).toEqual([]);
      const none = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["canonical-elsewhere"],
      });
      expect(none.leaks.datasets).toBeUndefined();
      expect(none.leaks.scripts).toBeUndefined();
    });
  });
});

function page(links: string[]): PageSnapshot {
  return {
    finalUrl: "https://shop.example/",
    links: links.map((href) => ({ href, text: "", sameSite: false })),
  } as unknown as PageSnapshot;
}

describe("leaksView", () => {
  it("lists each preview address once, and not an ordinary one", () => {
    const view = leaksView({
      page: page([
        "https://shop-git-main.vercel.app/a",
        "https://shop-git-main.vercel.app/a",
        "https://shop.example/b",
        "not an address",
        "https://shop.netlify.app/",
      ]),
    });
    expect(view.previews).toEqual([
      "https://shop-git-main.vercel.app/a",
      "https://shop.netlify.app/",
    ]);
  });

  it("caps the preview list", () => {
    const view = leaksView({
      page: page(Array.from({ length: 80 }, (_, i) => `https://p${i}.vercel.app/`)),
    });
    expect(view.previews).toHaveLength(MAX_PREVIEWS);
  });

  it("leaves a script's text out and removes secret-looking text from its address", () => {
    const view = leaksView({
      page: page([]),
      scripts: [
        {
          url: "https://shop.example/app.js?token=abcdefghijklmnop",
          status: 200,
          truncated: false,
          text: "const secret = 'never in the view'",
        },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(view)).not.toContain("never in the view");
    expect(Object.keys(view.scripts?.[0] ?? {}).sort()).toEqual([
      "status",
      "truncated",
      "url",
      "where",
    ]);
  });

  it("an unreadable dataset carries no counts or types", () => {
    const view = leaksView({
      page: page([]),
      datasets: [
        {
          projectId: "ab12cd34",
          dataset: "production",
          url: "https://x",
          state: "unknown",
          count: 9,
          types: ["order"],
        },
      ],
    });
    expect(view.datasets).toEqual([
      { projectId: "ab12cd34", dataset: "production", state: "unknown" },
    ]);
  });
});

describe("remembered", () => {
  it("reads once, and says nothing until something asks", async () => {
    let reads = 0;
    const read = remembered(async () => ++reads);
    expect(read.peek()).toBeUndefined();
    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    expect(await read.peek()).toBe(1);
    expect(reads).toBe(1);
  });
});
