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
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";

const repo = fileURLToPath(new URL("../../../fixtures/repo-groq/", import.meta.url));

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["sk", "viewer", "Copperhill0123456789abcdef"].join("_");
const ENV = { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production" };
const NOW = new Date("2026-11-10T12:00:00Z");

/** Every type exists with documents and every field is on every document: no count finding. */
const HEALTHY: FakeSanity = {
  documents: COPPERHILL_COUNTS.documents ?? {},
  types: Object.fromEntries(
    Object.keys(COPPERHILL_COUNTS.types)
      .concat("legacyPage")
      .map((t) => [t, { total: 5 }]),
  ),
};

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
        transport: sanityCountsTransport(options.sanity ?? COPPERHILL_COUNTS, options.seen ?? []),
        timeoutMs: 5000,
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline query --dupes: e2e", () => {
  it("prints the cross for the slug and the exclamation mark for the title", async () => {
    const r = await query([".", "--dupes"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    expect(r.out).toContain(
      "\u2717 2 menuItem documents share the slug \u201Csourdough-loaf\u201D\n    Only one can own the address. menu-sourdough, menu-sourdough-old",
    );
    expect(r.out).toContain(
      "! 2 menuItem documents are called \u201CSeeded rye\u201D\n    Different addresses, same thing. menu-rye, menu-rye-copy",
    );
    // The line that says what was read comes before the findings.
    expect(r.out.indexOf("Read the ids, slugs and titles")).toBeGreaterThan(
      r.out.indexOf("Counted the published documents"),
    );
  });

  it("with --ci it exits 1 for the shared slug alone, and without --dupes the same dataset exits 0", async () => {
    expect((await query([".", "--dupes", "--ci"], { sanity: HEALTHY })).code).toBe(EXIT.findings);
    expect((await query([".", "--ci"], { sanity: HEALTHY })).code).toBe(EXIT.ok);
  });

  it("a title shared by two documents is only a warning: --ci exits 0", async () => {
    const titlesOnly: FakeSanity = {
      ...HEALTHY,
      documents: {
        menuItem: [
          { _id: "menu-rye", slug: "seeded-rye", title: "Seeded rye" },
          { _id: "menu-rye-copy", slug: "rye-seeded", title: "Seeded rye" },
        ],
      },
    };
    const r = await query([".", "--dupes", "--ci"], { sanity: titlesOnly });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("2 menuItem documents are called");
    expect(r.out).not.toContain("share the slug");
  });

  it("makes one more GET for each type: 8 types, 16 requests, every one a published-perspective GET", async () => {
    const seen: SeenSanityRequest[] = [];
    await query([".", "--dupes"], { seen });
    expect(seen).toHaveLength(16);
    const listings = seen.filter((s) => s.query.startsWith("*["));
    expect(listings).toHaveLength(8);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url).toContain("perspective=published");
    }
    for (const s of listings)
      expect(s.query).toBe(`*[_type == "${s.type}"]{_id,"slug":slug.current,title}`);
  });

  it("without --dupes nothing asks for a slug or a title, and the output shows none", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await query(["."], { seen });
    expect(seen).toHaveLength(8);
    expect(seen.filter((s) => s.query.startsWith("*["))).toEqual([]);
    expect(seen.map((s) => s.query).join("")).not.toContain("title,");
    expect(r.out).not.toMatch(/share the slug|are called|sourdough/i);
  });

  it("--json adds the two findings to the schema 2 result; the other findings keep their file and line", async () => {
    const r = await query([".", "--dupes", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    const result = resultSchema.parse(JSON.parse(r.out));
    const dupes = result.findings.filter((f) => f.checkId.startsWith("query-dupe-"));
    expect(dupes.map((f) => [f.checkId, f.severity, f.url])).toEqual([
      ["query-dupe-slug", "high", "sanity:menuItem"],
      ["query-dupe-title", "medium", "sanity:menuItem"],
    ]);
    expect(
      result.findings.filter((f) => !f.checkId.startsWith("query-dupe-")).every((f) => f.source),
    ).toBe(true);
  });

  it("--dupes without SANITY_PROJECT_ID is exit 2, says what to set and makes no request", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await query([".", "--dupes"], { env: {}, seen });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("SANITY_PROJECT_ID");
    expect(seen).toEqual([]);
  });
});

describe("gaugeline query --dupes: the promise", () => {
  it("the token travels in a header and never appears in stdout, stderr or the JSON", async () => {
    const seen: SeenSanityRequest[] = [];
    const env = { ...ENV, SANITY_TOKEN: TOKEN };
    const sanity = { ...COPPERHILL_COUNTS, token: TOKEN };
    for (const argv of [
      [".", "--dupes"],
      [".", "--dupes", "--json"],
      [".", "--dupes", "--ci"],
    ]) {
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

  it("a private dataset with no token stops with exit 2 and names the token", async () => {
    const r = await query([".", "--dupes"], { sanity: { ...COPPERHILL_COUNTS, token: true } });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("SANITY_TOKEN");
  });

  it("shows only titles and slugs that two documents share, and never a document that has none shared", async () => {
    const r = await query([".", "--dupes"]);
    for (const hidden of ["Baguette", "Gift box", "Sunday market", "Home"])
      expect(r.out).not.toContain(hidden);
  });
});

describe("gaugeline query --dupes: the arguments", () => {
  it("--dupes is a query flag, in --help and in the flag list", () => {
    expect(parseCliArgs(["query", ".", "--dupes"])).toMatchObject({ kind: "query", dupes: true });
    expect(parseCliArgs(["query", "."])).toMatchObject({ kind: "query", dupes: false });
    expect(FLAGS.find((f) => f.name === "dupes")?.commands).toEqual(["query"]);
    expect(HELP.query).toContain("--dupes");
  });

  it("--dupes is refused by the commands that do not have it", () => {
    expect(parseCliArgs(["check", "https://example.com", "--dupes"]).kind).toBe("error");
  });
});
