import { describe, expect, it } from "vitest";
import { cacheRead, lifetimeOf } from "../cache.js";

describe("cacheRead: what the host and the CDN say about a response", () => {
  it.each([
    [{ "x-vercel-cache": "HIT" }, "hit", "x-vercel-cache: HIT"],
    [{ "x-vercel-cache": "STALE" }, "hit", "x-vercel-cache: STALE"],
    [{ "x-vercel-cache": "PRERENDER" }, "hit", "x-vercel-cache: PRERENDER"],
    [{ "x-vercel-cache": "REVALIDATED" }, "hit", "x-vercel-cache: REVALIDATED"],
    [{ "x-vercel-cache": "MISS" }, "miss", "x-vercel-cache: MISS"],
    [{ "x-vercel-cache": "BYPASS" }, "miss", "x-vercel-cache: BYPASS"],
    [{ "x-vercel-cache": "something-new" }, "unknown", undefined],
    [{ "cf-cache-status": "HIT" }, "hit", "cf-cache-status: HIT"],
    [{ "cf-cache-status": "UPDATING" }, "hit", "cf-cache-status: UPDATING"],
    [{ "cf-cache-status": "MISS" }, "miss", "cf-cache-status: MISS"],
    [{ "cf-cache-status": "EXPIRED" }, "miss", "cf-cache-status: EXPIRED"],
    [{ "cf-cache-status": "DYNAMIC" }, "miss", "cf-cache-status: DYNAMIC"],
    [{ "cf-cache-status": "BYPASS" }, "miss", "cf-cache-status: BYPASS"],
    [{ age: "41" }, "hit", "age: 41"],
    [{ age: "0" }, "unknown", undefined],
    [{ age: "soon" }, "unknown", undefined],
    [{}, "unknown", undefined],
  ] as const)("%j is %s", (headers, state, header) => {
    const read = cacheRead(headers);
    expect(read.state).toBe(state);
    expect(read.header).toBe(header);
  });

  it("reads the status header before age, and is not case sensitive", () => {
    expect(cacheRead({ "x-vercel-cache": "miss", age: "30" })).toEqual({
      state: "miss",
      header: "x-vercel-cache: MISS",
    });
  });

  it("an age on a CDN's MISS is not a hit: the status header decides", () => {
    expect(cacheRead({ "cf-cache-status": "MISS", age: "0" }).state).toBe("miss");
  });
});

describe("lifetimeOf: how long a shared cache may keep a response", () => {
  it.each([
    ["public, max-age=0, must-revalidate", 0, "max-age=0"],
    ["public, max-age=3600", 3600, "max-age=3600"],
    ["public, s-maxage=1, stale-while-revalidate=59", 1, "s-maxage=1"],
    ["public, max-age=0, s-maxage=86400", 86400, "s-maxage=86400"],
    ["private, no-cache, no-store, max-age=0", 0, "no-store"],
    ["no-cache", 0, "no-cache"],
    ["private, max-age=600", 0, "private"],
    ["S-MaxAge=120", 120, "s-maxage=120"],
    ['max-age="90"', 90, "max-age=90"],
  ])("%s is %i seconds (%s)", (value, seconds, from) => {
    expect(lifetimeOf({ "cache-control": value })).toEqual({ seconds, from });
  });

  it("is undefined when there is no Cache-Control header or no lifetime in it", () => {
    expect(lifetimeOf({})).toBeUndefined();
    expect(lifetimeOf({ "cache-control": "public" })).toBeUndefined();
    expect(lifetimeOf({ "cache-control": "max-age=soon" })).toBeUndefined();
  });
});
