import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, MAX_LISTING_PAGES, filterProblem, modelConfigSchema } from "@gaugeline/core";
import { SITES_DIR } from "@gaugeline/fixtures";
import { FERNBROOK, sanityCountsTransport, staticSite } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

/**
 * docs/sources/sanity-schema.md shows one configuration and what it prints for the invented
 * Fernbrook Physio site and dataset. The page's command needs a Sanity project, so the docs runner
 * (pnpm docs:examples) cannot run it; this test does, and compares what the page prints with what the
 * CLI prints.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/sources/sanity-schema.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}
const block = (title: string) => fences().find((f) => f.info.includes(`title="${title}"`))?.body;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function run(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-model-docs-"));
  dirs.push(dir);
  for (const f of ["schema.json", "schema.before.json"])
    cpSync(join(SITES_DIR, "model-clinic", f), join(dir, f));
  // The page's own configuration block is what runs.
  writeFileSync(join(dir, "gaugeline.model.json"), block("gaugeline.model.json") ?? "");
  const out: string[] = [];
  const dataset = sanityCountsTransport(FERNBROOK);
  const site = staticSite("fernbrook.example", join(SITES_DIR, "model-clinic"), () =>
    Promise.reject(new Error("only the fixture host is served")),
  );
  await main(
    ["https://fernbrook.example/", "--no-open"],
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => undefined },
      env: { NO_COLOR: "1", SANITY_PROJECT_ID: "fernbrook1" },
    },
    {
      cwd: dir,
      version: "0.1.0",
      fetcher: {
        transport: (url, req) =>
          url.hostname === "fernbrook1.api.sanity.io" ? dataset(url, req) : site(url, req),
      },
    },
  );
  return out.join("");
}

describe("docs/sources/sanity-schema.md", () => {
  it("its configuration block is the fixture's file, so the page and the tool cannot drift", () => {
    const onPage: unknown = JSON.parse(block("gaugeline.model.json") ?? "null");
    const inFixture: unknown = JSON.parse(
      readFileSync(join(SITES_DIR, "model-clinic", "gaugeline.model.json"), "utf8"),
    );
    expect(onPage).toEqual(inFixture);
    expect(modelConfigSchema.safeParse(onPage).success).toBe(true);
  });

  it("each finding the page shows is printed by the tool, title and evidence", async () => {
    const expected = (block("Output (the lines these checks add)") ?? "").split("\n");
    expect(expected.length).toBe(12);
    const out = (await run()).split("\n");
    for (let i = 0; i < expected.length; i += 2) {
      const printed = out.some((l, k) => l === expected[i] && out[k + 1] === expected[i + 1]);
      expect(printed, expected[i + 1]).toBe(true);
    }
  });

  it("is written for freelancer client work, with an invented clinic", () => {
    expect(page).toContain("Fernbrook Physio");
    expect(page).toContain("pop-up");
    expect(page).toContain("coach");
  });

  it("states the limits the code uses and the filter rule it enforces", () => {
    expect(page).toContain(`up to ${MAX_LISTING_PAGES} pages`);
    expect(page).toContain(`allowance of ${LIMITS.statePages} pages`);
    expect(filterProblem("!(archived == true)")).toBeUndefined();
    expect(filterProblem("a == {b: 1}")).toBeDefined();
    expect(page).toContain("`!(archived == true)`");
  });
});
