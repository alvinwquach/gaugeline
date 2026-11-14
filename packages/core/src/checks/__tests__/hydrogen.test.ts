import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import {
  decodeTurbo,
  devMarkers,
  embeddedVariantPrice,
  isHydrogenSite,
  isPreviewHost,
  privateNames,
  readEmbedded,
} from "../../hydrogen/detect.js";
import { exponentOf, machineMinor, shownMinor } from "../../hydrogen/money.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { hydrogenDevToolsLive } from "../hydrogen-dev-tools-live.js";
import { hydrogenPreviewCanonical } from "../hydrogen-preview-canonical.js";
import { hydrogenPreviewIndexable } from "../hydrogen-preview-indexable.js";
import { hydrogenPricesDisagree } from "../hydrogen-prices-disagree.js";
import { remixDevToolsLive } from "../remix-dev-tools-live.js";
import { hydrogenPrivateFields } from "../hydrogen-private-fields.js";
import { frameworkCoversDevTools } from "../../framework-dev-tools.js";

const IDS = [
  "hydrogen-preview-canonical",
  "hydrogen-preview-indexable",
  "hydrogen-private-fields",
  "hydrogen-prices-disagree",
  "hydrogen-dev-tools-live",
];
const H = { "powered-by": "Shopify, Hydrogen" };
const URL0 = "https://studio.example/products/mug";

function page(url: string, body: string, headers: Record<string, string> = H, truncated = false) {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html", ...headers },
      body,
      ms: 1,
      ...(truncated ? { truncated: true } : {}),
    },
  ]);
}

/** A small turbo-stream writer: the flat array React Router writes (objects are {"_<keyIndex>": valueIndex}). */
function turbo(input: unknown): string {
  const out: unknown[] = [];
  const strings = new Map<string, number>();
  const idx = (v: unknown): number => {
    if (v === null) return -5;
    if (typeof v === "string" && strings.has(v)) return strings.get(v) as number;
    const i = out.length;
    out.push(null);
    if (typeof v === "string") strings.set(v, i);
    if (Array.isArray(v)) out[i] = v.map(idx);
    else if (typeof v === "object") {
      const o: Record<string, number> = {};
      for (const [k, c] of Object.entries(v as object)) o[`_${idx(k)}`] = idx(c);
      out[i] = o;
    } else out[i] = v;
    return i;
  };
  idx(input);
  return JSON.stringify(out);
}
const rr7 = (state: unknown) =>
  `<script>window.__reactRouterContext = {"basename":"/","ssr":true};window.__reactRouterContext.stream = new ReadableStream({});</script><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(`${turbo(state)}\n`)});</script>`;
const productState = (amount: string, currencyCode = "USD") => ({
  loaderData: {
    "routes/products.$handle": {
      data: {
        product: {
          title: "Mug",
          selectedOrFirstAvailableVariant: {
            price: { amount, currencyCode },
            compareAtPrice: { amount: "60.0", currencyCode },
          },
        },
      },
    },
  },
});
const ld = (price: string | number, currency = "USD") =>
  `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", offers: { "@type": "Offer", price, priceCurrency: currency } })}</script>`;
const shown = (html: string) =>
  `<div aria-label="Price" class="product-price" role="group">${html}</div>`;

const hop = (url: string, status: number, headers: Record<string, string>, body: string): Hop => ({
  url,
  status,
  headers,
  body,
  ms: 1,
});
function ctxFor(answers: Record<string, Hop[]> = {}, asked: string[] = []) {
  const unread: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    budget: createBudget(),
    couldNotCheck: (_u, r) => unread.push(r),
    fetcher: {
      get: async (url: string) => {
        asked.push(url);
        return answers[url] ?? [hop(url, 404, {}, "")];
      },
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    },
  };
  return { ctx, unread };
}

describe("hydrogen: unit", () => {
  it("a storefront is recognised from the header Hydrogen sets, or React Router's context beside Shopify's CDN", () => {
    expect(isHydrogenSite(page(URL0, "<p>x</p>"))).toBe(true);
    const ctxOnly = rr7({ a: 1 });
    expect(isHydrogenSite(page(URL0, ctxOnly, {}))).toBe(false);
    expect(
      isHydrogenSite(
        page(URL0, `<script src="https://cdn.shopify.com/x.js"></script>${ctxOnly}`, {}),
      ),
    ).toBe(true);
    expect(isHydrogenSite(page(URL0, "<p>__reactRouterContext = 1</p>", {}))).toBe(false);
    expect(isHydrogenSite(page(URL0, "<p>x</p>", { "powered-by": "Express" }))).toBe(false);
  });

  it("preview hosts are the Oxygen suffixes and the common temporary hosts, never the bare suffix", () => {
    expect(isPreviewHost("store-4f2a.o2.myshopify.dev")).toBe(true);
    expect(isPreviewHost("store.myshopify.dev.")).toBe(true);
    expect(isPreviewHost("x.vercel.app")).toBe(true);
    expect(isPreviewHost("myshopify.dev")).toBe(false);
    expect(isPreviewHost("shop.example")).toBe(false);
    expect(isPreviewHost("evilmyshopify.dev")).toBe(false);
  });

  it("the turbo-stream decoder rebuilds objects and arrays, and reads the variant price", () => {
    const e = readEmbedded(page(URL0, rr7(productState("48.0"))));
    expect(e?.marker).toBe("__reactRouterContext");
    expect(e?.names).toEqual(
      expect.arrayContaining(["product", "price", "amount", "currencyCode"]),
    );
    expect(embeddedVariantPrice(e)).toEqual({ amount: "48.0", currency: "USD" });
    expect(decodeTurbo('["a"]')).toBe("a");
    expect(decodeTurbo("[[1,2],10,20]")).toEqual([10, 20]);
  });

  it("the Remix v2 JSON context is read too", () => {
    const state = productState("12.5", "EUR");
    const body = `<script>window.__remixContext = ${JSON.stringify({ state: state })};</script>`;
    expect(embeddedVariantPrice(readEmbedded(page(URL0, body)))).toEqual({
      amount: "12.5",
      currency: "EUR",
    });
  });

  it("private names are matched by their words; the public storefront token and checkout domain are not private", () => {
    expect(
      privateNames([
        "privateStorefrontToken",
        "SESSION_SECRET",
        "apiKey",
        "storefrontAccessToken",
        "checkoutDomain",
        "publicStorefrontApiToken",
        "tokenizer",
        "title",
      ]),
    ).toEqual(["privateStorefrontToken", "SESSION_SECRET", "apiKey"]);
  });

  it("dev server markers come from the page", () => {
    expect(devMarkers(page(URL0, '<script type="module" src="/@vite/client"></script>'))).toEqual([
      "/@vite/client",
    ]);
    expect(devMarkers(page(URL0, "<p>Hello</p>"))).toEqual([]);
  });

  it("money is integers in minor units with the currency's exponent", () => {
    expect([exponentOf("JPY"), exponentOf("usd"), exponentOf("BHD")]).toEqual([0, 2, 3]);
    expect(machineMinor("48.0", "USD")).toBe(4800);
    expect(machineMinor("4800", "JPY")).toBe(4800);
    expect(machineMinor("4800.0", "JPY")).toBe(4800);
    expect(machineMinor("4800.5", "JPY")).toBeUndefined();
    expect(machineMinor("12.345", "BHD")).toBe(12345);
    expect(machineMinor("0.1", "USD")).toBe(10);
    expect(machineMinor("1e21", "USD")).toBeUndefined();
    expect(machineMinor("-5", "USD")).toBeUndefined();
    expect(shownMinor("$38.00", "USD")).toEqual({ minor: 3800 });
    expect(shownMinor("$1,200.50", "USD")).toEqual({ minor: 120050 });
    expect(shownMinor("48,00 EUR", "EUR")).toEqual({ minor: 4800, currency: "EUR" });
    expect(shownMinor("\u00A34.50", "GBP")).toEqual({ minor: 450, currency: "GBP" });
    expect(shownMinor("JPY 4,800", "JPY")).toEqual({ minor: 4800, currency: "JPY" });
    expect(shownMinor("BHD 12.500", "BHD")).toEqual({ minor: 12500, currency: "BHD" });
    expect(shownMinor("$38.00 $40.00", "USD")).toBeUndefined();
    expect(shownMinor("Sold out", "USD")).toBeUndefined();
    expect(shownMinor("$12.5", "USD")).toBeUndefined();
  });
});

describe("hydrogen: checks", () => {
  it("preview canonical: a production page whose canonical, og:url, og:image or sitemap is a preview", async () => {
    const body = `<link rel="canonical" href="https://shop-4f2a.o2.myshopify.dev/"><meta property="og:url" content="https://shop.myshopify.dev/"><meta property="og:image" content="https://x.vercel.app/a.png">`;
    const f = await hydrogenPreviewCanonical.run(page("https://shop.example/", body), {
      warn: () => undefined,
      site: async () => ({ sitemapUrls: ["https://shop-4f2a.o2.myshopify.dev/p"] }) as never,
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toMatch(/canonical https:\/\/shop-4f2a\.o2\.myshopify\.dev\//);
    expect(f[0]?.evidence).toMatch(/og:url/);
    expect(f[0]?.evidence).toMatch(/og:image/);
    expect(f[0]?.evidence).toMatch(/the sitemap lists/);
    // A page that is itself on a preview host, or an ordinary canonical, is silent.
    const quiet = { warn: () => undefined };
    expect(
      await hydrogenPreviewCanonical.run(page("https://shop-4f2a.o2.myshopify.dev/", body), quiet),
    ).toEqual([]);
    expect(
      await hydrogenPreviewCanonical.run(
        page("https://shop.example/", '<link rel="canonical" href="https://shop.example/">'),
        quiet,
      ),
    ).toEqual([]);
  });

  it("preview indexable: a linked preview that answers 200 with no noindex is found; noindex, sign-in and 404 are not", async () => {
    const link = (h: string) => `<a href="https://${h}/">preview</a>`;
    const open = "a-1.o2.myshopify.dev";
    const meta = "b-2.o2.myshopify.dev";
    const header = "c-3.o2.myshopify.dev";
    const gated = "d-4.o2.myshopify.dev";
    const gone = "e-5.o2.myshopify.dev";
    const dead = "f-6.o2.myshopify.dev";
    const html = { "content-type": "text/html" };
    const asked: string[] = [];
    const { ctx, unread } = ctxFor(
      {
        [`https://${open}/`]: [hop(`https://${open}/`, 200, html, "<p>hi</p>")],
        [`https://${meta}/`]: [
          hop(`https://${meta}/`, 200, html, '<meta name="robots" content="noindex, nofollow">'),
        ],
        [`https://${header}/`]: [
          hop(`https://${header}/`, 200, { ...html, "x-robots-tag": "noindex" }, "<p>hi</p>"),
        ],
        [`https://${gated}/`]: [hop(`https://${gated}/`, 401, {}, "sign in")],
        [`https://${gone}/`]: [hop(`https://${gone}/`, 404, {}, "")],
        [`https://${dead}/`]: [],
      },
      asked,
    );
    const body = [dead, open, meta, header, gated].map(link).join("");
    const f = await hydrogenPreviewIndexable.run(page("https://shop.example/", body), ctx);
    expect(f.map((x) => x.evidence)).toEqual([
      `https://${open} answers 200 with no noindex (linked from this page)`,
    ]);
    expect(unread.join()).toMatch(/did not answer/);
    const again = ctxFor({ [`https://${gone}/`]: [hop(`https://${gone}/`, 404, {}, "")] });
    expect(
      await hydrogenPreviewIndexable.run(page("https://shop.example/", link(gone)), again.ctx),
    ).toEqual([]);
    // Only the preview roots were asked, GET only through the fetcher, nothing else.
    expect(asked.every((a) => a.endsWith("/") && a.includes("o2.myshopify.dev"))).toBe(true);
  });

  it("preview indexable: the page checked, when it is itself a preview, is judged without a request", async () => {
    const { ctx } = ctxFor();
    const asked: string[] = [];
    const again = ctxFor({}, asked).ctx;
    const url = "https://s-1.o2.myshopify.dev/";
    expect(await hydrogenPreviewIndexable.run(page(url, "<p>hi</p>"), ctx)).toHaveLength(1);
    expect(
      await hydrogenPreviewIndexable.run(
        page(url, '<meta name="robots" content="noindex">'),
        again,
      ),
    ).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("private fields: a private token is found by name, the public token beside it is not, values never shown", async () => {
    const state = {
      loaderData: {
        root: {
          data: {
            consent: { checkoutDomain: "c.example", storefrontAccessToken: "pub-value" },
            privateStorefrontToken: "secret-value-xyz",
          },
        },
      },
    };
    const { ctx } = ctxFor();
    const f = await hydrogenPrivateFields.run(page(URL0, rr7(state)), ctx);
    expect(f.map((x) => x.evidence)).toEqual([
      "__reactRouterContext has privateStorefrontToken (field names only)",
    ]);
    expect(JSON.stringify(f)).not.toMatch(/secret-value-xyz|pub-value/);
    const clean = await hydrogenPrivateFields.run(
      page(URL0, rr7({ consent: { storefrontAccessToken: "pub-value" } })),
      ctxFor().ctx,
    );
    expect(clean).toEqual([]);
  });

  it("prices: the shown price, JSON-LD, meta and embedded price are compared in minor units", async () => {
    const body = (state: string, json: string, price = "$38.00") =>
      `<meta property="product:price:amount" content="38.00"><meta property="product:price:currency" content="USD">${json}${shown(`<div>${price}<s>$60.00</s></div>`)}${rr7(productState(state))}`;
    const run = async (html: string) => {
      const { ctx, unread } = ctxFor();
      return { f: await hydrogenPricesDisagree.run(page(URL0, html), ctx), unread };
    };
    const agree = await run(body("38.0", ld("38.00")));
    expect(agree.f).toEqual([]);
    // The checkout comparison is never made and says why.
    expect(agree.unread.join()).toMatch(/needs a cart, which Gaugeline will not create/);
    const bad = await run(body("38.0", ld("36.00")));
    expect(bad.f.map((x) => x.evidence)).toEqual([
      "the page shows 38.00 but the product data 36.00 USD",
    ]);
    const stale = await run(body("34.0", ld("38"), "$38.00"));
    expect(stale.f[0]?.evidence).toBe("the page shows 38.00 but the page's state 34.00 USD");
    const numeric = await run(body("38.0", ld(38.0)));
    expect(numeric.f).toEqual([]);
  });

  it("prices: currencies are compared and never converted; JPY and BHD keep their exponent", async () => {
    const mixed = page(
      URL0,
      `${ld("38.00", "EUR")}${shown("<div>$38.00</div>")}${rr7(productState("38.0", "USD"))}`,
    );
    const f = await hydrogenPricesDisagree.run(mixed, ctxFor().ctx);
    expect(f.map((x) => x.evidence)).toEqual([
      "the page shows USD but the product data EUR (amounts are not converted)",
    ]);
    const jpy = page(
      URL0,
      `${ld("4800", "JPY")}${shown("<div>JPY 4,800</div>")}${rr7(productState("4800.0", "JPY"))}`,
    );
    expect(await hydrogenPricesDisagree.run(jpy, ctxFor().ctx)).toEqual([]);
    const jpyOff = page(
      URL0,
      `${ld("480", "JPY")}${shown("<div>JPY 4,800</div>")}${rr7(productState("4800.0", "JPY"))}`,
    );
    expect((await hydrogenPricesDisagree.run(jpyOff, ctxFor().ctx)).map((x) => x.evidence)).toEqual(
      ["the page shows 4800 but the product data 480 JPY"],
    );
    const bhd = page(
      URL0,
      `${ld("12.500", "BHD")}${shown("<div>BHD 12.500</div>")}${rr7(productState("12.5", "BHD"))}`,
    );
    expect(await hydrogenPricesDisagree.run(bhd, ctxFor().ctx)).toEqual([]);
  });

  it("prices: fewer than two readable prices on a product page is could not check, never a pass", async () => {
    const { ctx, unread } = ctxFor();
    expect(await hydrogenPricesDisagree.run(page(URL0, "<p>Mug</p>"), ctx)).toEqual([]);
    expect(unread.join()).toMatch(/fewer than two prices/);
    const other = ctxFor();
    await hydrogenPricesDisagree.run(page("https://studio.example/about", "<p>Hi</p>"), other.ctx);
    expect(other.unread).toEqual([]);
  });

  it("dev tools: the Vite client on a Hydrogen page is found", async () => {
    const f = await hydrogenDevToolsLive.run(
      page(URL0, '<script type="module" src="/@vite/client"></script>'),
      ctxFor().ctx,
    );
    expect(f.map((x) => x.evidence)).toEqual(["the page carries /@vite/client"]);
  });
});

describe("hydrogen: integration", () => {
  it("the hydrogen-like fixture produces each finding, and only GET and HEAD leave the machine", async () => {
    const site = await startFixture("hydrogen-like");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const { result } = await checkSite({ address: site.origin, fetcher, only: IDS });
      const by = Object.fromEntries(result.findings.map((f) => [f.checkId, f.evidence]));
      expect(Object.keys(by).sort()).toEqual([
        "hydrogen-preview-canonical",
        "hydrogen-prices-disagree",
        "hydrogen-private-fields",
      ]);
      expect(by["hydrogen-private-fields"]).toBe(
        "__reactRouterContext has privateStorefrontToken (field names only)",
      );
      expect(by["hydrogen-prices-disagree"]).toBe(
        "the page shows 38.00 but the product data 36.00 USD",
      );
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
      expect(JSON.stringify(result.couldNotCheck)).toMatch(/needs a cart/);
    } finally {
      await site.close();
    }
  });

  it("a linked preview deployment that answers without noindex is found, with GET only", async () => {
    const site = await startFixture("hydrogen-preview-link");
    try {
      const fetcher = createFetcher({ allowPrivate: true, hosts: site.hosts });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: ["hydrogen-preview-indexable"],
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "http://marrowlane-preview-4f2a.o2.myshopify.dev answers 200 with no noindex (linked from this page)",
      ]);
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("a development server is found from the page alone", async () => {
    const site = await startFixture("hydrogen-dev");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["hydrogen-dev-tools-live"],
      });
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "the page carries /@vite/client, inject-hmr-runtime",
      ]);
    } finally {
      await site.close();
    }
  });
});

describe("hydrogen: edge cases", () => {
  it("on a site that isn't Hydrogen every check is silent and nothing is requested", async () => {
    const asked: string[] = [];
    const { ctx, unread } = ctxFor({}, asked);
    const plain = page(
      "https://x.example/products/a",
      '<link rel="canonical" href="https://x.vercel.app/"><a href="https://y.o2.myshopify.dev/">p</a>',
      {},
    );
    for (const c of [
      hydrogenPreviewCanonical,
      hydrogenPreviewIndexable,
      hydrogenPrivateFields,
      hydrogenPricesDisagree,
      hydrogenDevToolsLive,
    ])
      expect(await c.run(plain, ctx), c.id).toEqual([]);
    expect(asked).toEqual([]);
    expect(unread).toEqual([]);
  });

  it("a hostile turbo-stream (cycle, __proto__ keys, deep, huge, not an array) is read without a hang or pollution", () => {
    const cyc = decodeTurbo('[{"_1":0,"_2":0},"__proto__","constructor"]');
    expect(cyc instanceof Map ? [...cyc.keys()] : []).toEqual(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const deep = Array.from({ length: 20_000 }, (_, i) => ({ _0: i + 1 }));
    expect(decodeTurbo(JSON.stringify(["k", ...deep]))).not.toBeUndefined();
    expect(decodeTurbo("x".repeat(500_000))).toBeUndefined();
    expect(decodeTurbo("{not json")).toBeUndefined();
    expect(decodeTurbo("[]")).toBeUndefined();
    expect(decodeTurbo('["D",1]')).toBe("D");
    expect(decodeTurbo('[["D",1],0]')).toBeNull();
  });

  it("a JSON context with __proto__ keys and lone surrogates does not pollute and still names its keys", () => {
    const body = `<script>window.__remixContext = {"state":{"__proto__":{"polluted":1},"constructor":2,"a\\ud800":3,"password":"x"}};</script>`;
    const e = readEmbedded(page(URL0, body));
    expect(e?.names).toEqual(expect.arrayContaining(["__proto__", "constructor", "password"]));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(embeddedVariantPrice(e)).toBeUndefined();
  });

  it("a huge context, a truncated page, a bad stream and deferred chunks are could not check, never a pass", async () => {
    const huge = `<script>window.__reactRouterContext = {"s":"${"a".repeat(450_000)}"}</script>`;
    const a = ctxFor();
    expect(await hydrogenPrivateFields.run(page(URL0, huge), a.ctx)).toEqual([]);
    expect(a.unread.join()).toMatch(/not closed within/);
    const cut = page(
      URL0,
      '<script>window.__reactRouterContext = {"state":{"password":"x"',
      H,
      true,
    );
    const b = ctxFor();
    expect(await hydrogenPrivateFields.run(cut, b.ctx)).toEqual([]);
    expect(b.unread.join()).toMatch(/cut before its embedded state ended/);
    const garbage = page(
      URL0,
      '<script>window.__reactRouterContext = {"ssr":true};window.__reactRouterContext.streamController.enqueue("not turbo\\n");</script>',
    );
    const c = ctxFor();
    expect(await hydrogenPrivateFields.run(garbage, c.ctx)).toEqual([]);
    expect(c.unread.join()).toMatch(/not turbo-stream/);
    const deferred = page(
      URL0,
      `${rr7({ title: "x" })}<script>window.__reactRouterContext.streamController.enqueue("P5:[1]\\n");</script>`,
    );
    const d = ctxFor();
    expect(await hydrogenPrivateFields.run(deferred, d.ctx)).toEqual([]);
    expect(d.unread.join()).toMatch(/deferred values/);
  });

  it("a price that is not a plain decimal, or an amount with a lone surrogate, is unread rather than guessed", async () => {
    const odd = page(
      URL0,
      `${ld("38.00 USD")}${shown("<div>\ud800$38.00</div>")}${rr7(productState("NaN"))}`,
    );
    const { ctx, unread } = ctxFor();
    expect(await hydrogenPricesDisagree.run(odd, ctx)).toEqual([]);
    expect(unread.join()).toMatch(/fewer than two prices/);
  });

  it("many preview links ask only up to the budget, once per address", async () => {
    const asked: string[] = [];
    const { ctx } = ctxFor({}, asked);
    const links = Array.from(
      { length: 30 },
      (_, i) => `<a href="https://p${i}.o2.myshopify.dev/">x</a>`,
    ).join("");
    await hydrogenPreviewIndexable.run(page("https://shop.example/", links + links), ctx);
    expect(asked.length).toBeLessThanOrEqual(5);
    expect(new Set(asked).size).toBe(asked.length);
  });
});

describe("hydrogen-dev-tools-live and remix-dev-tools-live: one dev server, one report", () => {
  const VITE = '<script type="module" src="/@vite/client"></script>';
  const CONTEXT = '<script>window.__reactRouterContext = {"basename":"/","ssr":true};</script>';
  const reports = async (p: ReturnType<typeof page>): Promise<string[]> => {
    const ids: string[] = [];
    for (const check of [hydrogenDevToolsLive, remixDevToolsLive])
      for (const f of await check.run(p, ctxFor().ctx)) ids.push(f.checkId);
    return ids;
  };

  it("a React Router 7 site that is not Hydrogen is the Remix check's alone", async () => {
    // No Hydrogen header and nothing from Shopify's CDN: React Router's context beside Vite's client is a Remix page.
    const p = page(URL0, `${VITE}${CONTEXT}`, {});
    expect(isHydrogenSite(p)).toBe(false);
    expect(await hydrogenDevToolsLive.run(p, ctxFor().ctx)).toEqual([]);
    expect(await reports(p)).toEqual(["remix-dev-tools-live"]);
    expect(frameworkCoversDevTools(p)).toBe(true);
  });

  it("a Hydrogen storefront (the header) on a dev server is the Hydrogen check's alone", async () => {
    const p = page(URL0, `${VITE}${CONTEXT}`, H);
    expect(await reports(p)).toEqual(["hydrogen-dev-tools-live"]);
    expect(frameworkCoversDevTools(p)).toBe(true);
  });

  it("a Hydrogen storefront with no header, known by Shopify's CDN beside the context, is Hydrogen's alone", async () => {
    const p = page(
      URL0,
      `<script src="https://cdn.shopify.com/s/files/x.js"></script>${VITE}${CONTEXT}`,
      {},
    );
    expect(await reports(p)).toEqual(["hydrogen-dev-tools-live"]);
  });

  it("Vite's client on a page that is neither Hydrogen nor React Router is neither check's", async () => {
    const p = page(URL0, `${VITE}<main>Hi</main>`, {});
    expect(await reports(p)).toEqual([]);
  });

  it("a Hydrogen page with no dev markers is not reported by either, and a built React Router page is not either", async () => {
    expect(await reports(page(URL0, CONTEXT, H))).toEqual([]);
    expect(await reports(page(URL0, CONTEXT, {}))).toEqual([]);
  });
});
