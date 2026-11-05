import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { alternateHost, hostDuplicate } from "../host-duplicate.js";
import { html, redirect, startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { page } from "./helpers.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function serve(...args: Parameters<typeof startServer>) {
  const s = await startServer(...args);
  servers.push(s);
  return s;
}
const warn = () => undefined;

describe("alternateHost", () => {
  it("toggles www and goes to the root", () => {
    expect(alternateHost("https://shop.example/menu?x=1")).toBe("https://www.shop.example/");
    expect(alternateHost("https://www.shop.example/menu")).toBe("https://shop.example/");
  });
  it("has nothing for IP addresses or single-label hosts", () => {
    expect(alternateHost("http://127.0.0.1:4000/")).toBeUndefined();
    expect(alternateHost("http://localhost/")).toBeUndefined();
  });
});

describe("host-duplicate", () => {
  it("passes when the alternate host redirects", async () => {
    const bare = await serve({ "/": html("bare") });
    const www = await serve({ "/": redirect(301, "http://shop.test/") });
    const fetcher = createFetcher({
      allowPrivate: true,
      hosts: { "shop.test": `127.0.0.1:${bare.port}`, "www.shop.test": `127.0.0.1:${www.port}` },
    });
    expect(
      await hostDuplicate.run(page({ finalUrl: "http://shop.test/" }), { warn, fetcher }),
    ).toEqual([]);
  });

  it("fails when both hosts return 200, with the exact evidence", async () => {
    const bare = await serve({ "/": html("bare") });
    const www = await serve({ "/": html("www copy") });
    const fetcher = createFetcher({
      allowPrivate: true,
      hosts: { "shop.test": `127.0.0.1:${bare.port}`, "www.shop.test": `127.0.0.1:${www.port}` },
    });
    expect(
      await hostDuplicate.run(page({ finalUrl: "http://shop.test/menu" }), { warn, fetcher }),
    ).toEqual([
      {
        checkId: "host-duplicate",
        severity: "high",
        title: "Your whole site exists at two addresses",
        evidence: "http://www.shop.test/ returned 200 instead of a 301 to http://shop.test/",
        url: "http://www.shop.test/",
      },
    ]);
    expect(www.log.map((r) => r.method)).toEqual(["GET"]);
  });

  it("edge: no www record at all (DNS failure) is not a finding", async () => {
    const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
    expect(
      await hostDuplicate.run(page({ finalUrl: "http://gaugeline-no-such-host.invalid/" }), {
        warn,
        fetcher,
      }),
    ).toEqual([]);
  });

  it("edge: an alternate host that refuses the connection is not a finding", async () => {
    const bare = await serve({ "/": html("bare") });
    const closed = await startServer({});
    const port = closed.port;
    await closed.close();
    const fetcher = createFetcher({
      allowPrivate: true,
      hosts: { "shop.test": `127.0.0.1:${bare.port}`, "www.shop.test": `127.0.0.1:${port}` },
    });
    expect(
      await hostDuplicate.run(page({ finalUrl: "http://shop.test/" }), { warn, fetcher }),
    ).toEqual([]);
  });

  it("without a fetcher in the context, the check does nothing", async () => {
    expect(await hostDuplicate.run(page(), { warn })).toEqual([]);
  });
});
