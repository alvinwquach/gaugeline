import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
#if !live
import { collectPublished } from "../collect.js";
#end
import { create$PASCAL$Adapter } from "../$ID$.js";
#if key
import { AdapterCouldNotCheck } from "../types.js";
#end
#if live
import { AdapterCouldNotCheck } from "../types.js";
#end
#if live
import { $CAMEL$Routes, $CAMEL$Serve, $P$_SITE } from "./$ID$-fixture.js";
#else
import { $CAMEL$Transport } from "./$ID$-fixture.js";
#end

/**
 * What is particular to the $NAME$ adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out
 * once) are in the contract suite, which runs over this adapter's entry in entries.ts: write no test here
 * for those. TODO(new:adapter) add a test for each thing the platform does that no other does.
 */
const noWait = () => Promise.resolve();

#if live
describe("the $NAME$ adapter: live site only", () => {
  const fetcher = () =>
    createFetcher({ transport: $CAMEL$Serve($CAMEL$Routes()), timeoutMs: 5000 });

  it("with no site address it asks for nothing and says what to set", async () => {
    const seen: string[] = [];
    const transport = $CAMEL$Serve($CAMEL$Routes());
    const f = createFetcher({
      transport: (url, req) => {
        seen.push(url.href);
        return transport(url, req);
      },
      timeoutMs: 5000,
    });
    const adapter = create$PASCAL$Adapter({ fetcher: f, sleep: noWait });
    const err: unknown = await adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain('"site"');
    expect(seen).toEqual([]);
  });

  it("the site in the settings wins over the one the run was given", async () => {
    const adapter = create$PASCAL$Adapter({
      fetcher: fetcher(),
      site: "https://elsewhere.example",
      settings: { id: "$ID$", site: $P$_SITE },
      sleep: noWait,
    });
    expect((await adapter.types()).map((t) => t.name)).toContain("classes");
  });

  it("the content behind the platform is could-not-check, with the reason", async () => {
    const adapter = create$PASCAL$Adapter({ fetcher: fetcher(), site: $P$_SITE, sleep: noWait });
    await expect(adapter.fieldCounts("classes", ["name"])).rejects.toThrow(/^Not applicable/);
  });
});
#else
describe("the $NAME$ adapter: reading", () => {
  const make = (over: { pageSize?: number; maxItemsPerType?: number } = {}) =>
    create$PASCAL$Adapter({
#if key
      env: { $P$_TOKEN: "test-key-$ID$-0123456789" },
#else
      env: {},
#end
      fetcher: createFetcher({
#if key
        transport: $CAMEL$Transport(undefined, { token: "test-key-$ID$-0123456789" }),
#else
        transport: $CAMEL$Transport(),
#end
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

#if key
  it("with no key set it says which variable to set and asks for nothing", async () => {
    const seen: string[] = [];
    const adapter = create$PASCAL$Adapter({
      env: {},
      fetcher: createFetcher({
        transport: $CAMEL$Transport(undefined, { onRequest: (_m, url) => seen.push(url.href) }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    const err: unknown = await adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain("$P$_TOKEN");
    expect(seen).toEqual([]);
  });
#end
});
#end
