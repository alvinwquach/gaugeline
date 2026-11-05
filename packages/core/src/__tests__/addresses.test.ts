import { afterEach, describe, expect, it } from "vitest";
import { blockedRange, parseIPv6 } from "../addresses.js";
import { FetchError, createFetcher } from "../fetcher.js";
import type { Resolver } from "../transport.js";
import { html, redirect, startServer, type FixtureServer } from "./helpers/server.js";

describe("blockedRange: every range", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["169.254.0.1", "link-local"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique-local"],
    ["fd12:3456:789a::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["febf::1", "link-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:10.0.0.1", "private"],
    ["::127.0.0.1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["2002:c0a8:0101::1", "private"],
  ];
  it.each(blocked)("%s is %s", (address, range) => {
    expect(blockedRange(address)).toBe(range);
  });

  const allowed = [
    "8.8.8.8",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.255.255",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:db8::1",
    "fec0::1",
    "::ffff:8.8.8.8",
  ];
  it.each(allowed)("%s is public", (address) => {
    expect(blockedRange(address)).toBeUndefined();
  });

  it("parses IPv6 forms to 16 bytes", () => {
    expect(parseIPv6("::1")).toEqual([...Array(15).fill(0), 1]);
    expect(parseIPv6("::ffff:1.2.3.4")?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIPv6("not-an-address")).toBeUndefined();
  });
});

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function serve(...args: Parameters<typeof startServer>) {
  const s = await startServer(...args);
  servers.push(s);
  return s;
}

describe("fetcher: blocked addresses", () => {
  it("refuses 127.0.0.1 by default with a typed blocked-address error and sends nothing", async () => {
    const s = await serve({ "/": html("secret admin page") });
    const f = createFetcher();
    const err = (await f.get(`${s.origin}/`).catch((e: unknown) => e)) as FetchError;
    expect(err).toBeInstanceOf(FetchError);
    expect(err.reason).toBe("blocked-address");
    expect(err.message).toBe(
      `127.0.0.1:${s.port} points at a loopback address (127.0.0.1), which Gaugeline does not request.`,
    );
    expect(err.hint).toContain("--allow-private");
    expect(s.log).toHaveLength(0);
    expect(f.stats.requests).toBe(0);
  });

  it("allowPrivate lets it through", async () => {
    const s = await serve({ "/": html("ok") });
    expect((await createFetcher({ allowPrivate: true }).get(`${s.origin}/`))[0]?.status).toBe(200);
  });

  it("an IPv4-mapped IPv6 literal for loopback is refused too", async () => {
    const s = await serve({ "/": html("x") });
    const err = (await createFetcher()
      .get(`http://[::ffff:127.0.0.1]:${s.port}/`)
      .catch((e: unknown) => e)) as FetchError;
    expect(err.reason).toBe("blocked-address");
    expect(s.log).toHaveLength(0);
  });

  it("a redirect from a public host to 169.254.169.254 is refused at that hop", async () => {
    const s = await serve({ "/": redirect(302, "http://169.254.169.254/latest/meta-data/") });
    const f = createFetcher({ hosts: { "public.test": `127.0.0.1:${s.port}` } });
    const err = (await f.get("http://public.test/").catch((e: unknown) => e)) as FetchError;
    expect(err.reason).toBe("blocked-address");
    expect(err.message).toContain("link-local address (169.254.169.254)");
    expect(err.hops.map((h) => h.status)).toEqual([302]);
    expect(f.stats.requests).toBe(1);
  });

  it("a host whose DNS answer includes any private address is refused", async () => {
    const resolver: Resolver = () =>
      Promise.resolve([
        { address: "203.0.113.10", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]);
    const err = (await createFetcher({ resolver })
      .get("http://mixed.test/")
      .catch((e: unknown) => e)) as FetchError;
    expect(err.reason).toBe("blocked-address");
    expect(err.message).toContain("10.0.0.5");
  });

  it("a redirect to a name that resolves to loopback is refused (every hop is checked)", async () => {
    const s = await serve({ "/": redirect(301, "http://internal.test/admin") });
    const resolver: Resolver = (host) =>
      Promise.resolve(host === "internal.test" ? [{ address: "127.0.0.1", family: 4 }] : []);
    const f = createFetcher({ hosts: { "public.test": `127.0.0.1:${s.port}` }, resolver });
    const err = (await f.get("http://public.test/").catch((e: unknown) => e)) as FetchError;
    expect(err.reason).toBe("blocked-address");
    expect(err.hops).toHaveLength(1);
  });

  it("rebinding: the socket connects to the address that was checked, not a fresh lookup", async () => {
    const loopback = await serve({ "/": html("internal service") });
    let calls = 0;
    // First answer is public; any later lookup would say loopback. A second lookup at connect time
    // would reach the fixture server; pinning sends the connection to the public address instead.
    const resolver: Resolver = () => {
      calls += 1;
      return Promise.resolve([{ address: calls === 1 ? "203.0.113.7" : "127.0.0.1", family: 4 }]);
    };
    const f = createFetcher({ resolver, timeoutMs: 800 });
    const err = await f.get(`http://rebind.test:${loopback.port}/`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).reason).not.toBe("blocked-address");
    expect(calls).toBe(1);
    expect(loopback.log).toHaveLength(0);
  });

  it("the hosts mapping still works for tests and is trusted as configured", async () => {
    const s = await serve({ "/": html("fixture") });
    const hops = await createFetcher({ hosts: { "shop.test": `127.0.0.1:${s.port}` } }).get(
      "http://shop.test/",
    );
    expect(hops[0]?.body).toBe("fixture");
  });

  it("a blocked address on getSite is not retried over http", async () => {
    const resolver: Resolver = () => Promise.resolve([{ address: "192.168.1.1", family: 4 }]);
    const err = (await createFetcher({ resolver })
      .getSite("router.test")
      .catch((e: unknown) => e)) as FetchError;
    expect(err.reason).toBe("blocked-address");
    expect(err.url).toBe("https://router.test/");
  });
});
