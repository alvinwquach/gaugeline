import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR } from "@gaugeline/fixtures";
import { MODEL_CHECKS } from "@gaugeline/core";
import {
  FERNBROOK,
  FERNBROOK_MARKER,
  sanityCountsTransport,
  staticSite,
  type FakeSanity,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const HOST = "fernbrook.example";
const PROJECT = "fernbrook1";
const TOKEN = ["sk", "fernbrook", "token", "0123456789abcdef"].join("_");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A working folder with the clinic's three files, or with the given files instead. */
function workdir(files?: Record<string, unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-model-"));
  dirs.push(dir);
  if (files === undefined)
    for (const f of ["gaugeline.model.json", "schema.json", "schema.before.json"])
      cpSync(join(SITES_DIR, "model-clinic", f), join(dir, f));
  else
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
}

interface Request {
  method: string;
  url: string;
}

async function run(
  args: string[],
  dir: string,
  env: Record<string, string | undefined> = {},
  requests: Request[] = [],
  sanity: FakeSanity = FERNBROOK,
  queries: SeenSanityRequest[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const dataset = sanityCountsTransport(sanity, queries);
  const site = staticSite(HOST, join(SITES_DIR, "model-clinic"), () =>
    Promise.reject(new Error("only the fixture host is served")),
  );
  const code = await main(
    args,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    {
      cwd: dir,
      version: "0.1.0",
      fetcher: {
        transport: (url, req) => {
          requests.push({ method: req.method, url: url.href });
          return url.hostname === `${PROJECT}.api.sanity.io` ? dataset(url, req) : site(url, req);
        },
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

const ENV = { SANITY_PROJECT_ID: PROJECT };

describe("gaugeline.model.json in the CLI", () => {
  it("a bad file stops the run naming the file and the field (exit 2)", async () => {
    const dir = workdir({
      "gaugeline.model.json": { listings: [{ page: "news", type: "article", item: "li" }] },
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("gaugeline.model.json: listings.0.page:");
  });

  it("a schema file that is not there stops the run naming the setting, not a quiet could-not-check", async () => {
    const dir = workdir({ "gaugeline.model.json": { schema: "sanity/schema.json" } });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("gaugeline.model.json: schema: the file");
    expect(r.err).toContain("sanity schema extract");
  });

  it("a schema file that is not a schema extract stops the run too", async () => {
    const dir = workdir({
      "gaugeline.model.json": { previousSchema: "old.json" },
      "old.json": "[1, 2]",
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("gaugeline.model.json: previousSchema:");
    expect(r.err).toContain("is not a schema extract");
  });

  it("with the file, the checks run and print what the content model got wrong", async () => {
    const requests: Request[] = [];
    const queries: SeenSanityRequest[] = [];
    const r = await run(
      [`https://${HOST}/`, "--no-open"],
      workdir(),
      ENV,
      requests,
      FERNBROOK,
      queries,
    );
    expect(r.err).not.toContain("could not");
    for (const text of [
      '17 of 48 published "article" documents have no "summary", which the schema now requires (ids article-32, article-33, article-34, and 14 more)',
      'News shows 31 of 48 published "article" entries (2 pages of results).',
      'Latest from the clinic on / shows no entries (nothing matches "#insights li"), and 48 "article" entries are published',
      "/services/sports-massage shows a raw reference (a _ref id) in its text",
      '2 of 6 published "practitioner" documents still have a value in "oldSpecialty"',
    ])
      expect(r.out).toContain(text);
    // The id shown on purpose, under idsShownOn, is not reported.
    expect(r.out).not.toContain("/dev/content-ids shows");
    // Reads only: GET or HEAD to the site, GET to Sanity, published documents, counts and ids.
    expect(requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(queries.length).toBeGreaterThan(0);
    expect(
      queries.every((q) => q.method === "GET" && q.url.includes("perspective=published")),
    ).toBe(true);
    for (const text of [r.out, r.err]) expect(text).not.toContain(FERNBROOK_MARKER);
  });

  it("--json lists the findings under their check ids", async () => {
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir(), ENV);
    const result = JSON.parse(r.out) as {
      findings: Array<{ checkId: string }>;
      couldNotCheck: Array<{ id: string }>;
    };
    const ids = new Set(result.findings.map((f) => f.checkId));
    for (const id of MODEL_CHECKS) expect(ids.has(id), id).toBe(true);
    expect(result.couldNotCheck.filter((c) => MODEL_CHECKS.includes(c.id))).toEqual([]);
  });

  it("with no schema in the file, the schema checks say so and the page checks still run", async () => {
    const dir = workdir({
      "gaugeline.model.json": {
        listings: [{ page: "/news", type: "article", item: "article.card" }],
        dependents: [{ page: "/", selector: "#insights li", type: "article" }],
      },
    });
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], dir, ENV);
    const result = JSON.parse(r.out) as {
      findings: Array<{ checkId: string }>;
      passed: string[];
      couldNotCheck: Array<{ id: string; reason: string }>;
    };
    const found = new Set(result.findings.map((f) => f.checkId));
    expect(found.has("model-listing-count")).toBe(true);
    expect(found.has("model-dependents")).toBe(true);
    expect(found.has("model-unexpanded")).toBe(true);
    const reasons = Object.fromEntries(result.couldNotCheck.map((c) => [c.id, c.reason]));
    expect(
      Object.keys(reasons)
        .filter((id) => MODEL_CHECKS.includes(id))
        .sort(),
    ).toEqual(["model-missing-required", "model-orphan-fields"]);
    expect(reasons["model-missing-required"]).toContain('"schema"');
    for (const id of ["model-missing-required", "model-orphan-fields"])
      expect(result.passed).not.toContain(id);
  });

  it("with SANITY_PROJECT_ID unset, the dataset checks name the variable (never a pass)", async () => {
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir(), {});
    const result = JSON.parse(r.out) as {
      passed: string[];
      couldNotCheck: Array<{ id: string; reason: string }>;
    };
    const reasons = Object.fromEntries(result.couldNotCheck.map((c) => [c.id, c.reason]));
    for (const id of [
      "model-missing-required",
      "model-orphan-fields",
      "model-listing-count",
      "model-dependents",
    ]) {
      expect(reasons[id], id).toContain("SANITY_PROJECT_ID is not set");
      expect(result.passed).not.toContain(id);
    }
  });

  it("without the file the model checks are not run: neither passed nor failed", async () => {
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir({}));
    const result = JSON.parse(r.out) as {
      passed: string[];
      findings: Array<{ checkId: string }>;
      couldNotCheck: Array<{ id: string }>;
    };
    for (const id of MODEL_CHECKS) {
      expect(result.passed).not.toContain(id);
      expect(result.findings.map((f) => f.checkId)).not.toContain(id);
      expect(result.couldNotCheck.map((c) => c.id)).not.toContain(id);
    }
  });

  it("a Sanity token is read from the environment, sent only in a header, and never printed", async () => {
    const requests: Request[] = [];
    const queries: SeenSanityRequest[] = [];
    const r = await run(
      [`https://${HOST}/`, "--no-open", "--verbose"],
      workdir(),
      { ...ENV, SANITY_TOKEN: TOKEN },
      requests,
      { ...FERNBROOK, token: TOKEN },
      queries,
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    for (const text of [r.out, r.err, JSON.stringify(requests)]) expect(text).not.toContain(TOKEN);
  });

  it("the schema path is read from the folder the command runs in, beside the file", async () => {
    const dir = workdir();
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], dir, ENV);
    expect(JSON.parse(r.out)).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ checkId: "model-missing-required" }),
      ]) as unknown[],
    });
  });
});
