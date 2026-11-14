import { Readable } from "node:stream";
import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { createFetcher, FetchError, type Hop, type Transport } from "../../fetcher.js";
import type { Finding } from "../../model.js";
import { groupByDestination, type AdRow } from "../export.js";
import { checkAdLandingPages } from "../check.js";
import {
  classifyLanding,
  parseAvailability,
  shopifyProduct,
  summarise,
  summarySentence,
} from "../landing.js";
import type { TagProbe } from "../tags.js";

const SHOP = "https://ember-oak.example";

const hop = (
  url: string,
  status = 200,
  extra: { location?: string; body?: string; type?: string } = {},
): Hop => ({
  url,
  status,
  headers: {
    "content-type": extra.type ?? "text/html",
    ...(extra.location === undefined ? {} : { location: extra.location }),
  },
  ...(extra.body === undefined ? {} : { body: extra.body }),
  ms: 1,
});

const probeOf = (hops: Hop[], extra: Partial<TagProbe> = {}): TagProbe => ({
  url: `${SHOP}/products/oat-candle`,
  requested: `${SHOP}/products/oat-candle?utm_source=x`,
  source: "export",
  tags: { utm_source: "x" },
  hops,
  ads: 1,
  spend: [{ currency: "USD", amount: 1000 }],
  ...extra,
});

const SHOPIFY_HTML =
  '<!doctype html><title>Oat candle</title><link rel="preconnect" href="https://cdn.shopify.com"><h1>Oat candle</h1><p>Hand poured.</p>';

// ---- unit: availability ---------------------------------------------------------------------------

const endpoint = (variants: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 1, title: "Oat candle", handle: "oat-candle", variants, ...extra });

describe("parseAvailability", () => {
  it("every variant unavailable is sold out, and names them", () => {
    const a = parseAvailability(
      endpoint([
        { id: 1, title: "Small", available: false },
        { id: 2, title: "Large", available: false },
      ]),
    );
    expect(a).toEqual({ kind: "sold-out", variants: 2, names: ["Small", "Large"] });
  });

  it("one variant available means it can be bought, and the others are listed", () => {
    const a = parseAvailability(
      endpoint([
        { id: 1, title: "Small", available: true },
        { id: 2, title: "Medium", available: false },
        { id: 3, title: "Large", available: false },
      ]),
    );
    expect(a).toEqual({ kind: "partial", variants: 3, unavailable: ["Medium", "Large"] });
  });

  it("all available is in stock", () => {
    expect(
      parseAvailability(endpoint([{ id: 1, title: "Default Title", available: true }])),
    ).toEqual({ kind: "in-stock", variants: 1 });
  });

  it("an empty variants array is unknown, not sold out", () => {
    expect(parseAvailability(endpoint([], { available: false }))).toMatchObject({
      kind: "unknown",
    });
  });

  it("anything that is not the product endpoint is unknown", () => {
    for (const text of [
      "",
      "<!doctype html><title>Not found</title>",
      "null",
      "[]",
      '{"variants":"none"}',
      '{"product":{"variants":[]}}',
    ])
      expect(parseAvailability(text), text).toMatchObject({ kind: "unknown" });
  });

  it("a variant that does not say whether it can be bought makes the whole answer unknown", () => {
    expect(
      parseAvailability(
        endpoint([
          { id: 1, title: "Small", available: false },
          { id: 2, title: "Large" },
        ]),
      ),
    ).toMatchObject({ kind: "unknown" });
    expect(parseAvailability(endpoint([{ id: 1, available: "false" }]))).toMatchObject({
      kind: "unknown",
    });
  });

  it("a variant without a title is named by its id", () => {
    expect(parseAvailability(endpoint([{ id: 77, available: false }]))).toEqual({
      kind: "sold-out",
      variants: 1,
      names: ["variant 77"],
    });
  });
});

// ---- unit: what a landing page's answer is --------------------------------------------------------

describe("classifyLanding", () => {
  const url = `${SHOP}/products/oat-candle`;

  it("a page that answers 200 loads", () => {
    expect(classifyLanding(probeOf([hop(url, 200, { body: SHOPIFY_HTML })]))).toMatchObject({
      kind: "loads",
    });
  });

  it("4xx and 5xx are dead, with the status", () => {
    for (const status of [404, 410, 500, 502])
      expect(classifyLanding(probeOf([hop(url, status)])), String(status)).toMatchObject({
        kind: "dead",
        status,
      });
  });

  it("a redirect that ends in a 404 is dead and says where it went", () => {
    const landing = classifyLanding(
      probeOf([hop(url, 301, { location: "/gone" }), hop(`${SHOP}/gone`, 404)]),
    );
    expect(landing).toMatchObject({ kind: "dead", status: 404 });
  });

  it("a request that failed is dead, with the reason in a sentence", () => {
    expect(
      classifyLanding(
        probeOf([], { error: "ember-oak.example could not be reached.", errorReason: "network" }),
      ),
    ).toMatchObject({ kind: "dead", why: expect.stringContaining("could not be reached") });
    expect(
      classifyLanding(
        probeOf([hop(url, 301, { location: "/a" })], {
          error: "Stopped after 10 redirects",
          errorReason: "too-many-redirects",
        }),
      ),
    ).toMatchObject({ kind: "dead" });
  });

  it("an address Gaugeline refuses to ask for is not a dead page", () => {
    for (const errorReason of ["private-address-refused", "blocked-address"] as const)
      expect(
        classifyLanding(probeOf([], { error: "refused", errorReason })),
        errorReason,
      ).toMatchObject({ kind: "unreadable" });
    expect(
      classifyLanding(
        probeOf([
          hop(url, 301, { location: "http://10.0.0.1/" }),
          {
            url: "http://10.0.0.1/",
            status: 0,
            headers: {},
            ms: 0,
            error: "private-address-refused",
          },
        ]),
      ),
    ).toMatchObject({ kind: "unreadable" });
  });

  it("a refusal of automated readers (401, 403, 429) is not a dead page", () => {
    for (const status of [401, 403, 429])
      expect(classifyLanding(probeOf([hop(url, status)])), String(status)).toMatchObject({
        kind: "unreadable",
      });
  });

  it("a password-protected storefront is not dead", () => {
    const password = `${SHOP}/password`;
    expect(
      classifyLanding(
        probeOf([
          hop(url, 302, { location: "/password" }),
          hop(password, 200, {
            body: "<title>Opening soon</title><p>Enter using the password</p>",
          }),
        ]),
      ),
    ).toMatchObject({ kind: "unreadable", why: expect.stringContaining("password") });
    expect(
      classifyLanding(
        probeOf([
          hop(url, 200, {
            body: '<form method="post"><input type="hidden" name="form_type" value="storefront_password"></form>',
          }),
        ]),
      ),
    ).toMatchObject({ kind: "unreadable" });
  });
});

// ---- unit: is it a Shopify product page -----------------------------------------------------------

describe("shopifyProduct", () => {
  const page = (path: string, body = SHOPIFY_HTML) =>
    probeOf([hop(`${SHOP}${path}`, 200, { body })]);

  it("a /products/<handle> page with Shopify's markers is one, and the endpoint is the handle's .js", () => {
    expect(shopifyProduct(page("/products/oat-candle?variant=12"))).toEqual({
      handle: "oat-candle",
      endpoint: `${SHOP}/products/oat-candle.js`,
    });
  });

  it("each marker is enough, and a language folder or a collection in front of the handle is allowed", () => {
    for (const marker of [
      '<script src="https://cdn.shopify.com/s/files/1/0/t/1/assets/theme.js"></script>',
      "<script>window.Shopify = { shop: 'x' };</script>",
      '<meta name="shopify-digital-wallet" content="/1/digital_wallets/dialog">',
      '<meta name="shopify-checkout-api-token" content="abc">',
    ])
      expect(
        shopifyProduct(page("/en-ca/products/oat-candle", `<title>x</title>${marker}`)),
        marker,
      ).toMatchObject({ handle: "oat-candle" });
    expect(shopifyProduct(page("/collections/autumn/products/oat-candle"))).toMatchObject({
      handle: "oat-candle",
      endpoint: `${SHOP}/products/oat-candle.js`,
    });
  });

  it("a page under /products/ without the markers is not Shopify", () => {
    expect(
      shopifyProduct(page("/products/field-notes", "<title>Field notes</title><p>Plain.</p>")),
    ).toBeUndefined();
  });

  it("a Shopify page that is not a product, or a handle that cannot be asked for, has no endpoint", () => {
    for (const path of ["/", "/collections/autumn", "/products", "/products/", "/products/a/b/c"])
      expect(shopifyProduct(page(path)), path).toBeUndefined();
    expect(shopifyProduct(page("/products/oat.candle"))).toBeUndefined();
    expect(shopifyProduct(page("/products/a%2Fb"))).toBeUndefined();
  });

  it("the address it reads is where the visitor ends up, after redirects", () => {
    const p = probeOf([
      hop(`${SHOP}/go`, 301, { location: "https://shop.ember-oak.example/products/oat-candle" }),
      hop("https://shop.ember-oak.example/products/oat-candle", 200, { body: SHOPIFY_HTML }),
    ]);
    expect(shopifyProduct(p)).toEqual({
      handle: "oat-candle",
      endpoint: "https://shop.ember-oak.example/products/oat-candle.js",
    });
  });

  it("a page that did not load has no endpoint", () => {
    expect(
      shopifyProduct(probeOf([hop(`${SHOP}/products/oat-candle`, 404, { body: SHOPIFY_HTML })])),
    ).toBeUndefined();
  });
});

// ---- unit: the summary maths ----------------------------------------------------------------------

const rows = (list: Array<[string, number, string?]>): AdRow[] =>
  list.map(([path, spend, currency], i) => ({
    name: `Ad ${i + 1}`,
    link: `${SHOP}${path}`,
    spend,
    ...(currency ? { currency } : {}),
  }));

const finding = (
  url: string,
  checkId = "ad-dead-page",
  severity: Finding["severity"] = "high",
) => ({
  checkId,
  severity,
  title: checkId,
  evidence: "x",
  url,
});

describe("summarise", () => {
  const groups = groupByDestination(
    rows([
      ["/a", 90000, "USD"],
      ["/a", 10000, "USD"],
      ["/b", 5000, "USD"],
      ["/c", 400, "USD"],
    ]),
  );

  it("three destinations, two with problems: spend is added per destination and in total, as integers", () => {
    const [usd, ...rest] = summarise(groups, [
      finding(`${SHOP}/b`),
      finding(`${SHOP}/c`, "ad-sold-out"),
    ]);
    expect(rest).toEqual([]);
    expect(usd).toMatchObject({
      currency: "USD",
      totalSpend: 105400,
      spendOnProblemPages: 5400,
    });
    expect(usd?.byDestination.map((d) => [d.url, d.ads, d.spend, d.findings])).toEqual([
      [`${SHOP}/b`, 1, 5000, ["ad-dead-page"]],
      [`${SHOP}/c`, 1, 400, ["ad-sold-out"]],
      [`${SHOP}/a`, 2, 100000, []],
    ]);
  });

  it("sorts by spend on pages with problems, highest first, then by spend and address", () => {
    const [usd] = summarise(groups, [finding(`${SHOP}/c`), finding(`${SHOP}/b`)]);
    expect(usd?.byDestination.map((d) => d.url)).toEqual([`${SHOP}/b`, `${SHOP}/c`, `${SHOP}/a`]);
    // Nothing wrong: the biggest page first.
    const [clean] = summarise(groups, []);
    expect(clean?.byDestination.map((d) => d.url)).toEqual([`${SHOP}/a`, `${SHOP}/b`, `${SHOP}/c`]);
    expect(clean?.spendOnProblemPages).toBe(0);
  });

  it("a destination with two problems counts its spend once", () => {
    const [usd] = summarise(groups, [
      finding(`${SHOP}/b`),
      finding(`${SHOP}/b`, "placeholder-text", "medium"),
      finding(`${SHOP}/b`, "ad-dead-page", "low"),
    ]);
    expect(usd?.totalSpend).toBe(105400);
    expect(usd?.spendOnProblemPages).toBe(5000);
    expect(usd?.byDestination[0]?.findings).toEqual(["ad-dead-page", "placeholder-text"]);
  });

  it("a low note lists the page's check but does not make it a problem page", () => {
    const [usd] = summarise(groups, [finding(`${SHOP}/b`, "ad-sold-out", "low")]);
    expect(usd?.spendOnProblemPages).toBe(0);
    expect(usd?.byDestination.find((d) => d.url === `${SHOP}/b`)?.findings).toEqual([
      "ad-sold-out",
    ]);
    expect(usd?.byDestination[0]?.url).toBe(`${SHOP}/a`);
    expect(summarySentence(usd as NonNullable<typeof usd>)).toBeUndefined();
  });

  it("a finding about an address that is not a destination changes no total", () => {
    const [usd] = summarise(groups, [finding(`${SHOP}/elsewhere`)]);
    expect(usd?.spendOnProblemPages).toBe(0);
  });

  it("two currencies make two summaries, never one sum", () => {
    const mixed = groupByDestination(
      rows([
        ["/a", 4000, "EUR"],
        ["/a", 2500, "USD"],
        ["/a", 100, "USD"],
        ["/b", 1500, "EUR"],
        ["/c", 900, "JPY"],
      ]),
    );
    const out = summarise(mixed, [finding(`${SHOP}/a`)]);
    expect(out.map((s) => [s.currency, s.totalSpend, s.spendOnProblemPages])).toEqual([
      ["EUR", 5500, 4000],
      ["USD", 2600, 2600],
      ["JPY", 900, 0],
    ]);
  });

  it("a file that names no currency has one summary with a null currency", () => {
    const g = groupByDestination(rows([["/a", 1250]]));
    expect(summarise(g, [finding(`${SHOP}/a`)])).toMatchObject([
      { currency: null, totalSpend: 1250, spendOnProblemPages: 1250 },
    ]);
  });

  it("an export with no destinations has no summary", () => {
    expect(summarise(new Map(), [])).toEqual([]);
  });

  it("the sentence says how much of the total went to pages with problems", () => {
    const [usd] = summarise(groups, [finding(`${SHOP}/b`), finding(`${SHOP}/c`)]);
    expect(summarySentence(usd as NonNullable<typeof usd>)).toBe(
      "54.00 USD of 1054.00 USD went to pages with problems.",
    );
    const [none] = summarise(groups, []);
    expect(summarySentence(none as NonNullable<typeof none>)).toBeUndefined();
    const [yen] = summarise(groupByDestination(rows([["/a", 900, "JPY"]])), [finding(`${SHOP}/a`)]);
    expect(summarySentence(yen as NonNullable<typeof yen>)).toBe(
      "900 JPY of 900 JPY went to pages with problems.",
    );
  });
});

// ---- integration: the fixture shop with its product endpoint --------------------------------------

describe("checkAdLandingPages: the fixture shop", () => {
  async function run(paths: string[], spend = 1000) {
    const site = await startFixture("ad-shop");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const list: AdRow[] = paths.map((p, i) => ({
        name: `Ad ${i + 1}`,
        link: `${site.origin}${p}`,
        spend: spend * (i + 1),
        currency: "USD",
      }));
      const groups = groupByDestination(list);
      const out = await checkAdLandingPages(groups, { fetcher });
      return { out, site };
    } finally {
      await site.close();
    }
  }

  it("12 ads, 4 destinations, one 404 and one sold out: two high findings, and the summary names both with their spend", async () => {
    const site = await startFixture("ad-shop");
    try {
      const pages = ["/products/oat-candle", "/products/retired-mug", "/products/amber-tin", "/"];
      const list: AdRow[] = Array.from({ length: 12 }, (_, i) => ({
        name: `Ad ${i + 1}`,
        link: `${site.origin}${pages[i % 4]}?utm_campaign=c${i}&utm_source=facebook`,
        spend: 1000 + i,
        currency: "USD",
      }));
      const groups = groupByDestination(list);
      expect(groups.size).toBe(4);
      const fetcher = createFetcher({ allowPrivate: true });
      const out = await checkAdLandingPages(groups, { fetcher });
      expect(out.findings.map((f) => [f.checkId, f.severity, f.url])).toEqual([
        ["ad-dead-page", "high", `${site.origin}/products/retired-mug`],
        ["ad-sold-out", "high", `${site.origin}/products/oat-candle`],
      ]);
      const [usd] = summarise(groups, out.findings);
      const spendOf = (path: string) => groups.get(`${site.origin}${path}`)?.spend ?? Number.NaN;
      expect(usd?.spendOnProblemPages).toBe(
        spendOf("/products/oat-candle") + spendOf("/products/retired-mug"),
      );
      expect(
        usd?.byDestination
          .slice(0, 2)
          .map((d) => d.url)
          .sort(),
      ).toEqual(
        [`${site.origin}/products/oat-candle`, `${site.origin}/products/retired-mug`].sort(),
      );
      expect(usd?.byDestination.slice(2).every((d) => d.findings.length === 0)).toBe(true);
      expect(out.findings[0]?.evidence).toContain("404");
      expect(out.findings[0]?.evidence).toContain("3 ads send people to this page");
      expect(out.findings[1]?.evidence).toContain("All 2 variants of oat-candle are sold out");
      expect(out.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("some variants unavailable is a low note listing them, not a sold-out finding", async () => {
    const { out } = await run(["/products/linen-wick-set"]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ checkId: "ad-sold-out", severity: "low" });
    expect(out.findings[0]?.evidence).toContain("Medium, Extra large");
    expect(out.findings[0]?.evidence).toContain("2 of 4");
  });

  it("an in-stock product passes both checks", async () => {
    const { out } = await run(["/products/amber-tin"]);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(
      expect.arrayContaining(["ad-dead-page", "ad-sold-out", "placeholder-text"]),
    );
  });

  it("a non-Shopify page under /products/ makes no stock request", async () => {
    const site = await startFixture("ad-shop");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const groups = groupByDestination([
        { link: `${site.origin}/products/field-notes`, spend: 500, currency: "USD" },
      ]);
      const out = await checkAdLandingPages(groups, { fetcher });
      expect(out.findings).toEqual([]);
      expect(site.total).toBe(1);
      expect(site.hits.get("/products/field-notes.js")).toBeUndefined();
      // Nothing was asked about stock, so that check has not passed: it has not run.
      expect(out.passed).not.toContain("ad-sold-out");
      expect(out.passed).toContain("ad-dead-page");
    } finally {
      await site.close();
    }
  });

  it("the product endpoint answering with a page, 404 or no variants: no finding, one notice that stock could not be read", async () => {
    for (const path of [
      "/products/html-endpoint",
      "/products/no-endpoint",
      "/products/empty-variants",
    ]) {
      const { out } = await run([path]);
      expect(out.findings, path).toEqual([]);
      const notes = out.couldNotCheck.filter((n) => n.id === "ad-sold-out");
      expect(notes, path).toHaveLength(1);
      expect(notes[0]?.reason, path).toContain("stock could not be read");
      expect(out.passed, path).not.toContain("ad-sold-out");
    }
  });

  it("a destination that redirects to the store's home page with 200 is not dead, and gets a low note", async () => {
    const { out } = await run(["/products/old-wick"]);
    // The redirect also drops the tags (campaign-fields-lost); this is about the page.
    const mine = out.findings.filter((f) => f.checkId !== "campaign-fields-lost");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ checkId: "ad-dead-page", severity: "low" });
    expect(mine[0]?.evidence).toContain("no longer lands on a product");
    expect(mine[0]?.evidence).toContain("/products/old-wick");
  });

  it("a password-protected storefront is could-not-check, never dead", async () => {
    const { out } = await run(["/products/preview-candle"]);
    expect(out.findings.filter((f) => f.checkId !== "campaign-fields-lost")).toEqual([]);
    expect(out.couldNotCheck.filter((n) => n.id === "ad-dead-page")).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("password") }),
    ]);
    expect(out.passed).not.toContain("ad-dead-page");
  });

  it("theme sample text on a landing page is a medium finding from the existing placeholder check", async () => {
    const { out, site } = await run(["/products/sample-tin"]);
    expect(out.findings.map((f) => [f.checkId, f.severity, f.url])).toEqual([
      ["placeholder-text", "medium", `${site.origin}/products/sample-tin`],
    ]);
    expect(out.findings[0]?.evidence).toContain("Lorem ipsum");
    expect(out.findings[0]?.evidence).toContain("1 ad sends people to this page");
  });

  it("a page that does not load gets no placeholder or stock request", async () => {
    const site = await startFixture("ad-shop");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const out = await checkAdLandingPages(
        groupByDestination([{ link: `${site.origin}/products/retired-mug`, spend: 1 }]),
        { fetcher },
      );
      expect(out.findings.map((f) => f.checkId)).toEqual(["ad-dead-page"]);
      expect(site.total).toBe(1);
    } finally {
      await site.close();
    }
  });
});

// ---- integration: stand-in transports -------------------------------------------------------------

function standIn(
  routes: Record<string, { status?: number; body?: string; type?: string; location?: string }>,
) {
  const seen: { method: string; url: string }[] = [];
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    const r = routes[url.pathname] ?? { status: 404, body: "not found", type: "text/plain" };
    return Promise.resolve({
      status: r.status ?? 200,
      headers: {
        "content-type": r.type ?? "text/html",
        ...(r.location ? { location: r.location } : {}),
      },
      body: Readable.from([Buffer.from(r.body ?? "")]),
    });
  };
  return { transport, seen };
}

describe("checkAdLandingPages: two problems on one page, and the request count", () => {
  const soldOutSample =
    '<!doctype html><title>Oat candle</title><link href="https://cdn.shopify.com/x.css"><h1>Oat candle</h1><p>Lorem ipsum dolor sit amet.</p>';

  it("a sold-out product that still shows sample text has two findings and its spend counts once", async () => {
    const site = standIn({
      "/products/oat-candle": { body: soldOutSample },
      "/products/oat-candle.js": {
        type: "application/json",
        body: endpoint([{ id: 1, title: "Default Title", available: false }]),
      },
      "/other": { body: "<!doctype html><title>Other</title><p>Fine.</p>" },
    });
    const fetcher = createFetcher({ transport: site.transport });
    const groups = groupByDestination([
      { link: `${SHOP}/products/oat-candle`, spend: 7000, currency: "USD" },
      { link: `${SHOP}/other`, spend: 3000, currency: "USD" },
    ]);
    const out = await checkAdLandingPages(groups, { fetcher });
    expect(out.findings.map((f) => f.checkId).sort()).toEqual(["ad-sold-out", "placeholder-text"]);
    const [usd] = summarise(groups, out.findings);
    expect(usd).toMatchObject({ totalSpend: 10000, spendOnProblemPages: 7000 });
    expect(usd?.byDestination[0]?.findings).toEqual(["ad-sold-out", "placeholder-text"]);
  });

  it("promise: at most two requests for any destination, all GET", async () => {
    const site = standIn({
      "/products/oat-candle": { body: soldOutSample.replace("Lorem ipsum", "Fine") },
      "/products/oat-candle.js": {
        type: "application/json",
        body: endpoint([{ id: 1, title: "Default Title", available: false }]),
      },
      "/gone": { status: 404 },
      "/about": {},
    });
    const fetcher = createFetcher({ transport: site.transport });
    const groups = groupByDestination([
      { link: `${SHOP}/products/oat-candle?utm_source=a`, spend: 1 },
      { link: `${SHOP}/products/oat-candle?utm_source=b`, spend: 1 },
      { link: `${SHOP}/gone`, spend: 1 },
      { link: `${SHOP}/about`, spend: 1 },
    ]);
    await checkAdLandingPages(groups, { fetcher });
    const perPage = new Map<string, number>();
    for (const r of site.seen) {
      const u = new URL(r.url);
      const key = u.pathname.replace(/\.js$/, "");
      perPage.set(key, (perPage.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
    expect(perPage.get("/products/oat-candle")).toBe(2);
    expect(site.seen.every((r) => r.method === "GET" || r.method === "HEAD")).toBe(true);
    expect(site.seen).toHaveLength(4);
  });

  it("a request that fails is dead; the page's failure is not asked about twice", async () => {
    const fetcher = createFetcher({
      transport: () => Promise.reject(new Error("offline")),
    });
    const out = await checkAdLandingPages(groupByDestination([{ link: `${SHOP}/a`, spend: 1 }]), {
      fetcher,
    });
    expect(out.findings.map((f) => [f.checkId, f.severity])).toEqual([["ad-dead-page", "high"]]);
    expect(out.findings[0]?.evidence).toContain("could not be reached");
    expect(fetcher.stats.requests).toBe(1);
  });

  it("a redirect into a private address is not a dead page", async () => {
    const refused = (): Promise<never> =>
      Promise.reject(new FetchError("private-address-refused", "refused", `${SHOP}/a`, []));
    const out = await checkAdLandingPages(groupByDestination([{ link: `${SHOP}/a`, spend: 1 }]), {
      fetcher: createFetcher({ transport: refused }),
    });
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck.map((n) => n.id)).toContain("ad-dead-page");
  });

  it("the same input gives the same findings", async () => {
    const make = () =>
      standIn({
        "/products/oat-candle": { body: soldOutSample },
        "/products/oat-candle.js": {
          type: "application/json",
          body: endpoint([{ id: 1, title: "Default Title", available: false }]),
        },
      });
    const groups = groupByDestination([{ link: `${SHOP}/products/oat-candle`, spend: 5 }]);
    const a = await checkAdLandingPages(groups, {
      fetcher: createFetcher({ transport: make().transport }),
    });
    const b = await checkAdLandingPages(groups, {
      fetcher: createFetcher({ transport: make().transport }),
    });
    expect(a.findings).toEqual(b.findings);
    expect(a.passed).toEqual(b.passed);
  });

  it("text from the shop is escaped in the evidence", async () => {
    const site = standIn({
      "/products/oat-candle": { body: soldOutSample.replace("Lorem ipsum", "Fine") },
      "/products/oat-candle.js": {
        type: "application/json",
        body: endpoint([
          { id: 1, title: "Small\u200B\u202E<script>alert(1)</script>", available: false },
          { id: 2, title: "Large", available: true },
        ]),
      },
    });
    const out = await checkAdLandingPages(
      groupByDestination([{ link: `${SHOP}/products/oat-candle`, spend: 5 }]),
      { fetcher: createFetcher({ transport: site.transport }) },
    );
    const text = out.findings[0]?.evidence ?? "";
    expect(text).not.toContain("\u200B");
    expect(text).not.toContain("\u202E");
    expect(text).toContain("\\u{200B}");
  });
});
