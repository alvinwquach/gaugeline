import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../fetcher.js";
import {
  LIMITS,
  createBudget,
  formatSampleSummary,
  type Budget,
  type BudgetKind,
} from "../limits.js";
import { dedupeUrls } from "../sample.js";
import { html, redirect, startServer, type FixtureServer } from "./helpers/server.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("LIMITS and Budget: unit", () => {
  it("LIMITS is frozen and equals the published numbers exactly", () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(() => {
      "use strict";
      (LIMITS as { links: number }).links = 99;
    }).toThrow(TypeError);
    expect({ ...LIMITS }).toEqual({
      links: 30,
      images: 20,
      sitemapPages: 25,
      sitemapFiles: 10,
      feeds: 3,
      llmsTxtLinks: 10,
      appLinks: 5,
      scripts: 15,
      structuredDataAddresses: 12,
      concurrency: 5,
      redirectHops: 10,
      bodyBytes: 5 * 1024 * 1024,
    });
  });

  it('take("links", 61 items) returns the first 30 in order; summary shows 30 of 61', () => {
    const b = createBudget();
    expect(b.take("links", range(61))).toEqual(range(30));
    expect(b.summary().links).toEqual({ limit: 30, sampled: 30, found: 61 });
    expect(b.remaining("links")).toBe(0);
  });

  it("two calls share the allowance: images 12 then 15 returns 8; sampled 20, found 27", () => {
    const b = createBudget();
    expect(b.take("images", range(12))).toHaveLength(12);
    expect(b.take("images", range(15))).toEqual(range(8));
    expect(b.summary().images).toEqual({ limit: 20, sampled: 20, found: 27 });
  });

  it("take on an exhausted kind returns [] and still increases found", () => {
    const b = createBudget();
    b.take("feeds", range(3));
    expect(b.take("feeds", range(4))).toEqual([]);
    expect(b.summary().feeds).toEqual({ limit: 3, sampled: 3, found: 7 });
  });

  it("two budgets do not share state", () => {
    const a = createBudget();
    const b = createBudget();
    a.take("links", range(30));
    expect(b.remaining("links")).toBe(30);
    expect(b.summary().links.found).toBe(0);
  });

  it("summary() returns a copy", () => {
    const b = createBudget();
    b.summary().links.sampled = 30;
    expect(b.remaining("links")).toBe(30);
  });

  it("summary line: partial sample, full sample, nothing found, singular", () => {
    const b = createBudget();
    b.take("links", range(61).slice(0, 24));
    b.take("images", range(34));
    b.take("sitemapPages", range(310));
    expect(formatSampleSummary(b.summary())).toBe(
      "Checked all 24 links, 20 of 34 images, 25 of 310 sitemap pages.",
    );
    const one = createBudget();
    one.take("links", ["only"]);
    expect(formatSampleSummary(one.summary())).toBe("Checked 1 link.");
    const partial = createBudget();
    partial.take("links", range(61));
    expect(formatSampleSummary(partial.summary())).toBe("Checked 30 of 61 links.");
    expect(formatSampleSummary(createBudget().summary())).toBe("");
  });
});

/** Walk core sources for a bare published limit used as a cap next to slice( or .length. */
function findBareLimits(dir: string): string[] {
  const bare = new Set([
    LIMITS.links,
    LIMITS.images,
    LIMITS.sitemapPages,
    LIMITS.scripts,
    LIMITS.structuredDataAddresses,
  ]);
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (name === "__tests__") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && name !== "limits.ts") {
        const sf = ts.createSourceFile(
          full,
          readFileSync(full, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const isBare = (n: ts.Node) => ts.isNumericLiteral(n) && bare.has(Number(n.text) as 30);
        const isLength = (n: ts.Node) =>
          ts.isPropertyAccessExpression(n) && n.name.text === "length";
        const visit = (n: ts.Node): void => {
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === "slice" &&
            n.arguments.some(isBare)
          ) {
            hits.push(
              `${name}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText()}`,
            );
          }
          if (
            ts.isBinaryExpression(n) &&
            ((isLength(n.left) && isBare(n.right)) || (isBare(n.left) && isLength(n.right)))
          ) {
            hits.push(
              `${name}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText()}`,
            );
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
  };
  walk(dir);
  return hits;
}

describe("no module brings back its own cap", () => {
  it("packages/core/src has no bare 30, 20, 25, 15 or 12 next to slice( or .length", () => {
    expect(findBareLimits(fileURLToPath(new URL("..", import.meta.url)))).toEqual([]);
  });
});

/** The sampler pattern every network check follows: find, dedupe, take, fetch. */
async function sampleAndFetch(
  budget: Budget,
  kind: BudgetKind,
  page: string,
  pattern: RegExp,
  fetcher = createFetcher({ allowPrivate: true }),
) {
  const found = [...page.matchAll(pattern)].map((m) => m[1] ?? "");
  const candidates = dedupeUrls(found, servers[0]?.origin);
  const sample = budget.take(kind, candidates);
  await Promise.all(sample.map((u) => fetcher.get(u, { method: "HEAD" })));
  return sample;
}

describe("Budget: integration (fixture server)", () => {
  it("a page with 80 same-site links: the server log shows at most 30 link requests", async () => {
    const page =
      range(80)
        .map((i) => `<a href="/p/${i}">${i}</a>`)
        .join("") + '<a href="/p/1">again</a>';
    const s = await startServer({ "/": html(page) }, html("ok"));
    servers.push(s);
    const budget = createBudget();
    await sampleAndFetch(budget, "links", page, /href="([^"]+)"/g);
    expect(s.log.filter((r) => r.path.startsWith("/p/")).length).toBeLessThanOrEqual(30);
    expect(budget.summary().links).toEqual({ limit: 30, sampled: 30, found: 80 });
  });

  it('a page with 40 scripts: 15 fetched, and the line says "15 of 40 JavaScript files"', async () => {
    const page = range(40)
      .map((i) => `<script src="/js/${i}.js"></script>`)
      .join("");
    const s = await startServer({ "/": html(page) }, html("//js"));
    servers.push(s);
    const budget = createBudget();
    await sampleAndFetch(budget, "scripts", page, /src="([^"]+)"/g);
    expect(s.log.filter((r) => r.path.startsWith("/js/"))).toHaveLength(15);
    expect(formatSampleSummary(budget.summary())).toBe("Checked 15 of 40 JavaScript files.");
  });

  it("the fetcher still caps at 5 in flight and 10 hops after reading them from LIMITS", async () => {
    const routes: Record<string, ReturnType<typeof redirect>> = {};
    for (let i = 0; i < 11; i++) routes[`/r${i}`] = redirect(301, `/r${i + 1}`);
    const s = await startServer(routes, async (_q, res) => {
      await new Promise((r) => setTimeout(r, 10));
      res.writeHead(200).end();
    });
    servers.push(s);
    const f = createFetcher({ allowPrivate: true });
    await Promise.all(range(20).map((i) => f.get(`${s.origin}/x${i}`)));
    expect(f.stats.maxInFlight).toBe(LIMITS.concurrency);
    const err = (await f.get(`${s.origin}/r0`).catch((e: unknown) => e)) as { hops: unknown[] };
    expect(err.hops).toHaveLength(LIMITS.redirectHops);
  });
});

describe("Budget: promise test (the published request budget)", () => {
  it("a run over a large page stays at or under every limit, never more than 5 in flight", async () => {
    const page = [
      ...range(80).map((i) => `<a href="/l/${i}">`),
      ...range(50).map((i) => `<img src="/i/${i}.png">`),
      ...range(40).map((i) => `<script src="/s/${i}.js">`),
      ...range(9).map(
        (i) => `<link rel="alternate" type="application/rss+xml" href="/f/${i}.xml">`,
      ),
    ].join("\n");
    const s = await startServer({ "/": html(page) }, async (_q, res) => {
      await new Promise((r) => setTimeout(r, 5));
      res.writeHead(200).end();
    });
    servers.push(s);
    const budget = createBudget();
    const fetcher = createFetcher({ allowPrivate: true });
    await Promise.all([
      sampleAndFetch(budget, "links", page, /<a href="([^"]+)"/g, fetcher),
      sampleAndFetch(budget, "images", page, /<img src="([^"]+)"/g, fetcher),
      sampleAndFetch(budget, "scripts", page, /<script src="([^"]+)"/g, fetcher),
      sampleAndFetch(budget, "feeds", page, /rss\+xml" href="([^"]+)"/g, fetcher),
    ]);
    const count = (prefix: string) => s.log.filter((r) => r.path.startsWith(prefix)).length;
    expect(count("/l/")).toBeLessThanOrEqual(LIMITS.links);
    expect(count("/i/")).toBeLessThanOrEqual(LIMITS.images);
    expect(count("/s/")).toBeLessThanOrEqual(LIMITS.scripts);
    expect(count("/f/")).toBeLessThanOrEqual(LIMITS.feeds);
    expect(s.maxConcurrent).toBeLessThanOrEqual(LIMITS.concurrency);
    expect(fetcher.stats.maxInFlight).toBeLessThanOrEqual(LIMITS.concurrency);
  });
});

describe("Budget: edge cases", () => {
  it("take() does not dedupe: duplicates the caller forgot to remove each cost one", () => {
    const b = createBudget();
    expect(b.take("links", ["/a", "/a", "/a"])).toEqual(["/a", "/a", "/a"]);
    expect(b.summary().links.sampled).toBe(3);
  });

  it("dedupeUrls keeps document order and compares by normalised URL", () => {
    expect(
      dedupeUrls(
        ["/a", "/A", "/a#x", "HTTPS://SHOP.EXAMPLE/a", "/b", "::bad::"],
        "https://shop.example/",
      ),
    ).toEqual([
      "https://shop.example/a",
      "https://shop.example/A",
      "https://shop.example/b",
      "https://shop.example/::bad::",
    ]);
  });

  it("a limit of 0 in a custom limits object: take returns [] for every kind", () => {
    const zero = {
      ...LIMITS,
      links: 0,
      images: 0,
      sitemapPages: 0,
      feeds: 0,
      scripts: 0,
      structuredDataAddresses: 0,
    };
    const b = createBudget(zero);
    for (const kind of [
      "links",
      "images",
      "sitemapPages",
      "feeds",
      "scripts",
      "structuredDataAddresses",
    ] as const) {
      expect(b.take(kind, [1, 2, 3])).toEqual([]);
    }
  });

  it("a check throws after take(): the allowance is spent, not refunded", () => {
    const b = createBudget();
    try {
      b.take("links", range(10));
      throw new Error("check failed");
    } catch {
      // the runner records the failure
    }
    expect(b.remaining("links")).toBe(20);
    expect(b.take("links", range(30))).toHaveLength(20);
  });

  it("found 0 with sampled 0 prints nothing for that kind", () => {
    const b = createBudget();
    b.take("images", []);
    expect(formatSampleSummary(b.summary())).toBe("");
  });

  it("the summary is identical across two runs of the same input (determinism)", () => {
    const run = () => {
      const b = createBudget();
      b.take("links", range(61));
      b.take("images", range(7));
      return JSON.stringify(b.summary());
    };
    expect(run()).toBe(run());
  });
});
