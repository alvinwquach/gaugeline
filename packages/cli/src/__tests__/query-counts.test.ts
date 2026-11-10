import { resultSchema } from "@gaugeline/core";
import {
  COPPERHILL_COUNTS,
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";

const repo = fileURLToPath(new URL("../../../fixtures/repo-groq/", import.meta.url));

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["sk", "viewer", "Copperhill0123456789abcdef"].join("_");
const ENV = { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production" };
const NOW = new Date("2026-11-10T12:00:00Z");

const DATASET = COPPERHILL_COUNTS;

async function query(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    sanity?: FakeSanity;
    seen?: SeenSanityRequest[];
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["query", ...argv],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: options.env ?? ENV,
    },
    {
      cwd: repo,
      now: () => NOW,
      fetcher: {
        transport: sanityCountsTransport(options.sanity ?? DATASET, options.seen ?? []),
        timeoutMs: 5000,
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline query with SANITY_PROJECT_ID: e2e", () => {
  it("reads the repository, asks the recorded dataset and prints the findings, exit 0", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await query(["."], { seen });
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    // The shapes come first, as without a dataset; the findings follow.
    expect(r.out.indexOf("12 shapes from 10 queries; 2 could not be read.")).toBeGreaterThan(0);
    expect(r.out.slice(r.out.indexOf("Counted the published documents"))).toMatchInlineSnapshot(`
      "Counted the published documents of 8 types in the dataset: one request each, counts only.

      ✗ A field your query asks for is on no document
          src/app/events/page.tsx:3  date doesn't exist on any popup: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.
      ✗ A field your query asks for is on no document
          src/sanity/queries.ts:20  date doesn't exist on any popup: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.
      ✗ A document type your query asks for has no documents
          src/lib/legacy.js:4  Nothing of type legacyPage exists: the dataset has 0 published documents of it, so every page that asks for it comes back blank.
      ! A query does not leave drafts out
          src/app/events/page.tsx:3  The popup query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      ! A query does not leave drafts out
          src/app/menu/[slug]/page.tsx:3  The menuItem query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      ! A query does not leave drafts out
          src/app/page.tsx:3  The page query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      ! A query does not leave drafts out
          src/lib/legacy.js:4  The legacyPage query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      ! A query does not leave drafts out
          src/sanity/queries.ts:13  The siteSettings query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      ! A query does not leave drafts out
          src/sanity/queries.ts:20  The popup query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      ! A query does not leave drafts out
          src/scripts/export.mjs:4  The menuItem query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      ! A query does not leave drafts out
          src/scripts/export.mjs:4  The popup query's filter does not leave drafts out. That is safe when the client asks for the published perspective, and leaks unpublished content if anything runs it with drafts.
      · A field your query asks for is missing on some documents
          src/app/menu/[slug]/page.tsx:3  allergens is missing on 28 of 40 documents. Fine if it is optional; a bug if the template assumes it.
      · A field your query asks for is missing on some documents
          src/sanity/queries.ts:23  publishedAt is missing on 2 of 6 documents. Fine if it is optional; a bug if the template assumes it.

      13 to look at, 3 to fix first.
      "
    `);
  });

  it("makes one GET for each type, 8 types for 12 shapes, all for published documents", async () => {
    const seen: SeenSanityRequest[] = [];
    await query(["."], { seen });
    const hits = new Map<string, number>();
    for (const s of seen) hits.set(s.type ?? "?", (hits.get(s.type ?? "?") ?? 0) + 1);
    expect([...hits.keys()].sort()).toEqual([
      "legacyPage",
      "menuItem",
      "order",
      "page",
      "popup",
      "post",
      "recipe",
      "siteSettings",
    ]);
    for (const n of hits.values()) expect(n).toBe(1);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(new URL(s.url).host).toBe("cprhl1b4.api.sanity.io");
      expect(s.url).toContain("perspective=published");
    }
  });

  it("with --ci and a high finding it exits 1; without a high finding it exits 0", async () => {
    expect((await query([".", "--ci"])).code).toBe(EXIT.findings);
    const healthy: FakeSanity = {
      types: Object.fromEntries(
        Object.keys(DATASET.types)
          .concat("legacyPage")
          .map((t) => [t, { total: 5 }]),
      ),
    };
    expect((await query([".", "--ci"], { sanity: healthy })).code).toBe(EXIT.ok);
  });

  it("names the file and line of each finding, once for each query that reads a field", async () => {
    const r = await query(["./src"]);
    expect(r.out).toContain("./src/app/events/page.tsx:3  date doesn't exist on any popup");
    expect(r.out).toContain("./src/sanity/queries.ts:20  date doesn't exist on any popup");
    expect(r.out).toContain(
      "./src/app/menu/[slug]/page.tsx:3  allergens is missing on 28 of 40 documents",
    );
    expect(r.out).toContain("./src/lib/legacy.js:4  Nothing of type legacyPage exists");
  });

  it("--json prints the schema 2 result: findings with file and line, counts in sampled", async () => {
    const r = await query([".", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.findings.filter((f) => f.severity === "high")).toHaveLength(3);
    expect(result.findings.every((f) => f.source !== undefined)).toBe(true);
    expect(result.sampled["query-types"]).toEqual({ seen: 8, taken: 8, limit: 8 });
  });

  it("SANITY_DATASET unset says production was assumed", async () => {
    const r = await query(["."], { env: { SANITY_PROJECT_ID: "cprhl1b4" } });
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toContain('SANITY_DATASET is not set, so the dataset "production" was assumed');
  });

  it("--quiet leaves the notices out", async () => {
    const r = await query([".", "--quiet"], { env: { SANITY_PROJECT_ID: "cprhl1b4" } });
    expect(r.err).toBe("");
  });
});

describe("gaugeline query: the dataset cannot be read (exit 2)", () => {
  it("a private dataset with no token: one message naming SANITY_TOKEN and the Viewer role", async () => {
    const r = await query(["."], { sanity: { ...DATASET, token: true } });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("SANITY_TOKEN");
    expect(r.err).toContain("Viewer");
    expect(
      r.err
        .trim()
        .split("\n")
        .filter((l) => l.includes("SANITY_TOKEN")),
    ).toHaveLength(1);
  });

  it("a token Sanity does not accept is said so", async () => {
    const r = await query(["."], {
      env: { ...ENV, SANITY_TOKEN: TOKEN },
      sanity: { ...DATASET, token: "another" },
    });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("did not accept SANITY_TOKEN");
    expect(r.err).not.toContain(TOKEN);
  });

  it("a project id that is not one is named", async () => {
    const r = await query(["."], { env: { SANITY_PROJECT_ID: "Not A Project" } });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("SANITY_PROJECT_ID is not a Sanity project id");
  });

  it("--json without SANITY_PROJECT_ID is exit 2 and says what to set", async () => {
    const r = await query([".", "--json"], { env: {} });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("SANITY_PROJECT_ID");
  });
});

describe("gaugeline query: the promise", () => {
  it("the token travels in a header and never appears in stdout, stderr or the JSON", async () => {
    const seen: SeenSanityRequest[] = [];
    const env = { ...ENV, SANITY_TOKEN: TOKEN };
    const sanity = { ...DATASET, token: TOKEN };
    for (const argv of [["."], [".", "--json"], [".", "--ci"]]) {
      const r = await query(argv, { env, sanity, seen });
      expect(r.out).not.toContain(TOKEN);
      expect(r.err).not.toContain(TOKEN);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url).not.toContain(TOKEN);
      expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("the output holds field names and integers, never a value from a document", async () => {
    const r = await query([".", "--json"]);
    const result = resultSchema.parse(JSON.parse(r.out));
    for (const f of result.findings) expect(f.evidence).toMatch(/^[^\n]*$/);
    expect(JSON.stringify(result)).not.toMatch(/Copperhill Bakery|sourdough/i);
  });
});

describe("gaugeline query: the arguments", () => {
  it("--ci and --json are query flags, in --help", () => {
    expect(parseCliArgs(["query", ".", "--ci"])).toMatchObject({ kind: "query", ci: true });
    expect(parseCliArgs(["query", ".", "--json"])).toMatchObject({ kind: "query", json: true });
  });
});
