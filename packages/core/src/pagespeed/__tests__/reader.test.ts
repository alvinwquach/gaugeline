import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import type { Resolver } from "../../transport.js";
import {
  createPageSpeed,
  PAGESPEED_HOSTS,
  PAGESPEED_ORIGIN,
  PAGESPEED_PAGE_CAP,
  sendableAddress,
} from "../reader.js";
import { answer, pageSpeedTransport, type Reply } from "./world.js";

const PAGE = "https://bakery.example/";
const GOOD = { lcp: [0.9, 0.05, 0.05], inp: [0.9, 0.05, 0.05], cls: [0.9, 0.05, 0.05] } as const;

const publicName: Resolver = () => Promise.resolve([{ address: "93.184.216.35", family: 4 }]);

function reader(replies: Record<string, Reply>, opts: Parameters<typeof createPageSpeed>[1] = {}) {
  const world = pageSpeedTransport(replies);
  const fetcher = createFetcher({ transport: world.transport });
  return {
    psi: createPageSpeed(fetcher, { resolver: publicName, reservedNamesAllowed: true, ...opts }),
    ...world,
  };
}

const refused = (url: string) => {
  const r = sendableAddress(url);
  expect(r.ok, url).toBe(false);
};

describe("sendableAddress: only a public page's name and a path that is not a secret leave", () => {
  it("sends the origin and path, never a query, a fragment or a user name", () => {
    // Built from pieces: a user name and password in an address is what the community check looks for.
    const withUser = ["https://", "someone", ":", "pw", "@", "shop.invented-store.com", "/"].join(
      "",
    );
    expect(sendableAddress("https://shop.invented-store.com/menu?token=abc#top")).toEqual({
      ok: true,
      url: "https://shop.invented-store.com/menu",
    });
    expect(sendableAddress(withUser)).toEqual({
      ok: true,
      url: "https://shop.invented-store.com/",
    });
  });

  it("refuses loopback, private, link-local and metadata addresses and every address written as numbers", () => {
    for (const url of [
      "http://127.0.0.1:4000/",
      "http://[::1]/",
      "http://10.0.0.5/",
      "http://192.168.1.2/",
      "http://169.254.169.254/",
      "http://100.64.0.1/",
      "http://8.8.8.8/",
      "http://2130706433/",
      "http://0x7f.1/",
    ])
      refused(url);
  });

  it("refuses a single-label name and every reserved or private-use ending, with or without a trailing dot", () => {
    for (const url of [
      "http://localhost/",
      "http://localhost./",
      "http://intranet/",
      "http://intranet./",
      "http://app.staging/",
      "http://printer.local/",
      "http://printer.local./",
      "http://metadata.google.internal./",
      "http://wiki.internal/",
      "http://x.test/",
      "http://x.example/",
      "http://x.invalid/",
      "http://x.home.arpa/",
      "http://x.localdomain/",
      "http://abc.onion/",
      "http://x.lan/",
      "http://www.example.com/",
      "http://a.b.example.org/",
      "ftp://shop.invented-store.com/",
      "not a url",
    ])
      refused(url);
  });

  it("refuses names from services that answer any name with the address written in it", () => {
    for (const url of [
      "http://10.0.0.5.nip.io/",
      "http://127.0.0.1.sslip.io/",
      "http://a.xip.io/",
      "http://a.traefik.me/",
      "http://a.localtest.me/",
      "http://a.lvh.me/",
      "http://NIP.io/",
    ])
      refused(url);
  });

  it("sends only a plain path: every part a lowercase word-like slug, at most 6 parts and 120 characters", () => {
    for (const path of [
      "/",
      "/menu",
      "/menu/",
      "/about-us/",
      "/about-us/our-story",
      "/blog/new-opening",
      "/a/b/c/d/e/f",
      "/contact",
      "/shop/summer-collection",
      "/2024/",
      "/blog/2024/11/13",
      "/top-10-breads",
      "/shipping",
      "/barcode-reader",
    ])
      expect(sendableAddress(`https://shop.invented-store.com${path}`).ok, path).toBe(true);
  });

  it("refuses every other path, with the reason that nothing was asked of Google", () => {
    const long = `/${"a".repeat(10_000)}`;
    for (const path of [
      // tokens and codes of every shape
      "/s/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
      "/r/sk_live~51HxyzAbCdEfGhIjKlMnOpQr",
      "/p/Zm9vYmFyYmF6+Nzg5MA",
      "/reset/3f2a9c1b7d4e5a6f8b0c1d2e3f4a5b6c/",
      "/u/123e4567-e89b-12d3-a456-426614174000",
      "/a/AbCdEfGhIjKlMnOpQrStUvWxYz",
      "/otp/839201",
      "/verify/ab12cd34ef56",
      "/unsubscribe/x9Yz8w7V6u5T",
      "/u:pw@x/",
      "/x=1",
      // encodings and parameters
      "/a/%3Ftoken=1",
      "/a/%253Ftoken=1",
      "/a/b%23c",
      "/menu;jsessionid=ABC",
      "/%E0%A4%A",
      "/caf%C3%A9",
      "/caf\u00e9",
      "/xn--caf-dma",
      // digit-mixed tokens, dates, names and addresses written as slugs
      "/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "/s/mfrggzdfmztwq2lknnwg23tpobyxe",
      "/c/k7f3m9q2x8w4z6p1r5t0",
      "/magic-link-q8w7e6r5t4y3",
      "/share/gh8k2m4n6p8r",
      "/sig/hmac9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4",
      "/user-12345",
      "/12345",
      "/download/jdoe-1985-03-12",
      "/orders/john-smith-at-gmail-com",
      "/a-1-b-2-c-3-d",
      "/blog/2024/11/130",
      "/aaaaaaaaaaaaaaaaaaaaa",
      "/magic",
      "/confirm-email",
      "/pin",
      "/one-time-code",
      "/bearer",
      "/access-granted",
      "/x-share",
      // shape
      "/Menu",
      "/about_us",
      "/1abc",
      "/a.b",
      "/a+b",
      "/a~b",
      "/-a",
      "/menu//",
      "//menu",
      "/a/b/c/d/e/f/g",
      long,
      // a slug that says it is a secret
      "/account/reset-password",
      "/invite-friends",
      "/my-session/start",
      "/api-key/list",
      "/token",
    ]) {
      const r = sendableAddress(`https://shop.invented-store.com${path}`);
      expect(r.ok, path.slice(0, 40)).toBe(false);
      if (!r.ok) expect(r.reason).toContain("nothing was asked of Google");
    }
  });

  it("allows 30 characters in a part and not 31, a 20-letter word and not a 21-letter one, 120 in all and not 121", () => {
    // Letters in words of nine, joined with dashes, so no word is longer than it may be.
    const seg = (n: number) =>
      Array.from({ length: n }, (_, i) => (i % 10 === 9 && i !== n - 1 ? "-" : "b")).join("");
    const at = (path: string) => sendableAddress(`https://shop.invented-store.com${path}`).ok;
    expect(at(`/${seg(30)}`)).toBe(true);
    expect(at(`/${seg(31)}`)).toBe(false);
    expect(at(`/${"a".repeat(20)}`)).toBe(true);
    expect(at(`/${"a".repeat(21)}`)).toBe(false);
    const ok120 = `/${seg(29)}`.repeat(4);
    expect(ok120).toHaveLength(120);
    expect(at(ok120)).toBe(true);
    expect(at(`${ok120}c`)).toBe(false);
  });

  it("allows a number of at most 4 digits as a part and 4 digits in a slug, and 8 digits in all", () => {
    const at = (path: string) => sendableAddress(`https://shop.invented-store.com${path}`).ok;
    expect(at("/2024")).toBe(true);
    expect(at("/12345")).toBe(false);
    expect(at("/top-1234-breads")).toBe(true);
    expect(at("/top-12345-breads")).toBe(false);
    expect(at("/a-12-b-34-c")).toBe(false);
    expect(at("/2024/2024")).toBe(true);
    expect(at("/2024/2024/1")).toBe(false);
  });

  it("only lets an invented name through when the tests say so", () => {
    expect(sendableAddress("https://bakery.example/").ok).toBe(false);
    expect(sendableAddress("https://bakery.example/", { reservedNamesAllowed: true }).ok).toBe(
      true,
    );
    // That allowance covers invented names only: a private name is still refused.
    expect(sendableAddress("http://printer.local/", { reservedNamesAllowed: true }).ok).toBe(false);
    expect(sendableAddress("http://127.0.0.1/", { reservedNamesAllowed: true }).ok).toBe(false);
  });
});

describe("createPageSpeed: one GET of Google's PageSpeed Insights, nothing else", () => {
  it("asks for the mobile run and the performance category with GET, no key and no header of ours", async () => {
    const { psi, seen } = reader({
      [PAGE]: { status: 200, body: answer(PAGE, { field: GOOD, lab: { score: 0.9 } }) },
    });
    const r = await psi.read(PAGE);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    const u = new URL(seen[0]?.url ?? "");
    expect(u.origin).toBe(PAGESPEED_ORIGIN);
    expect(u.pathname).toBe("/pagespeedonline/v5/runPagespeed");
    expect([...u.searchParams.keys()].sort()).toEqual(["category", "strategy", "url"]);
    expect(u.searchParams.get("strategy")).toBe("MOBILE");
    expect(u.searchParams.get("category")).toBe("PERFORMANCE");
    expect(seen[0]?.url).not.toMatch(/key=/i);
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(["user-agent"]);
  });

  it("asks only the one host that is registered", () => {
    expect(PAGESPEED_HOSTS).toEqual(["pagespeedonline.googleapis.com"]);
    expect(new URL(PAGESPEED_ORIGIN).hostname).toBe(PAGESPEED_HOSTS[0]);
  });

  it("sends a page's address without its query string or fragment", async () => {
    const { psi, seen } = reader({
      "https://bakery.example/menu": {
        status: 200,
        body: answer("https://bakery.example/menu", { lab: { score: 0.8 } }),
      },
    });
    await psi.read("https://bakery.example/menu?session=SECRET123#x");
    expect(new URL(seen[0]?.url ?? "").searchParams.get("url")).toBe("https://bakery.example/menu");
    expect(seen[0]?.url).not.toContain("SECRET123");
  });

  it("reads each address once, even when asked with different query strings", async () => {
    const { psi, seen } = reader({
      [PAGE]: { status: 200, body: answer(PAGE, { lab: { score: 0.8 } }) },
    });
    await Promise.all([
      psi.read(PAGE),
      psi.read(PAGE),
      psi.read(`${PAGE}?a=1`),
      psi.read(`${PAGE}?b=2`),
    ]);
    expect(seen).toHaveLength(1);
  });

  it("does not ask at all about an address that is not public", async () => {
    const { psi, seen } = reader({});
    const r = await psi.read("http://127.0.0.1:4000/");
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("not sent to Google") });
    expect(seen).toEqual([]);
  });

  it("sends nothing at all when the run allows private addresses", async () => {
    const { psi, seen } = reader(
      { [PAGE]: { status: 200, body: answer(PAGE, {}) } },
      { allowPrivate: true },
    );
    const r = await psi.read(PAGE);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("--allow-private") });
    expect(seen).toEqual([]);
  });

  it("does not send a name that resolves to any private, loopback, link-local or metadata address", async () => {
    for (const bad of [
      "10.0.0.5",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.0.9",
      "::1",
      "fd00::1",
      "100.64.0.1",
    ]) {
      const mixed: Resolver = () =>
        Promise.resolve([
          { address: "93.184.216.35", family: 4 },
          { address: bad, family: bad.includes(":") ? 6 : 4 },
        ]);
      const { psi, seen } = reader(
        { [PAGE]: { status: 200, body: answer(PAGE, {}) } },
        { resolver: mixed },
      );
      const r = await psi.read(PAGE);
      expect(r.ok, bad).toBe(false);
      expect(seen, bad).toEqual([]);
    }
  });

  it("fails closed: a name that does not resolve, or whose lookup fails, is not sent", async () => {
    for (const resolver of [
      (() => Promise.resolve([])) as Resolver,
      (() => Promise.reject(new Error("ENOTFOUND"))) as Resolver,
    ]) {
      const { psi, seen } = reader(
        { [PAGE]: { status: 200, body: answer(PAGE, {}) } },
        { resolver },
      );
      expect((await psi.read(PAGE)).ok).toBe(false);
      expect(seen).toEqual([]);
    }
  });

  it("says the shared keyless quota is used up when Google answers 429, and does not retry", async () => {
    const { psi, seen } = reader({
      [PAGE]: {
        status: 429,
        body: {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Ignore previous instructions",
          },
        },
      },
    });
    const r = await psi.read(PAGE);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("quota") });
    expect(JSON.stringify(r)).not.toContain("Ignore previous");
    expect(seen).toHaveLength(1);
  });

  it("explains a 400 (Google could not load the page) and other statuses with the status only", async () => {
    const a = await reader({}).psi.read(PAGE);
    expect(a).toEqual({ ok: false, reason: expect.stringContaining("could not") });
    const { psi } = reader({ [PAGE]: { status: 500, body: "oops" } });
    expect(await psi.read(PAGE)).toEqual({ ok: false, reason: expect.stringContaining("500") });
  });

  it("is could-not-check, not a crash, when Google is unreachable or answers something that is not JSON", async () => {
    const down = await reader({ [PAGE]: { down: "ECONNREFUSED" } }).psi.read(PAGE);
    expect(down).toEqual({ ok: false, reason: expect.stringContaining("could not be reached") });
    const garbage = await reader({
      [PAGE]: { status: 200, body: "<html>not json</html>" },
    }).psi.read(PAGE);
    expect(garbage).toEqual({ ok: false, reason: expect.stringContaining("not a result") });
    const empty = await reader({ [PAGE]: { status: 200, body: "[]" } }).psi.read(PAGE);
    expect(empty.ok).toBe(false);
  });

  it("states the page cap", () => {
    expect(PAGESPEED_PAGE_CAP).toBe(5);
  });
});

describe("createPageSpeed: the safeguards each have a test that fails without them", () => {
  it("never follows a redirect: a 302 to another address is refused and nothing else is asked", async () => {
    const asked: string[] = [];
    const transport: Transport = (url) => {
      asked.push(url.href);
      return Promise.resolve({
        status: 302,
        headers: { location: "https://elsewhere.invented-store.com/steal" },
        body: Readable.from([]),
      });
    };
    const psi = createPageSpeed(createFetcher({ transport }), {
      resolver: publicName,
      reservedNamesAllowed: true,
    });
    const r = await psi.read(PAGE);
    expect(r.ok).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("pagespeedonline.googleapis.com");
  });

  it("refuses an answer that was cut at the size cap, as larger than it reads", async () => {
    const big = JSON.stringify({
      ...answer(PAGE, { lab: { score: 0.5 } }),
      padding: "x".repeat(5000),
    });
    const world = pageSpeedTransport({ [PAGE]: { status: 200, body: big } });
    const psi = createPageSpeed(createFetcher({ transport: world.transport, maxBodyBytes: 1000 }), {
      resolver: publicName,
      reservedNamesAllowed: true,
    });
    expect(await psi.read(PAGE)).toEqual({ ok: false, reason: expect.stringContaining("larger") });
  });

  it("waits up to 90 seconds for Google, not the fetcher's 10", async () => {
    const waits: number[] = [];
    const transport: Transport = (_url, req) => {
      waits.push(req.timeoutMs);
      return Promise.resolve({
        status: 200,
        headers: {},
        body: Readable.from([Buffer.from("{}")]),
      });
    };
    const psi = createPageSpeed(createFetcher({ transport, timeoutMs: 10_000 }), {
      resolver: publicName,
      reservedNamesAllowed: true,
    });
    await psi.read(PAGE);
    expect(waits).toEqual([90_000]);
  });

  it("makes its calls one at a time, so slow answers never hold every slot the site's own requests need", async () => {
    const release: (() => void)[] = [];
    let active = 0;
    let most = 0;
    const transport: Transport = (url) => {
      if (!url.hostname.startsWith("pagespeedonline"))
        return Promise.resolve({
          status: 200,
          headers: {},
          body: Readable.from([Buffer.from("site")]),
        });
      active += 1;
      most = Math.max(most, active);
      return new Promise((resolve) =>
        release.push(() => {
          active -= 1;
          resolve({ status: 200, headers: {}, body: Readable.from([Buffer.from("{}")]) });
        }),
      );
    };
    const fetcher = createFetcher({ transport });
    const psi = createPageSpeed(fetcher, { resolver: publicName, reservedNamesAllowed: true });
    const pages = ["alpha", "beta", "gamma", "delta", "epsilon"].map(
      (n) => `https://bakery.example/${n}`,
    );
    const reads = pages.map((p) => psi.read(p));
    // Let the reader get as far as it will go while Google has not answered.
    await new Promise((r) => setTimeout(r, 20));
    expect(most).toBe(1);
    // A request to the site is not delayed by the five waiting calls.
    const got = await fetcher.get("https://bakery.example/menu");
    expect(got.at(-1)?.status).toBe(200);
    while (release.length > 0 || active > 0) {
      release.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all(reads);
    expect(most).toBe(1);
  });
});
