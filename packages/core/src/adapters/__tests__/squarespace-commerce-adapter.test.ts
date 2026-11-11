import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createSquarespaceCommerceAdapter } from "../squarespace-commerce.js";
import { AdapterCouldNotCheck } from "../types.js";
import { squarespaceCommerceTransport } from "./squarespace-commerce-fixture.js";

/**
 * What is particular to the Squarespace commerce adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out
 * once) are in the contract suite, which runs over this adapter's entry in entries.ts: write no test here
 * for those. TODO(new:adapter) add a test for each thing the platform does that no other does.
 */
const noWait = () => Promise.resolve();

describe("the Squarespace commerce adapter: reading", () => {
  const make = (over: { pageSize?: number; maxItemsPerType?: number } = {}) =>
    createSquarespaceCommerceAdapter({
      env: { SQUARESPACE_COMMERCE_TOKEN: "test-key-squarespace-commerce-0123456789" },
      fetcher: createFetcher({
        transport: squarespaceCommerceTransport(undefined, {
          token: "test-key-squarespace-commerce-0123456789",
        }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
      ...over,
    });

  it("reads a list a page at a time and gives the same items as one big page", async () => {
    const small = (await collectPublished(make({ pageSize: 1 }), { types: ["classes"] })).docs;
    const big = (await collectPublished(make(), { types: ["classes"] })).docs;
    expect(small.map((d) => d.id)).toEqual(["c-morning", "c-evening"]);
    expect(small).toEqual(big);
  });

  it("a type bigger than the bound is could-not-check, never a count of part of it", async () => {
    await expect(make({ maxItemsPerType: 1 }).fieldCounts("classes", ["name"])).rejects.toThrow(
      /more than 1 item/,
    );
  });

  it("with no key set it says which variable to set and asks for nothing", async () => {
    const seen: string[] = [];
    const adapter = createSquarespaceCommerceAdapter({
      env: {},
      fetcher: createFetcher({
        transport: squarespaceCommerceTransport(undefined, {
          onRequest: (_m, url) => seen.push(url.href),
        }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    const err: unknown = await adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain("SQUARESPACE_COMMERCE_TOKEN");
    expect(seen).toEqual([]);
  });
});
