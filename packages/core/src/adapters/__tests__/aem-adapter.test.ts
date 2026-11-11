import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createAemAdapter } from "../aem.js";
import { aemTransport } from "./aem-fixture.js";

/**
 * What is particular to the Adobe Experience Manager adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out
 * once) are in the contract suite, which runs over this adapter's entry in entries.ts: write no test here
 * for those. TODO(new:adapter) add a test for each thing the platform does that no other does.
 */
const noWait = () => Promise.resolve();

describe("the Adobe Experience Manager adapter: reading", () => {
  const make = (over: { pageSize?: number; maxItemsPerType?: number } = {}) =>
    createAemAdapter({
      env: {},
      fetcher: createFetcher({
        transport: aemTransport(),
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
});
