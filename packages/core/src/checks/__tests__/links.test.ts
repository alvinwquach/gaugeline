import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import { linkCandidates, sampleLinks } from "../../links.js";
import { probe } from "../../probe.js";
import { isSameSite, sampleUrls } from "../../sample.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { page } from "./helpers.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function send(body: string, status = 200, type = "text/html") {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(status, { "content-type": type }).end(body);
  };
}

describe("sampler: unit", () => {
  it("100 links with 40 duplicates gives the first 30 unique, in the same order every run", () => {
    // 60 unique links; after each of the first 40, the same link again spelled differently.
    const urls: { url: string; text: string }[] = [];
    for (let i = 0; i < 60; i++) {
      urls.push({ url: `https://shop.example/p/${i}`, text: `link ${i}` });
      if (i < 40) urls.push({ url: `https://SHOP.example/p/${i}#again`, text: `again ${i}` });
    }
    expect(urls).toHaveLength(100);
    const a = sampleUrls(urls, 30);
    const b = sampleUrls([...urls], 30);
    expect(a.seen).toBe(60);
    expect(a.taken).toHaveLength(30);
    expect(a.taken).toEqual(b.taken);
    expect(a.taken[0]).toEqual({
      url: "https://shop.example/p/0",
      href: "https://shop.example/p/0",
      text: "link 0",
    });
    expect(new Set(a.taken.map((t) => t.url)).size).toBe(30);
    // Document order: the indices only ever increase.
    const idx = a.taken.map((t) => Number(t.url.split("/").pop()));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
  });

  it("a limit larger than the input returns everything, and seen equals taken", () => {
    const r = sampleUrls(
      [{ url: "https://shop.example/a" }, { url: "https://shop.example/b" }],
      30,
    );
    expect(r.taken).toHaveLength(2);
    expect(r.seen).toBe(r.taken.length);
  });

  it("same site: www and the bare host match; a subdomain and another domain do not", () => {
    expect(isSameSite("https://www.shop.example/a", "https://shop.example/")).toBe(true);
    expect(isSameSite("http://shop.example/a", "https://WWW.shop.example/")).toBe(true);
    expect(isSameSite("https://blog.shop.example/", "https://shop.example/")).toBe(false);
    expect(isSameSite("https://shop.example.other/", "https://shop.example/")).toBe(false);
    expect(isSameSite("tel:+15035550100", "https://shop.example/")).toBe(false);
  });
});

describe("link checks: integration (fixture site)", () => {
  it("one 404 link and one 301 link: exactly two findings with the hop evidence", async () => {
    const site = await startFixture("links");
    try {
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const { result, budget } = await checkSite({ address: site.origin, fetcher });
      const links = result.findings.filter((f) =>
        ["broken-links", "links-via-redirect"].includes(f.checkId),
      );
      expect(links.map((f) => [f.checkId, f.evidence])).toEqual([
        ["broken-links", '"Garden centre" <a href="/garden-centre"> returned 404'],
        ["links-via-redirect", "/old-paint (301) ends at /paint"],
      ]);
      // tools, garden-centre, old-paint, staff, busy, old-catalogue: six unique same-site links.
      expect(budget.summary().links).toEqual({ limit: 30, sampled: 6, found: 6 });
    } finally {
      await site.close();
    }
  });

  it("mailto, tel, javascript: and #fragment hrefs are never fetched; nor is another site", async () => {
    const site = await startFixture("links");
    try {
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      await checkSite({ address: site.origin, fetcher, only: ["broken-links"] });
      expect([...site.hits.keys()].sort()).toEqual(
        [
          "/",
          "/busy",
          "/garden-centre",
          "/old-catalogue",
          "/old-paint",
          "/paint",
          "/staff",
          "/tools",
        ].sort(),
      );
      expect(site.hits.get("/garden-centre")).toBe(1);
    } finally {
      await site.close();
    }
  });

  it("HEAD answered 405: GET is used, and the server sees one HEAD and one GET", async () => {
    const server = await startServer({
      "/menu": (req, res) => {
        if (req.method === "HEAD") res.writeHead(405).end();
        else send("<title>Menu</title>")(req, res);
      },
    });
    servers.push(server);
    const hops = await probe(`${server.origin}/menu`, createFetcher({ allowPrivate: true }));
    expect(hops.at(-1)?.status).toBe(200);
    expect(server.log.map((r) => r.method)).toEqual(["HEAD", "GET"]);
  });
});

describe("link checks: promise test", () => {
  it("a page with 200 links: 30 or fewer link requests, all HEAD or GET", async () => {
    const body = Array.from({ length: 200 }, (_, i) => `<a href="/p/${i}">${i}</a>`).join("");
    const server = await startServer(
      { "/": send(`<title>Many</title>${body}`) },
      send("<title>p</title>"),
    );
    servers.push(server);
    const fetcher = createFetcher({ allowPrivate: true });
    const { budget } = await checkSite({
      address: `${server.origin}/`,
      fetcher,
      only: ["broken-links"],
    });
    const linkRequests = server.log.filter((r) => r.path.startsWith("/p/"));
    expect(linkRequests.length).toBeLessThanOrEqual(30);
    expect(linkRequests.every((r) => r.method === "HEAD" || r.method === "GET")).toBe(true);
    expect(budget.summary().links).toEqual({ limit: 30, sampled: 30, found: 200 });
  });
});

describe("link checks: edge cases", () => {
  it("a 200 with a 'not found' body is not flagged (soft 404 is out of scope)", async () => {
    const site = await startFixture("links");
    try {
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const { result } = await checkSite({ address: site.origin, fetcher, only: ["broken-links"] });
      expect(result.findings.map((f) => f.url)).not.toContain(`${site.origin}/old-catalogue`);
    } finally {
      await site.close();
    }
  });

  it("403 and 429 are not broken links (G12e decides what they mean); 404, 410 and 500 are", async () => {
    const server = await startServer({
      "/": send(
        ["/forbidden", "/slow-down", "/missing", "/gone", "/error"]
          .map((p) => `<a href="${p}">${p}</a>`)
          .join(""),
      ),
      "/forbidden": send("no", 403),
      "/slow-down": send("later", 429),
      "/gone": send("gone", 410),
      "/error": send("oops", 500),
    });
    servers.push(server);
    const fetcher = createFetcher({ allowPrivate: true });
    const { result } = await checkSite({
      address: `${server.origin}/`,
      fetcher,
      only: ["broken-links"],
    });
    expect(result.findings.map((f) => new URL(f.url).pathname)).toEqual([
      "/missing",
      "/gone",
      "/error",
    ]);
  });

  it("the same href in the header and the footer is one finding", async () => {
    const snapshot = buildSnapshot([
      {
        url: "https://shop.example/",
        status: 200,
        headers: { "content-type": "text/html" },
        body: '<header><a href="/x">X</a></header><footer><a href="/x#top">X again</a><a href="https://WWW.shop.example/x">X</a></footer>',
        ms: 1,
      },
    ]);
    const candidates = linkCandidates(snapshot);
    expect(candidates).toHaveLength(3);
    expect(sampleUrls(candidates, 30).taken).toHaveLength(2); // www is the same site, not the same URL
    const r = sampleUrls(candidates.slice(0, 2), 30);
    expect(r.taken).toEqual([
      { url: "https://shop.example/x", href: "https://shop.example/x", text: "X" },
    ]);
  });

  it("an unreachable link is not reported as broken", async () => {
    const budget = createBudget();
    const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 1000 });
    const sample = await sampleLinks({
      page: page({
        finalUrl: "http://127.0.0.1:9/",
        links: [{ href: "http://127.0.0.1:9/nowhere", text: "x", sameSite: true }],
      }),
      fetcher,
      budget,
    });
    expect(sample.taken[0]?.hops).toEqual([]);
  });
});
