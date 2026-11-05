import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import {
  flattenSchema,
  matchTemplate,
  normaliseId,
  schemaRulesSchema,
  type SchemaRules,
} from "../../schema-rules.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { schemaBreadcrumbMismatch } from "../schema-breadcrumb-mismatch.js";
import { schemaBreadcrumbStart } from "../schema-breadcrumb-start.js";
import { schemaDanglingRef } from "../schema-dangling-ref.js";
import { schemaIdDrift } from "../schema-id-drift.js";
import { schemaOrgRedefined } from "../schema-org-redefined.js";
import { schemaTemplateMissingType } from "../schema-template-missing-type.js";

const SCHEMA_CHECKS = [
  "schema-org-redefined",
  "schema-id-drift",
  "schema-template-missing-type",
  "schema-breadcrumb-start",
  "schema-breadcrumb-mismatch",
  "schema-dangling-ref",
];
const RULES: SchemaRules = {
  organizationId: "https://clinic.example/#organization",
  websiteId: "https://clinic.example/#website",
  templates: [
    { match: "/blog/*", require: ["Article", "WebPage", "BreadcrumbList"] },
    { match: "/**", require: ["WebPage"] },
  ],
  breadcrumbs: { firstName: "Home", firstUrl: "/" },
};

/** A snapshot at a path with JSON-LD blocks (raw strings are put in as written). */
function at(path: string, ...blocks: (object | string)[]): PageSnapshot {
  const scripts = blocks
    .map(
      (b) =>
        `<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`,
    )
    .join("");
  return buildSnapshot([
    {
      url: `https://clinic.example${path}`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><link rel="canonical" href="https://clinic.example${path}">${scripts}</head><body></body></html>`,
      ms: 1,
    },
  ]);
}

/** A check context over a set of pages, the first being the checked one. */
function over(pages: PageSnapshot[], rules?: SchemaRules) {
  const warnings: string[] = [];
  return {
    ctx: {
      warn: (m: string) => warnings.push(m),
      pages: async () => pages,
      ...(rules ? { schemaRules: rules } : {}),
    },
    warnings,
  };
}

const ORG = {
  "@type": "Organization",
  "@id": "https://clinic.example/#organization",
  name: "Clinic",
  url: "/",
};
const crumbs = (...items: [string, string][]) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, item], i) => ({
    "@type": "ListItem",
    position: i + 1,
    name,
    item,
  })),
});

describe("schema rules: unit", () => {
  it("flattening: a single object, an array, a @graph, nested objects with their own @id", () => {
    const base = "https://clinic.example/blog/a";
    expect([...flattenSchema([ORG], base).byId.keys()]).toEqual([
      "https://clinic.example/#organization",
    ]);
    const flat = flattenSchema(
      [
        {
          "@graph": [
            {
              "@type": "WebPage",
              "@id": "/blog/a#webpage",
              publisher: { "@id": "/#organization" },
            },
            { "@type": "Article", author: { "@type": "Person", "@id": "/team/sam/", name: "Sam" } },
          ],
        },
        [{ "@type": "BreadcrumbList", itemListElement: [] }],
      ],
      base,
    );
    expect([...flat.byId.keys()].sort()).toEqual([
      "https://clinic.example/blog/a#webpage",
      "https://clinic.example/team/sam",
    ]);
    expect(flat.unnamed.map((n) => n.types[0]).sort()).toEqual(["Article", "BreadcrumbList"]);
    expect(flat.refs).toEqual([
      { id: "https://clinic.example/#organization", raw: "/#organization" },
    ]);
    expect([...flat.types].sort()).toEqual(["Article", "BreadcrumbList", "Person", "WebPage"]);
  });

  it("template matching with globs; the most specific template wins", () => {
    const templates = [
      { match: "/**", require: ["WebPage"] },
      { match: "/blog/*", require: ["Article"] },
      { match: "/blog/2026/*", require: ["NewsArticle"] },
    ];
    expect(matchTemplate("/blog/a", templates)?.match).toBe("/blog/*");
    expect(matchTemplate("/blog/2026/a", templates)?.match).toBe("/blog/2026/*");
    expect(matchTemplate("/blog/a/b", templates)?.match).toBe("/**");
    expect(matchTemplate("/blog/", templates)?.match).toBe("/blog/*");
    expect(matchTemplate("/clinics", [{ match: "/blog/*", require: ["x"] }])).toBeUndefined();
  });

  it("the config schema accepts the documented shape and rejects unknown keys", () => {
    expect(schemaRulesSchema.safeParse(RULES).success).toBe(true);
    expect(schemaRulesSchema.safeParse({ organisationId: "x" }).success).toBe(false);
  });

  it("schema-org-redefined: a referenced Organization passes; a redefined one fails", async () => {
    const pass = over(
      [at("/"), at("/about", { "@type": "WebPage", publisher: { "@id": RULES.organizationId } })],
      RULES,
    );
    expect(await schemaOrgRedefined.run(at("/"), pass.ctx)).toEqual([]);
    const fail = over([at("/"), at("/about", { ...ORG, telephone: "+1 503-555-0100" })], RULES);
    expect((await schemaOrgRedefined.run(at("/"), fail.ctx))[0]?.evidence).toBe(
      "/about defines Organization /#organization with name, url, telephone instead of referencing /#organization",
    );
  });

  it("schema-id-drift: the configured id passes; another id fails; without a guide, two ids across pages fail", async () => {
    expect(await schemaIdDrift.run(at("/"), over([at("/", ORG)], RULES).ctx)).toEqual([]);
    const other = { ...ORG, "@id": "https://clinic.example/#org" };
    expect((await schemaIdDrift.run(at("/"), over([at("/", other)], RULES).ctx))[0]?.evidence).toBe(
      'Organization @id "https://clinic.example/#org" on /; the schema guide says "https://clinic.example/#organization"',
    );
    const home = at("/", ORG);
    const noGuide = over([home, at("/about", other)]);
    expect((await schemaIdDrift.run(home, noGuide.ctx))[0]?.evidence).toBe(
      'Organization has 2 different @id values: "https://clinic.example/#organization" on /, "https://clinic.example/#org" on /about',
    );
  });

  it("schema-template-missing-type: a complete page passes; a missing BreadcrumbList fails", async () => {
    const full = at(
      "/blog/a",
      { "@type": "Article" },
      { "@type": "WebPage" },
      crumbs(["Home", "/"], ["A", "/blog/a"]),
    );
    expect(await schemaTemplateMissingType.run(full, over([full], RULES).ctx)).toEqual([]);
    const partial = at("/blog/b", { "@type": "Article" }, { "@type": "WebPage" });
    expect(
      (await schemaTemplateMissingType.run(partial, over([partial], RULES).ctx))[0]?.evidence,
    ).toBe('/blog/b matches "/blog/*" but has no BreadcrumbList');
  });

  it("schema-breadcrumb-start and schema-breadcrumb-mismatch: pass and fail", async () => {
    const good = at(
      "/clinics",
      crumbs(["Home", "https://clinic.example/"], ["Clinics", "/clinics"]),
    );
    expect(await schemaBreadcrumbStart.run(good, over([good], RULES).ctx)).toEqual([]);
    expect(await schemaBreadcrumbMismatch.run(good, over([good], RULES).ctx)).toEqual([]);
    const start = at("/clinics", crumbs(["Start", "/"], ["Clinics", "/clinics"]));
    expect((await schemaBreadcrumbStart.run(start, over([start], RULES).ctx))[0]?.evidence).toBe(
      '/clinics: the breadcrumb starts with "Start" at /; the guide says "Home" at /',
    );
    const elsewhere = at("/clinics", crumbs(["Home", "/"], ["Old clinics", "/locations"]));
    expect(
      (await schemaBreadcrumbMismatch.run(elsewhere, over([elsewhere], RULES).ctx))[0]?.evidence,
    ).toBe(
      "/clinics: the breadcrumb ends at /locations; the canonical is https://clinic.example/clinics",
    );
  });

  it("schema-dangling-ref: a reference defined on another page passes; an undefined one fails", async () => {
    const ref = at("/about", { "@type": "WebPage", publisher: { "@id": "/#organization" } });
    expect(await schemaDanglingRef.run(ref, over([ref, at("/", ORG)]).ctx)).toEqual([]);
    expect((await schemaDanglingRef.run(ref, over([ref]).ctx))[0]?.evidence).toBe(
      '/about refers to "/#organization", defined on none of the 1 pages checked',
    );
  });
});

describe("schema rules: integration (fixture site, invented Northwind Clinics)", () => {
  it("five pages: one redefines the Organization, one breadcrumb starts with Start, one lacks BreadcrumbList", async () => {
    const site = await startFixture("northwind");
    try {
      const raw = JSON.parse(
        readFileSync(`${SITES_DIR}northwind/gaugeline.schema.json`, "utf8"),
      ) as unknown;
      const schemaRules = schemaRulesSchema.parse(raw);
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const { result, budget } = await checkSite({
        address: site.origin,
        fetcher,
        only: SCHEMA_CHECKS,
        schemaRules,
      });
      expect(budget.summary().pages).toEqual({ limit: 4, sampled: 4, found: 4 });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        [
          "schema-org-redefined",
          "/about defines Organization /#organization with name, telephone instead of referencing /#organization",
        ],
        [
          "schema-template-missing-type",
          '/blog/new-clinic matches "/blog/*" but has no BreadcrumbList',
        ],
        [
          "schema-breadcrumb-start",
          '/blog/flu-season: the breadcrumb starts with "Start" at /; the guide says "Home" at /',
        ],
      ]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("schema rules: edge cases", () => {
  it("@id with and without a trailing slash or fragment: compared after normalisation, reported with both raw values", async () => {
    const base = "https://clinic.example/x";
    expect(normaliseId("https://Clinic.example/about/", base)).toBe(normaliseId("/about", base));
    expect(normaliseId("/about#org", base)).not.toBe(normaliseId("/about", base));
    const a = at("/", { ...ORG, "@id": "https://clinic.example/about/#org" });
    const b = at("/about", { ...ORG, "@id": "/about#org" });
    expect(await schemaIdDrift.run(a, over([a, b]).ctx)).toEqual([]);
    const rules = { organizationId: "https://clinic.example/#org" };
    expect((await schemaIdDrift.run(a, over([a, b], rules).ctx))[0]?.evidence).toBe(
      'Organization @id "https://clinic.example/about/#org", "/about#org" on /, /about; the schema guide says "https://clinic.example/#org"',
    );
  });

  it("JSON-LD that fails to parse is skipped by these checks, and they say so", async () => {
    const p = at("/blog/c", '{"@type": "Article",}', { "@type": "WebPage" });
    const { ctx, warnings } = over([p], RULES);
    expect((await schemaTemplateMissingType.run(p, ctx))[0]?.evidence).toBe(
      '/blog/c matches "/blog/*" but has no Article, BreadcrumbList',
    );
    expect(warnings).toContain(
      "schema-template-missing-type: 1 JSON-LD block on /blog/c did not parse and was skipped (see jsonld-invalid).",
    );
  });

  it("a site with no JSON-LD at all: one could-not-check outcome, not a finding per page", async () => {
    const pages = ["/", "/a", "/blog/b", "/blog/c"].map((path) => at(path));
    await expect(
      schemaTemplateMissingType.run(pages[0] as PageSnapshot, over(pages, RULES).ctx),
    ).rejects.toThrow("None of the checked pages has structured data");
    // With no guide, the two checks that run without one say nothing.
    expect(await schemaIdDrift.run(pages[0] as PageSnapshot, over(pages).ctx)).toEqual([]);
    expect(await schemaDanglingRef.run(pages[0] as PageSnapshot, over(pages).ctx)).toEqual([]);
  });

  it("relative @id values are resolved against the page URL", () => {
    const flat = flattenSchema(
      [{ "@type": "WebPage", "@id": "#webpage" }],
      "https://clinic.example/blog/a",
    );
    expect([...flat.byId.keys()]).toEqual(["https://clinic.example/blog/a#webpage"]);
  });

  it("with no schema config, only schema-id-drift and schema-dangling-ref run", async () => {
    const p = at("/about", { ...ORG, telephone: "x" }, crumbs(["Start", "/"]));
    const { ctx } = over([p]);
    expect(await schemaOrgRedefined.run(p, ctx)).toEqual([]);
    expect(await schemaTemplateMissingType.run(p, ctx)).toEqual([]);
    expect(await schemaBreadcrumbStart.run(p, ctx)).toEqual([]);
    expect(await schemaBreadcrumbMismatch.run(p, ctx)).toEqual([]);
  });
});
