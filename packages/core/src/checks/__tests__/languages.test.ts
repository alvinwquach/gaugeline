import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import {
  isLanguageTag,
  languageMap,
  languageRulesSchema,
  pageKey,
  parsePrice,
  readLanguageGroup,
  type LanguageGroup,
  type LanguageRules,
} from "../../languages.js";
import { createBudget } from "../../limits.js";
import { parseSitemap } from "../../site-context.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { hreflangBadCode } from "../hreflang-bad-code.js";
import { hreflangNotReciprocal } from "../hreflang-not-reciprocal.js";
import { langAttrMismatch } from "../lang-attr-mismatch.js";
import { langPriceMismatch } from "../lang-price-mismatch.js";
import { langTwinMissing } from "../lang-twin-missing.js";
import { langUntranslated } from "../lang-untranslated.js";

const LANG_CHECKS = [
  "lang-twin-missing",
  "hreflang-not-reciprocal",
  "hreflang-bad-code",
  "lang-attr-mismatch",
  "lang-price-mismatch",
  "lang-untranslated",
];
const PREFIXES: LanguageRules = { prefixes: { en: "/", es: "/es/", fr: "/fr/" }, default: "en" };
const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A page at a URL with hreflang links, an html lang and an optional price. */
function at(
  url: string,
  opts: { lang?: string; alts?: [string, string][]; price?: string; body?: string } = {},
): PageSnapshot {
  const alts = (opts.alts ?? [])
    .map(([h, href]) => `<link rel="alternate" hreflang="${h}" href="${href}">`)
    .join("");
  const ld = opts.price
    ? `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku: "BOX", offers: { price: opts.price, priceCurrency: "USD" } })}</script>`
    : "";
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html${opts.lang ? ` lang="${opts.lang}"` : ""}><head>${alts}${ld}</head><body><main>${opts.body ?? ""}</main></body></html>`,
      ms: 1,
    },
  ]);
}

function group(
  lang: string,
  versions: { lang: string; page?: PageSnapshot; url: string; missing?: string }[],
): LanguageGroup {
  return {
    lang,
    urls: new Map(versions.map((v) => [v.lang, v.url])),
    versions: versions.map((v) => ({ hops: [], ...v })),
  };
}

const ctxOf = (g: LanguageGroup, rules?: LanguageRules) => ({
  warn: () => undefined,
  languages: async () => g,
  ...(rules ? { languageRules: rules } : {}),
});

describe("languages: unit", () => {
  it("pageKey stripping for prefix, subdomain and query-parameter schemes", () => {
    expect(pageKey("https://pop.example/es/menu/", PREFIXES)).toEqual({
      lang: "es",
      key: "pop.example/menu",
    });
    expect(pageKey("https://pop.example/menu", PREFIXES)).toEqual({
      lang: "en",
      key: "pop.example/menu",
    });
    expect(pageKey("https://pop.example/es", PREFIXES)).toEqual({
      lang: "es",
      key: "pop.example/",
    });
    const sub: LanguageRules = { subdomains: { es: "es." }, default: "en" };
    expect(pageKey("https://es.pop.example/menu", sub)).toEqual({
      lang: "es",
      key: "pop.example/menu",
    });
    expect(pageKey("https://pop.example/menu", sub)).toEqual({
      lang: "en",
      key: "pop.example/menu",
    });
    const param: LanguageRules = { param: "lang", default: "en" };
    expect(pageKey("https://pop.example/menu?lang=es&x=1", param)).toEqual({
      lang: "es",
      key: "pop.example/menu?x=1",
    });
    expect(
      languageMap(
        [
          { lang: "en", url: "https://pop.example/menu" },
          { lang: "es", url: "https://pop.example/es/menu/" },
        ],
        PREFIXES,
      ),
    ).toEqual(
      new Map([
        [
          "pop.example/menu",
          new Map([
            ["en", "https://pop.example/menu"],
            ["es", "https://pop.example/es/menu/"],
          ]),
        ],
      ]),
    );
  });

  it("reciprocity over a three-language map", async () => {
    const all: [string, string][] = [
      ["en", "https://pop.example/"],
      ["es", "https://pop.example/es/"],
      ["fr", "https://pop.example/fr/"],
    ];
    const en = at("https://pop.example/", { alts: all });
    const es = at("https://pop.example/es/", { alts: all });
    const fr = at("https://pop.example/fr/", { alts: all.filter(([h]) => h !== "en") });
    const g = group("en", [
      { lang: "es", url: "https://pop.example/es/", page: es },
      { lang: "fr", url: "https://pop.example/fr/", page: fr },
    ]);
    expect((await hreflangNotReciprocal.run(en, ctxOf(g)))[0]?.evidence).toBe(
      "/ points to fr /fr/, which does not point back",
    );
  });

  it("BCP 47 validation table (es, es-US, es-419, en-GB, bad: sp, es_US)", () => {
    for (const ok of ["es", "es-US", "es-419", "en-GB", "zh-Hant-TW", "x-default", "fil"])
      expect(isLanguageTag(ok), ok).toBe(true);
    for (const bad of ["sp", "es_US", "english", "e", "es-", ""])
      expect(isLanguageTag(bad), bad).toBe(false);
    const p = at("https://pop.example/", {
      alts: [
        ["sp", "/es/"],
        ["es_US", "/us/"],
        ["en", "/"],
      ],
    });
    expect(hreflangBadCode.run(p, { warn: () => undefined })).toEqual([
      expect.objectContaining({
        evidence: 'not valid language tags: "sp", "es_US"; 3 languages and no x-default',
      }),
    ]);
  });

  it("sitemap xhtml:link alternates are read per url", () => {
    const xml = `<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://pop.example/</loc><xhtml:link rel="alternate" hreflang="es" href="https://pop.example/es/"/></url></urlset>`;
    expect(parseSitemap(xml).alternates).toEqual([
      { loc: "https://pop.example/", hreflang: "es", href: "https://pop.example/es/" },
    ]);
  });

  it("the settings schema accepts the documented shape", () => {
    expect(
      languageRulesSchema.safeParse({
        ...PREFIXES,
        exclude: ["/press/*"],
        untranslated: ["Order now"],
      }).success,
    ).toBe(true);
    expect(languageRulesSchema.safeParse({ prefix: { en: "/" } }).success).toBe(false);
  });

  it("lang-attr-mismatch and lang-untranslated", async () => {
    const es = at("https://pop.example/es/", {
      lang: "en",
      body: '<a href="/es/pedir">Order now</a>',
    });
    const g = group("en", [{ lang: "es", url: "https://pop.example/es/", page: es }]);
    const en = at("https://pop.example/", { lang: "en-US" });
    expect((await langAttrMismatch.run(en, ctxOf(g)))[0]?.evidence).toBe(
      '/es/ is es but has lang="en"',
    );
    expect(
      (await langUntranslated.run(en, ctxOf(g, { untranslated: ["Order now"] })))[0]?.evidence,
    ).toBe('1 untranslated: "Order now" on /es/ (es)');
  });
});

describe("languages: integration (fixture site)", () => {
  it("bilingual-popup: one missing twin and one price that differs", async () => {
    const site = await startFixture("bilingual-popup");
    try {
      const languageRules = languageRulesSchema.parse(
        JSON.parse(readFileSync(`${SITES_DIR}bilingual-popup/gaugeline.languages.json`, "utf8")),
      );
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const { result, budget } = await checkSite({
        address: site.origin,
        fetcher,
        only: LANG_CHECKS,
        languageRules,
      });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        ["lang-price-mismatch", "TAMAL-BOX: 12.00 USD on / (en), 14 USD on /es/ (es)"],
        ["lang-twin-missing", "1 of 2 language versions are missing: fr /fr/ returned 404"],
      ]);
      expect(budget.summary().languageVersions).toEqual({ limit: 5, sampled: 2, found: 2 });
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("languages: edge cases", () => {
  it("a twin that redirects to the home page is reported as missing, with the redirect in evidence", async () => {
    const send = (body: string) => (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/html" }).end(body);
    };
    const server = await startServer({
      "/menu": send('<html lang="en"><title>Menu</title></html>'),
      "/es/menu": (_req, res) => {
        res.writeHead(301, { location: "/es/" }).end();
      },
      "/es/": send('<html lang="es"><title>Inicio</title></html>'),
    });
    servers.push(server);
    const g = await readLanguageGroup({
      page: at(`${server.origin}/menu`),
      fetcher: createFetcher({ allowPrivate: true }),
      budget: createBudget(),
      rules: { prefixes: { en: "/", es: "/es/" }, default: "en" },
    });
    expect(g.versions.map((v) => [v.lang, v.missing])).toEqual([["es", "redirects to /es/"]]);
  });

  it("trailing-slash differences between twins are not a reciprocity problem", async () => {
    const en = at("https://pop.example/menu/", { alts: [["es", "https://pop.example/es/menu"]] });
    const es = at("https://pop.example/es/menu", { alts: [["en", "https://pop.example/menu"]] });
    const g = group("en", [{ lang: "es", url: "https://pop.example/es/menu", page: es }]);
    expect(await hreflangNotReciprocal.run(en, ctxOf(g))).toEqual([]);
  });

  it('prices with "$12", "12 USD" and "$12.00" compare equal', async () => {
    expect([
      parsePrice("$12"),
      parsePrice("12 USD"),
      parsePrice("$12.00"),
      parsePrice("12,00 €"),
      parsePrice("1,299.50"),
    ]).toEqual([12, 12, 12, 12, 1299.5]);
    const en = at("https://pop.example/", { price: "$12" });
    const g = group("en", [
      {
        lang: "es",
        url: "https://pop.example/es/",
        page: at("https://pop.example/es/", { price: "12 USD" }),
      },
      {
        lang: "fr",
        url: "https://pop.example/fr/",
        page: at("https://pop.example/fr/", { price: "$12.00" }),
      },
    ]);
    expect(await langPriceMismatch.run(en, ctxOf(g))).toEqual([]);
  });

  it("prices on some versions only are could-not-check; no prices anywhere is nothing to compare", async () => {
    const g = group("en", [
      { lang: "es", url: "https://pop.example/es/", page: at("https://pop.example/es/") },
    ]);
    await expect(
      langPriceMismatch.run(at("https://pop.example/", { price: "$12" }), ctxOf(g)),
    ).rejects.toThrow(
      "No prices in structured data on the es version, so prices could not be compared",
    );
    expect(await langPriceMismatch.run(at("https://pop.example/"), ctxOf(g))).toEqual([]);
  });

  it("a page intentionally single-language (configured exclude list) is not lang-twin-missing", async () => {
    const g = group("en", [
      { lang: "es", url: "https://pop.example/es/press/kit", missing: "returned 404" },
    ]);
    const p = at("https://pop.example/press/kit");
    expect(await langTwinMissing.run(p, ctxOf(g, { ...PREFIXES, exclude: ["/press/*"] }))).toEqual(
      [],
    );
    expect(await langTwinMissing.run(p, ctxOf(g, PREFIXES))).toHaveLength(1);
  });
});
