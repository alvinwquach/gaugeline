import { describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchError } from "../../fetcher.js";
import { createFetcher, createNetworkTransport } from "../../fetcher.js";
import { classifyAddress, createAddressPolicy } from "../address-policy.js";

describe("address policy: unit", () => {
  it("classifyAddress", () => {
    const table: [string, string][] = [
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"],
      ["10.0.0.1", "private"],
      ["172.16.0.1", "private"],
      ["172.32.0.1", "public"],
      ["192.168.1.1", "private"],
      ["169.254.169.254", "link-local"],
      ["100.64.0.1", "private"],
      ["0.0.0.0", "unspecified"],
      ["::1", "loopback"],
      ["fc00::1", "private"],
      ["fe80::1", "link-local"],
      ["::ffff:127.0.0.1", "loopback"],
      ["8.8.8.8", "public"],
    ];
    for (const [ip, want] of table) expect(classifyAddress(ip), ip).toBe(want);
  });

  it("the target on loopback is allowed; a followed loopback hop on another port is refused; the target's own host and port is allowed", () => {
    const target = new URL("http://127.0.0.1:3000/");
    const policy = createAddressPolicy(target);
    expect(policy(target, "127.0.0.1", "target")).toBe(true);
    expect(policy(new URL("http://127.0.0.1:4817/api/runs"), "127.0.0.1", "followed")).toBe(false);
    expect(policy(new URL("http://127.0.0.1:3000/about"), "127.0.0.1", "followed")).toBe(true);
    expect(policy(new URL("https://cdn.example/x.js"), "93.184.216.34", "followed")).toBe(true);
  });

  it("http://2130706433/ and http://0x7f.1/ as followed addresses are loopback", () => {
    // The URL parser spells both as 127.0.0.1, and that is the address classified.
    const policy = createAddressPolicy(new URL("https://shop.example/"));
    for (const raw of ["http://2130706433/", "http://0x7f.1/"]) {
      const u = new URL(raw);
      expect(u.hostname).toBe("127.0.0.1");
      expect(classifyAddress(u.hostname)).toBe("loopback");
      expect(policy(u, u.hostname, "followed")).toBe(false);
    }
  });
});

/** A server on 127.0.0.1 that counts its requests; `answer` decides the reply. */
async function server(answer: (res: ServerResponse) => void) {
  let hits = 0;
  const s = createServer((_req, res) => {
    hits++;
    answer(res);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return {
    origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    hits: () => hits,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

describe("address policy: integration (the fetcher, real sockets)", () => {
  it("a site redirects to another loopback port (the app's own): the hop is refused, recorded, and never sent", async () => {
    const app = await server((res) => res.writeHead(200).end("runs"));
    const site = await server((res) =>
      res.writeHead(302, { location: `${app.origin}/api/runs` }).end(),
    );
    try {
      const f = createFetcher({ target: site.origin });
      const err = (await f.get(`${site.origin}/`).catch((e: unknown) => e)) as FetchError;
      expect(err.reason).toBe("private-address-refused");
      expect(err.hops.map((h) => [h.status, h.error ?? ""])).toEqual([
        [302, ""],
        [0, "private-address-refused"],
      ]);
      expect([site.hits(), app.hits()]).toEqual([1, 0]);
    } finally {
      await app.close();
      await site.close();
    }
  });

  it("a redirect to 169.254.169.254 is refused before any socket opens", async () => {
    let sent = 0;
    const transport = createNetworkTransport({
      target: "http://127.0.0.1:3000/",
      onSend: () => sent++,
    });
    const err = await transport(new URL("http://169.254.169.254/latest/meta-data/"), {
      method: "GET",
      headers: {},
      timeoutMs: 1000,
    }).catch((e: unknown) => e);
    expect((err as FetchError).reason).toBe("private-address-refused");
    expect(sent).toBe(0);
  });

  it("a host name with one public and one loopback A record is refused as a followed address", async () => {
    let sent = 0;
    const transport = createNetworkTransport({
      target: "https://shop.example/",
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      onSend: () => sent++,
    });
    const err = await transport(new URL("https://split.example/"), {
      method: "GET",
      headers: {},
      timeoutMs: 1000,
    }).catch((e: unknown) => e);
    expect([(err as FetchError).reason, sent]).toEqual(["private-address-refused", 0]);
  });

  it("the typed target on loopback is requested, private and all", async () => {
    const site = await server((res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<p>ok</p>"),
    );
    try {
      const hops = await createFetcher({ target: site.origin }).get(`${site.origin}/`);
      expect(hops.map((h) => h.status)).toEqual([200]);
    } finally {
      await site.close();
    }
  });
});
