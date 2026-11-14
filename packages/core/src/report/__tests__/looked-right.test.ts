import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../../checks/index.js";
import { createFetcher } from "../../fetcher.js";
import {
  BUDGET_KINDS,
  createBudget,
  formatSampleSummary,
  type BudgetSummary,
} from "../../limits.js";
import { checkSite } from "../../site.js";
import { renderLookedRight, renderReport, renderSampled } from "../html.js";

const registry = createPageRegistry();
const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function summary(counts: Partial<Record<keyof BudgetSummary, [number, number]>>): BudgetSummary {
  const b = createBudget();
  const s = b.summary();
  for (const [kind, [found, taken]] of Object.entries(counts) as [
    keyof BudgetSummary,
    [number, number],
  ][])
    s[kind] = { limit: s[kind].limit, sampled: taken, found };
  return s;
}

describe("looked right and sampled: unit", () => {
  it("the budget is the ledger: two takes for one kind add up, and taken never exceeds the limit", () => {
    const b = createBudget();
    b.take(
      "links",
      Array.from({ length: 20 }, (_, i) => i),
    );
    b.take(
      "links",
      Array.from({ length: 92 }, (_, i) => i),
    );
    expect(b.summary().links).toEqual({ limit: 30, sampled: 30, found: 112 });
  });

  it("renderSampled: taken < seen, taken = seen, seen = 0 (omitted)", () => {
    const html = renderSampled(summary({ links: [112, 30], images: [14, 14] }), []);
    expect(html).toContain("<li>30 of 112 links checked</li>");
    expect(html).toContain("<li>all 14 images checked</li>");
    expect(html).not.toContain("sitemap");
    expect(html).not.toContain("0 of 0");
  });

  it("nothing sampled says so, not 0 of 0; could-not-check entries are listed with their reason", () => {
    const html = renderSampled(summary({}), [
      { id: "broken-links", reason: "rate limited (429)", url: "https://pop.example/busy" },
    ]);
    expect(html).toContain(
      "Nothing was sampled: the page had no links, images or other addresses to read.",
    );
    expect(html).toContain("<h2>Could not check</h2>");
    expect(html).toContain("rate limited (429)");
  });

  it("renderLookedRight groups by area in the findings' area order, with titles only and every title escaped", () => {
    const html = renderLookedRight(["broken-links", "canonical-missing", "noindex"], registry);
    const search = html.indexOf("<h3>Search &amp; sharing</h3>");
    const visitors = html.indexOf("<h3>Visitors</h3>");
    expect(search).toBeGreaterThan(-1);
    expect(visitors).toBeGreaterThan(search);
    expect(html).toContain("The page doesn&#39;t say which address is the real one");
    // No check ids in the visible text.
    expect(html).not.toMatch(/>[^<]*canonical-missing[^<]*</);
  });

  it("the terminal's closing line names only the kinds that were cut short", () => {
    expect(
      formatSampleSummary(summary({ links: [112, 30], images: [46, 20], sitemapPages: [3, 3] })),
    ).toBe("Checked 30 of 112 links, 20 of 46 images.");
    expect(formatSampleSummary(summary({ links: [3, 3] }))).toBe("");
  });
});

describe("looked right and sampled: integration", () => {
  const send =
    (status: number, body: string, type = "text/html") =>
    (_q: IncomingMessage, res: ServerResponse) => {
      res.writeHead(status, { "content-type": type }).end(body);
    };

  it("a page with 112 links and 46 images: the report says 30 of 112 and 20 of 46", async () => {
    const links = Array.from({ length: 112 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join(" ");
    const imgs = Array.from(
      { length: 46 },
      (_, i) => `<img src="/i${i}.png" alt="Picture ${i}">`,
    ).join("");
    const server = await startServer(
      {
        "/": send(
          200,
          `<html><head><title>Hub</title></head><body><main>${links}${imgs}</main></body></html>`,
        ),
      },
      send(200, "", "image/png"),
    );
    servers.push(server);
    const { result, budget } = await checkSite({
      address: `${server.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
      only: ["broken-links", "images-broken"],
    });
    const html = renderReport({
      result,
      url: `${server.origin}/`,
      startedAt: new Date(0),
      registry,
      sampled: budget.summary(),
      version: "0.1.0",
    });
    expect(html).toContain("30 of 112 links checked");
    expect(html).toContain("20 of 46 images checked");
    expect(result.sampled.links).toEqual({ seen: 112, taken: 30, limit: 30 });
  });

  it("a check that could not be checked is not under What looked right, and is under Could not check", () => {
    const html = renderReport({
      result: {
        findings: [],
        passed: ["noindex"],
        failed: [],
        warnings: [],
        couldNotCheck: [
          { id: "broken-links", reason: "rate limited (429)", url: "https://pop.example/busy" },
        ],
        sampled: {},
      },
      url: "https://pop.example/",
      startedAt: new Date(0),
      registry,
      sampled: summary({ links: [3, 3] }),
      version: "0.1.0",
    });
    const right = html.slice(html.indexOf("What looked right"), html.indexOf("Could not check"));
    expect(right).not.toContain("Links on this page go nowhere");
    expect(html.slice(html.indexOf("Could not check"))).toContain("broken-links");
  });
});

describe("looked right and sampled: edge cases", () => {
  it("every check passed: the section lists all of them, the file stays self-contained", () => {
    const all = registry.all().map((c) => c.id);
    const html = renderLookedRight(all, registry);
    for (const c of registry.all())
      expect(html, c.id).toContain(
        c.title
          .replace(/&/g, "&amp;")
          .replace(/'/g, "&#39;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;"),
      );
    expect(html).not.toMatch(/<script|\ssrc=|<link/i);
  });

  it("--json's sampled has every budget kind, zeros included, so scripts can rely on the keys", () => {
    const b = createBudget();
    const { sampledCounts } = { sampledCounts: Object.keys(b.summary()) };
    expect(sampledCounts.sort()).toEqual([...BUDGET_KINDS].sort());
  });
});
