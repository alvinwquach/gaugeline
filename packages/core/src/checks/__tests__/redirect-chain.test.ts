import { describe, expect, it } from "vitest";
import type { Hop } from "../../fetcher.js";
import { redirectChain } from "../redirect-chain.js";
import { ctx, page } from "./helpers.js";

const hop = (url: string, status: number, location?: string): Hop => ({
  url,
  status,
  headers: location ? { location } : {},
  ms: 1,
});

describe("redirect-chain", () => {
  it("passes with one redirect", () => {
    const hops = [
      hop("http://shop.example/", 301, "https://shop.example/"),
      hop("https://shop.example/", 200),
    ];
    expect(redirectChain.run(page({ hops, requestedUrl: "http://shop.example/" }), ctx)).toEqual(
      [],
    );
  });

  it("fails with two, with the exact evidence", () => {
    const hops = [
      hop("http://shop.example/", 301, "https://shop.example/"),
      hop("https://shop.example/", 302, "https://shop.example/home"),
      hop("https://shop.example/home", 200),
    ];
    expect(redirectChain.run(page({ hops, requestedUrl: "http://shop.example/" }), ctx)).toEqual([
      {
        checkId: "redirect-chain",
        severity: "medium",
        title: "Your address takes several jumps to load",
        evidence:
          "2 redirects: http://shop.example/ (301) -> https://shop.example/ (302) -> https://shop.example/home (200)",
        url: "http://shop.example/",
      },
    ]);
  });

  it("no redirects pass", () => {
    expect(redirectChain.run(page(), ctx)).toEqual([]);
  });
});
