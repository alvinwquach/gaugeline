import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSite, createFetcher } from "../../packages/core/src/index.js";
import { withFixture } from "../../packages/fixtures/src/index.js";
import { pagesCheckedText, searchDataText } from "../lib/the-app-docs.js";

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
