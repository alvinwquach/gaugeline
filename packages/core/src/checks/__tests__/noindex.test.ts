import { describe, expect, it } from "vitest";
import { noindex } from "../noindex.js";
import { URL0, ctx, page } from "./helpers.js";

const hops = (headers: Record<string, string>) => [{ url: URL0, status: 200, headers, ms: 1 }];

describe("noindex", async () => {
  it("passes on an indexable page", async () => {
    expect(noindex.run(page({ metaRobots: "index, follow" }), ctx)).toEqual([]);
  });

  it("fails on a robots meta tag with noindex, with the exact evidence", async () => {
    expect(noindex.run(page({ metaRobots: "noindex, nofollow" }), ctx)).toEqual([
      {
        checkId: "noindex",
        severity: "high",
        title: "This page asks search engines not to list it",
        evidence: '<meta name="robots" content="noindex, nofollow"> on https://shop.example/menu',
        url: URL0,
      },
    ]);
  });

  it("robots none also means noindex", async () => {
    expect(noindex.run(page({ metaRobots: "none" }), ctx)).toHaveLength(1);
  });

  it("edge: noindex in the X-Robots-Tag header but not the meta tag", async () => {
    const [f] = await noindex.run(page({ hops: hops({ "x-robots-tag": "noindex" }) }), ctx);
    expect(f?.evidence).toBe("X-Robots-Tag: noindex on https://shop.example/menu");
  });

  it("a header aimed at one crawler still counts", async () => {
    expect(
      noindex.run(page({ hops: hops({ "x-robots-tag": "googlebot: noindex" }) }), ctx),
    ).toHaveLength(1);
  });

  it("a word that merely contains noindex does not count", async () => {
    expect(noindex.run(page({ metaRobots: "max-snippet:-1, noindexing-is-off" }), ctx)).toEqual([]);
  });
});
