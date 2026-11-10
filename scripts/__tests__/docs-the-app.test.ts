import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  buildResult,
  checkSite,
  createFetcher,
  createNetworkTransport,
  type Transport,
} from "../../packages/core/src/index.js";
import type { Checked, Result } from "../../packages/app/src/types.js";
import { withFixture } from "../../packages/fixtures/src/index.js";
import { adsText, leaksAccessText, pagesCheckedText, searchDataText } from "../lib/the-app-docs.js";
import { TAPAS_ADS, tapasResult } from "../lib/ads-example.js";

const page = readFileSync(
  fileURLToPath(new URL("../../docs/the-app.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const block = (title: string) =>
  new RegExp("```text title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

/** What the app shows for the pages-search fixture: a real run, read the way the app server reads it. */
async function studio() {
  return withFixture("pages-search", async (site) => {
    const { requests, page: data } = await checkSite({
      address: site.origin,
      fetcher: createFetcher({ allowPrivate: true }),
    });
    return {
      pages: pagesCheckedText(requests ?? [], site.origin),
      search: searchDataText(data, site.origin),
    };
  });
}

/** The parser's wording for where it stopped changes with the Node version: the rest of the line must match. */
const stableErrors = (text: string | undefined) =>
  text?.replace(/at position \d+( \(line \d+ column \d+\))?/, "at position N");

describe("the Pages checked and Search data examples in docs/the-app.md", () => {
  it("show what the app lists for the pages-search fixture", async () => {
    const real = await studio();
    // GAUGELINE_PRINT=<file> writes the two blocks there, for pasting into the page.
    if (process.env.GAUGELINE_PRINT)
      writeFileSync(process.env.GAUGELINE_PRINT, `${real.pages}\n\n=====\n\n${real.search}\n`);
    expect(block("Pages checked rows")).toBe(real.pages);
    expect(stableErrors(block("Search data"))).toBe(stableErrors(real.search));
  });
});

describe("the Leaks & access example in docs/the-app.md", () => {
  it("shows what the app lists for the leaks-access fixture", async () => {
    const text = await withFixture("leaks-access", async (site) => {
      // The wine bar's Sanity dataset is public, with six types; the fixture never serves it.
      const local = createNetworkTransport({ hosts: site.hosts, allowPrivate: true });
      const transport: Transport = (url, req) =>
        url.hostname.endsWith(".api.sanity.io")
          ? Promise.resolve({
              status: 200,
              headers: { "content-type": "application/json" },
              body: Readable.from([
                Buffer.from(
                  JSON.stringify({
                    result: {
                      count: 187,
                      types: ["event", "menu", "page", "post", "venue", "wineList"],
                    },
                  }),
                ),
              ]),
            })
          : local(url, req);
      const run = await checkSite({ address: site.origin, fetcher: createFetcher({ transport }) });
      const result = buildResult({
        url: run.snapshot.requestedUrl,
        startedAt: new Date("2026-11-09T10:00:00.000Z"),
        findings: run.result.findings,
        passed: run.result.passed,
        failed: run.result.failed.map((f) => f.id),
        couldNotCheck: run.result.couldNotCheck,
        sampled: run.result.sampled,
      }) as unknown as Result;
      const checked = {
        ...(run.requests ? { requests: run.requests } : {}),
        page: run.page,
        leaks: run.leaks,
      } as unknown as Checked;
      return leaksAccessText(result, checked);
    });
    if (process.env.GAUGELINE_PRINT_LEAKS)
      writeFileSync(process.env.GAUGELINE_PRINT_LEAKS, `${text}\n`);
    expect(block("Leaks & access")).toBe(text);
  });
});

describe("the tavern example in docs/the-app.md", () => {
  it("lists what the demo's first run found, in the report's order", () => {
    const demo = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../packages/app-server/demo/results.json", import.meta.url)),
        "utf8",
      ),
    ) as { runs: { result: Result }[] };
    const mark = { high: "\u2717", medium: "!", low: "\u00b7" } as const;
    const text = (demo.runs[0]?.result.findings ?? [])
      .map((f) => `${mark[f.severity]} ${f.title}\n    ${f.evidence}`)
      .join("\n");
    expect(text).toContain("Trivia Night");
    expect(block("Example tavern run")).toBe(text);
  });
});

describe("the Ads example in docs/ad-landing-pages.md", () => {
  it("shows what the app lists for the tapas bar's export, from the model the view uses", () => {
    const adsPage = readFileSync(
      fileURLToPath(new URL("../../docs/ad-landing-pages.md", import.meta.url)),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const shown = new RegExp("```text title=Ads in the app\\n([\\s\\S]*?)\\n```").exec(
      adsPage,
    )?.[1];
    const text = adsText(tapasResult(), TAPAS_ADS);
    if (process.env.GAUGELINE_PRINT_ADS)
      writeFileSync(process.env.GAUGELINE_PRINT_ADS, `${text}\n`);
    expect(shown).toBe(text);
  });
});
