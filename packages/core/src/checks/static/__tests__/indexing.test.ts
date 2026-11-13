import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readLocalSource, type SourceTree } from "../../../local-source/read.js";
import { runStaticChecks } from "../../../local-source/run.js";
import {
  appSegments,
  indexingOff,
  parentSetting,
  robotsOf,
  routePath,
  stripComments,
} from "../indexing-source.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const FIXTURES = fileURLToPath(new URL("../../../../../fixtures/source/", import.meta.url));

/** A tree made from text, so an edge case needs no folder. */
const inline = (files: Record<string, string>, label = "./bar"): SourceTree => ({
  kind: "local-source",
  label,
  files: new Map(Object.entries(files)),
  skipped: new Map(),
  truncated: false,
});

const fixture = (name: string): Promise<SourceTree> =>
  readLocalSource(`${FIXTURES}${name}`, undefined, `./${name}`);

const run = (tree: SourceTree, id: string) => runStaticChecks({ tree, now: NOW, only: [id] });

const layout = (robots?: string): string =>
  `export const metadata = { title: "Bar"${robots === undefined ? "" : `, robots: ${robots}`} };\nexport default function L() { return null }\n`;

describe("indexing-source: reading robots from metadata", () => {
  it("keeps line numbers and a // inside a string, and drops comments", () => {
    const text =
      'const a = "https://bar.example/x"; // robots: { index: false }\n/* robots: x */ const b = 1;\n';
    const out = stripComments(text);
    expect(out).toContain('"https://bar.example/x"');
    expect(out).not.toContain("robots");
    expect(out.split("\n")).toHaveLength(text.split("\n").length);
    expect(out).toHaveLength(text.length);
  });

  it.each([
    ["robots: { index: false, follow: false }", "noindex"],
    ["robots: { index: true }", "index"],
    ["robots: { follow: true }", "unspecified"],
    ["robots: { googleBot: { index: false } }", "unspecified"],
    ['robots: "noindex, nofollow"', "noindex"],
    ['robots: "all"', "unspecified"],
    ['robots: { index: process.env.INDEXING === "true" }', "dynamic"],
    ["robots: robotsFor(slug)", "dynamic"],
  ])("%s is %s", (robots, value) => {
    expect(robotsOf(`export const metadata = { ${robots} };`)?.value).toBe(value);
  });

  it("reads a robots meta tag in a layout's head", () => {
    expect(
      robotsOf(`export const metadata = {}; const h = <meta name="robots" content="noindex" />;`)
        ?.value,
    ).toBe("noindex");
  });

  it("says nothing for a file with no metadata, a commented robots, or no robots", () => {
    expect(robotsOf("export const x = { robots: { index: false } };")).toBeUndefined();
    expect(
      robotsOf("export const metadata = { // robots: { index: false }\n title: 'a' };"),
    ).toBeUndefined();
    expect(robotsOf("export const metadata = { title: 'a' };")).toBeUndefined();
  });

  it("two settings that differ in one file are dynamic, and the line is the first", () => {
    const r = robotsOf(
      "export function generateMetadata(p) {\n  if (p.a) return { robots: { index: false } };\n  return { robots: { index: true } };\n}",
    );
    expect(r).toEqual({ value: "dynamic", line: 2 });
  });
});

describe("indexing-source: the app router's files", () => {
  it("finds layouts and pages under app, src/app and a monorepo app, and no other folder called app", () => {
    const tree = inline({
      "app/layout.tsx": layout(),
      "app/blog/page.tsx": layout(),
      "src/app/layout.tsx": layout(),
      "apps/web/app/layout.tsx": layout(),
      "apps/web/app/(shop)/menu/[slug]/page.tsx": layout(),
      "components/app/page.tsx": layout(),
      "app/blog/mypage.tsx": layout(),
    });
    expect(appSegments(tree).map((s) => `${s.appRoot}|${s.rel}|${s.kind}`)).toEqual([
      "app|blog/|page",
      "app||layout",
      "apps/web/app|(shop)/menu/[slug]/|page",
      "apps/web/app||layout",
      "src/app||layout",
    ]);
  });

  it("a page's parent is the closest layout above it that sets robots", () => {
    const segs = appSegments(
      inline({
        "app/layout.tsx": layout("{ index: false }"),
        "app/shop/layout.tsx": layout(),
        "app/shop/menu/layout.tsx": layout("{ index: true }"),
        "app/shop/menu/page.tsx": layout("{ index: true }"),
        "app/shop/page.tsx": layout("{ index: true }"),
      }),
    );
    const by = (f: string) => segs.find((s) => s.file === f);
    expect(parentSetting(segs, by("app/shop/page.tsx")!)?.file).toBe("app/layout.tsx");
    expect(parentSetting(segs, by("app/shop/menu/page.tsx")!)?.file).toBe(
      "app/shop/menu/layout.tsx",
    );
    expect(parentSetting(segs, by("app/layout.tsx")!)).toBeUndefined();
  });

  it.each([
    ["", "/"],
    ["menu/", "/menu"],
    ["(shop)/menu/", "/menu"],
    ["(shop)/menu/[slug]/", "/menu/"],
    ["[slug]/", "/"],
    ["@modal/menu/", "/menu"],
  ])("route %j is the address %j", (rel, path) => {
    expect(routePath(rel)).toBe(path);
  });

  it("tells whether the site is set to stay out of search, and when a setting decides", () => {
    const state = (files: Record<string, string>) => {
      const t = inline(files);
      return indexingOff(t, appSegments(t)).state;
    };
    expect(state({ "app/layout.tsx": layout("{ index: false }") })).toBe("off");
    expect(
      state({ "app/layout.tsx": layout(), "public/robots.txt": "User-agent: *\nDisallow: /\n" }),
    ).toBe("off");
    expect(state({ "app/layout.tsx": layout("{ index: process.env.X === 'true' }") })).toBe(
      "depends",
    );
    expect(
      state({
        "app/layout.tsx": layout(),
        "app/robots.ts":
          "export default () => ({ rules: { userAgent: '*', disallow: process.env.X ? '/' : '' } });",
      }),
    ).toBe("depends");
    expect(
      state({
        "app/layout.tsx": layout("{ index: true }"),
        "public/robots.txt": "User-agent: *\nAllow: /\n",
      }),
    ).toBe("on");
  });
});

describe("page-robots-overrides-layout (FF-04)", () => {
  it("fails: a page's robots index: true replaces the layout's noindex", async () => {
    const r = await run(
      await fixture("page-robots-overrides-layout/fail"),
      "page-robots-overrides-layout",
    );
    expect(r.passed).toEqual([]);
    expect(r.findings).toEqual([
      {
        checkId: "page-robots-overrides-layout",
        severity: "high",
        title: "A page's robots setting replaces the layout's noindex",
        evidence:
          "app/menu/page.tsx:3 sets robots and says index: true, which replaces the robots in app/layout.tsx:5 (noindex)",
        url: "source:./page-robots-overrides-layout/fail/app/menu/page.tsx",
        source: { file: "app/menu/page.tsx", line: 3 },
      },
    ]);
  });

  it("passes: pages set no robots or set noindex themselves", async () => {
    const r = await run(
      await fixture("page-robots-overrides-layout/pass"),
      "page-robots-overrides-layout",
    );
    expect(r).toMatchObject({
      passed: ["page-robots-overrides-layout"],
      findings: [],
      couldNotCheck: [],
    });
  });

  it("fails for a robots object with no index value, which is indexable", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout("{ index: false }"),
        "app/a/page.tsx": layout("{ follow: false }"),
      }),
      "page-robots-overrides-layout",
    );
    expect(r.findings[0]?.evidence).toContain("has no index value, so the page can be indexed");
  });

  it("fails when a literal index: true page sits below a layout whose noindex is a setting", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout("{ index: process.env.INDEXING === 'true' }"),
        "app/a/page.tsx": layout("{ index: true }"),
      }),
      "page-robots-overrides-layout",
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.evidence).toContain("(a setting decides it there)");
  });

  it("is unsure, not passed, when the page's robots is built from code below a noindex layout", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout("{ index: false }"),
        "app/a/page.tsx": layout("robotsFor()"),
      }),
      "page-robots-overrides-layout",
    );
    expect(r.passed).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.couldNotCheck).toHaveLength(1);
  });

  it("is unsure when there is no app router folder", async () => {
    const r = await run(
      inline({ "pages/index.tsx": "export default () => null" }),
      "page-robots-overrides-layout",
    );
    expect(r.passed).toEqual([]);
    expect(r.couldNotCheck[0]?.reason).toContain("no app folder");
  });

  it("a nested layout that re-enables indexing is a finding too, and a page that sets no robots is not", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout("{ index: false }"),
        "app/shop/layout.tsx": layout("{ index: true }"),
        "app/shop/page.tsx": layout(),
      }),
      "page-robots-overrides-layout",
    );
    expect(r.findings.map((f) => f.source?.file)).toEqual(["app/shop/layout.tsx"]);
  });
});

describe("sitemap-while-indexing-off (FF-02)", () => {
  it("fails: a sitemap file in a site whose root layout says noindex", async () => {
    const r = await run(
      await fixture("sitemap-while-indexing-off/fail"),
      "sitemap-while-indexing-off",
    );
    expect(r.findings).toEqual([
      {
        checkId: "sitemap-while-indexing-off",
        severity: "high",
        title: "A sitemap is served while the site is set to stay out of search",
        evidence:
          "app/sitemap.ts serves a sitemap while the site is set to stay out of search (app/layout.tsx says noindex)",
        url: "source:./sitemap-while-indexing-off/fail",
        source: { file: "app/sitemap.ts", line: 1 },
      },
    ]);
  });

  it("passes: no sitemap", async () => {
    const r = await run(
      await fixture("sitemap-while-indexing-off/pass"),
      "sitemap-while-indexing-off",
    );
    expect(r.passed).toEqual(["sitemap-while-indexing-off"]);
  });

  it("passes a sitemap on a site that is meant to be indexed", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout(),
        "app/sitemap.ts": "export default () => []",
        "public/robots.txt": "User-agent: *\nAllow: /\n",
      }),
      "sitemap-while-indexing-off",
    );
    expect(r.passed).toEqual(["sitemap-while-indexing-off"]);
  });

  it("fails for a Sitemap line in a robots.txt that disallows everything, and a static public sitemap", async () => {
    const a = await run(
      inline({
        "app/layout.tsx": layout(),
        "public/robots.txt":
          "User-agent: *\nDisallow: /\nSitemap: https://bar.example/sitemap.xml\n",
      }),
      "sitemap-while-indexing-off",
    );
    expect(a.findings[0]?.evidence).toContain("public/robots.txt serves a sitemap");
    const b = await run(
      inline({
        "app/layout.tsx": layout("{ index: false }"),
        "public/sitemap.xml": "<urlset/>",
        "public/sitemap-0.xml": "<urlset/>",
      }),
      "sitemap-while-indexing-off",
    );
    expect(b.findings[0]?.evidence).toContain("public/sitemap.xml and 1 more");
  });

  it("is unsure, not passed, when a setting decides whether indexing is off", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout("{ index: process.env.INDEXING === 'true' }"),
        "app/sitemap.ts": "export default () => []",
      }),
      "sitemap-while-indexing-off",
    );
    expect(r.passed).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.couldNotCheck[0]?.reason).toContain("depends on a setting");
  });
});

describe("robots-disallow-hides-noindex (FF-01)", () => {
  it("fails: a page that carries noindex is disallowed in robots.txt", async () => {
    const r = await run(
      await fixture("robots-disallow-hides-noindex/fail"),
      "robots-disallow-hides-noindex",
    );
    expect(r.findings).toEqual([
      {
        checkId: "robots-disallow-hides-noindex",
        severity: "high",
        title: "Pages marked noindex are also blocked in robots.txt",
        evidence: "1 page carries noindex and is blocked in public/robots.txt: /private",
        url: "source:./robots-disallow-hides-noindex/fail",
        source: { file: "public/robots.txt", line: 2 },
      },
    ]);
  });

  it("passes: the same page with robots.txt allowing it", async () => {
    const r = await run(
      await fixture("robots-disallow-hides-noindex/pass"),
      "robots-disallow-hides-noindex",
    );
    expect(r.passed).toEqual(["robots-disallow-hides-noindex"]);
  });

  it("a layout's noindex counts for every page under it, and a dynamic segment is judged by what comes before it", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout("{ index: false }"),
        "app/page.tsx": layout(),
        "app/menu/[slug]/page.tsx": layout(),
        "public/robots.txt": "User-agent: *\nDisallow: /menu/\n",
      }),
      "robots-disallow-hides-noindex",
    );
    expect(r.findings[0]?.evidence).toBe(
      "1 page carries noindex and is blocked in public/robots.txt: /menu/",
    );
  });

  it("does not claim a page is blocked by a rule that covers only part of its dynamic route", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout("{ index: false }"),
        "app/menu/[slug]/page.tsx": layout(),
        "public/robots.txt": "User-agent: *\nDisallow: /menu/old\n",
      }),
      "robots-disallow-hides-noindex",
    );
    expect(r.findings).toEqual([]);
  });

  it("reads literal rules in app/robots.ts, and is unsure when it is built from a setting", async () => {
    const files = { "app/layout.tsx": layout("{ index: false }"), "app/page.tsx": layout() };
    const a = await run(
      inline({
        ...files,
        "app/robots.ts": 'export default () => ({ rules: { userAgent: "*", disallow: ["/"] } });',
      }),
      "robots-disallow-hides-noindex",
    );
    expect(a.findings).toHaveLength(1);
    const b = await run(
      inline({
        ...files,
        "app/robots.ts":
          'export default () => ({ rules: { userAgent: "*", disallow: process.env.X ? "/" : "" } });',
      }),
      "robots-disallow-hides-noindex",
    );
    expect(b.passed).toEqual([]);
    expect(b.couldNotCheck).toHaveLength(1);
  });

  it("passes when no page carries noindex, whatever robots.txt says", async () => {
    const r = await run(
      inline({
        "app/layout.tsx": layout(),
        "app/page.tsx": layout(),
        "public/robots.txt": "User-agent: *\nDisallow: /\n",
      }),
      "robots-disallow-hides-noindex",
    );
    expect(r.passed).toEqual(["robots-disallow-hides-noindex"]);
  });
});

describe("the three together", () => {
  it("raise one finding each on the pre-launch bar copy, in the same order every run", async () => {
    const tree = await fixture("harbour-bar-preview");
    const a = await runStaticChecks({ tree, now: NOW });
    const b = await runStaticChecks({ tree, now: NOW });
    expect(a).toEqual(b);
    expect(a.findings.map((f) => f.checkId)).toEqual([
      "page-robots-overrides-layout",
      "sitemap-while-indexing-off",
    ]);
    expect(a.passed).toEqual(["robots-disallow-hides-noindex"]);
  });
});
