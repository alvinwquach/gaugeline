import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGroq } from "@gaugeline/core";
import {
  CONTENT_MARKER,
  NORTHFIELD_CONTENT,
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";

const repo = fileURLToPath(new URL("../../../fixtures/repo-gql/", import.meta.url));
const ENV = { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" };

const EXPECTED = [
  "// resource, written from 12 published documents",
  "// publishedAt is present on 50% of the sample",
  "// gatedFile is present on 33% of the sample",
  '*[_type == "resource" && !(_id in path("drafts.**"))] | order(_updatedAt desc) {',
  "  _id,",
  "  title,",
  '  "slug": slug.current,',
  "  summary,",
  '  topic->{ _id, title, "slug": slug.current },',
  "  body,",
  '  heroImage{ "url": asset->url, "alt": coalesce(alt, "") },',
  "  tags[],",
  '  "publishedAt": coalesce(publishedAt, ""),',
  '  gatedFile{ "url": asset->url, "name": asset->originalFilename, "size": asset->size }',
  "}",
  "// This describes what your content has today, not what your page needs.",
  "// Delete what the page does not use: every field you ask for is data you pay to fetch and render.",
].join("\n");

const A = (value: unknown, optional = false) => ({ type: "objectAttribute", value, optional });
const STR = { type: "string" };
const doc = (name: string, attributes: Record<string, unknown>) => ({
  type: "document",
  name,
  attributes: { _id: A(STR), _type: A({ type: "string", value: name }), ...attributes },
});

async function suggest(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    spec?: FakeSanity;
    seen?: SeenSanityRequest[];
    cwd?: string;
    /** A schema extract to write to a folder of its own as schema.json, and run in. */
    schema?: unknown[];
  } = {},
) {
  const dir =
    options.schema === undefined ? undefined : mkdtempSync(join(tmpdir(), "gaugeline-suggest-"));
  if (dir !== undefined) writeFileSync(join(dir, "schema.json"), JSON.stringify(options.schema));
  const out: string[] = [];
  const err: string[] = [];
  try {
    return await run(argv, options, dir ?? options.cwd ?? repo, out, err);
  } finally {
    if (dir !== undefined)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    spec?: FakeSanity;
    seen?: SeenSanityRequest[];
  },
  cwd: string,
  out: string[],
  err: string[],
) {
  const code = await main(
    ["query", ...argv],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: options.env ?? ENV,
    },
    {
      cwd,
      now: () => new Date("2026-11-10T12:00:00Z"),
      fetcher: {
        transport: sanityCountsTransport(options.spec ?? NORTHFIELD_CONTENT, options.seen ?? []),
        timeoutMs: 5000,
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline query --suggest: unit (arguments)", () => {
  it("takes --suggest with --type and one folder", () => {
    expect(parseCliArgs(["query", "./src", "--suggest", "--type", "resource"])).toMatchObject({
      kind: "query",
      dir: "./src",
      suggest: { type: "resource" },
    });
  });

  it("--suggest without --type is a usage message that names the flag", () => {
    const r = parseCliArgs(["query", "./src", "--suggest"]);
    expect(r).toMatchObject({ kind: "error" });
    expect(r.kind === "error" && r.message).toContain("--suggest --type resource");
  });

  it("--type without --suggest, and --suggest beside another run, are refused", () => {
    expect(parseCliArgs(["query", "./src", "--type", "resource"])).toMatchObject({
      kind: "error",
    });
    for (const other of ["--graphql", "--dupes", "--mutations", "--json"])
      expect(
        parseCliArgs(["query", "./src", "--suggest", "--type", "resource", other]),
      ).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["query", "--suggest", "--type", "resource"])).toMatchObject({
      kind: "error",
    });
  });

  it("--type is not a flag of the other commands", () => {
    expect(parseCliArgs(["check", "https://example.com", "--type", "x"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("gaugeline query --suggest: e2e (CLI)", () => {
  it("prints the query for fixtures/repo-gql's schema and the dataset's resources, exit 0", async () => {
    const r = await suggest([".", "--suggest", "--type", "resource"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.trimEnd()).toBe(EXPECTED);
    expect(r.err).toBe("");
  });

  it("the query it prints parses with the reader from G27, and reads back as the shape it came from", async () => {
    const r = await suggest([".", "--suggest", "--type", "resource"]);
    const read = readGroq(r.out, { file: "suggested.groq", line: 1 });
    expect(read.unreadable).toEqual([]);
    expect(read.shapes).toHaveLength(1);
    expect(read.shapes[0]).toMatchObject({ type: "resource", excludesDrafts: true, params: [] });
    const paths = read.shapes[0]?.fields.map((f) => f.path) ?? [];
    for (const want of [
      "title",
      "slug.current",
      "topic->title",
      "heroImage.asset->url",
      "gatedFile.asset->originalFilename",
      "publishedAt",
    ])
      expect(paths, want).toContain(want);
  });

  it("sends one GET, drafts left out, newest first, and no value reaches the output", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await suggest([".", "--suggest", "--type", "resource"], { seen });
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    // Counts only: one object of count() calls over the newest 50 published documents.
    expect(seen[0]?.query).toMatch(
      /^\{"total":count\(\(\*\[_type == "resource" && !\(_id in path\("drafts\.\*\*"\)\)\] \| order\(_updatedAt desc\)\[0\.\.\.50\]\)\)/,
    );
    for (const text of [r.out, r.err, JSON.stringify(seen)])
      expect(text.toLowerCase()).not.toContain(CONTENT_MARKER.toLowerCase());
  });

  it("writes no file: the folder is the same after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-suggest-"));
    try {
      writeFileSync(join(dir, "page.ts"), "export {};\n");
      copyFileSync(join(repo, "schema.json"), join(dir, "schema.json"));
      const ran = await suggest([".", "--suggest", "--type", "resource"], { cwd: dir });
      expect(ran.code).toBe(EXIT.ok);
      expect(readdirSync(dir)).toEqual(["page.ts", "schema.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("--quiet leaves stderr empty", async () => {
    const r = await suggest([".", "--suggest", "--type", "resource", "--quiet"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
  });

  it("says SANITY_DATASET was assumed when it is unset", async () => {
    const r = await suggest([".", "--suggest", "--type", "resource"], {
      env: { SANITY_PROJECT_ID: "northfield" },
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toContain('SANITY_DATASET is not set, so the dataset "production" was assumed');
  });
});

describe("gaugeline query --suggest: edge cases", () => {
  it("a type with no documents: 'Nothing of type topic exists', exit 2, no query printed", async () => {
    const r = await suggest([".", "--suggest", "--type", "topic"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("Nothing of type topic exists");
    expect(r.err).toContain("Studio schema");
  });

  it("a type that has only drafts has nothing published", async () => {
    const r = await suggest([".", "--suggest", "--type", "page"], {
      schema: [doc("page", { title: A(STR) })],
      spec: {
        types: {},
        content: {
          page: [{ _id: "drafts.page-1", _type: "page", _updatedAt: "2026-10-01", title: "a" }],
        },
      },
    });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("Nothing of type page exists");
  });

  it("a type the schema does not declare is exit 2, names the types it has, and requests nothing", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await suggest([".", "--suggest", "--type", "recipe"], { seen });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain('no document type named "recipe"');
    expect(r.err).toContain("resource, topic, coach");
    expect(seen).toEqual([]);
  });

  it("with no schema.json it is exit 2, names --schema and `sanity schema extract`, and requests nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-suggest-"));
    try {
      const seen: SeenSanityRequest[] = [];
      const r = await suggest([".", "--suggest", "--type", "resource"], { cwd: dir, seen });
      expect(r.code).toBe(EXIT.couldNotRun);
      expect(r.out).toBe("");
      expect(r.err).toContain("gaugeline query --suggest needs the schema");
      expect(r.err).toContain("--schema");
      expect(r.err).toContain("sanity schema extract");
      expect(seen).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("--schema names the file, anywhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-suggest-"));
    try {
      copyFileSync(join(repo, "schema.json"), join(dir, "studio-schema.json"));
      const r = await suggest(
        [".", "--suggest", "--type", "resource", "--schema", join(dir, "studio-schema.json")],
        { cwd: dir },
      );
      expect(r.code).toBe(EXIT.ok);
      expect(r.out.trimEnd()).toBe(EXPECTED);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("--suggest without --type: usage message, exit 2, nothing requested", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await suggest([".", "--suggest"], { seen });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("gaugeline query --suggest needs a document type");
    expect(r.err).toContain("--suggest --type resource");
    expect(seen).toEqual([]);
  });

  it("a type with fewer documents than the sample says the real number in the header", async () => {
    const r = await suggest([".", "--suggest", "--type", "post"], {
      schema: [doc("post", { title: A(STR) })],
      spec: {
        types: {},
        content: {
          post: [3, 2, 1].map((i) => ({
            _id: `post-${i}`,
            _type: "post",
            _updatedAt: `2026-10-0${i}T00:00:00Z`,
            title: `a ${i}`,
          })),
        },
      },
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.split("\n")[0]).toBe("// post, written from 3 published documents");
  });

  it("a field the schema lets be a string or an object is plain, with a comment naming both kinds", async () => {
    const r = await suggest([".", "--suggest", "--type", "post"], {
      schema: [
        doc("post", {
          title: A(STR),
          credit: A({ type: "union", of: [STR, { type: "object", attributes: { name: A(STR) } }] }),
        }),
      ],
      spec: {
        types: {},
        content: {
          post: [
            { _id: "a", _type: "post", _updatedAt: "2026-10-02", title: "x", credit: "text" },
            {
              _id: "b",
              _type: "post",
              _updatedAt: "2026-10-01",
              title: "y",
              credit: { name: "n" },
            },
          ],
        },
      },
    });
    expect(r.err).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("// credit can be a string or an object (the schema allows both)");
    expect(r.out).toContain("\n  credit\n}");
  });

  it("exits 2 with one message when the project id is missing, and requests nothing", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await suggest([".", "--suggest", "--type", "resource"], { env: {}, seen });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("SANITY_PROJECT_ID");
    expect(seen).toEqual([]);
  });

  it("exits 2 when the folder does not exist", async () => {
    const r = await suggest([join(repo, "nowhere"), "--suggest", "--type", "resource"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("does not exist");
  });

  it("a private dataset with no token is exit 2 and names SANITY_TOKEN", async () => {
    const r = await suggest([".", "--suggest", "--type", "resource"], {
      spec: { ...NORTHFIELD_CONTENT, token: true },
    });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("SANITY_TOKEN");
  });

  it("a type name with a quote in it is refused before any request", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await suggest([".", "--suggest", "--type", 'x"] || true //'], { seen });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("not a Sanity document type name");
    expect(seen).toEqual([]);
  });

  it("--help describes --suggest and --type", async () => {
    const out: string[] = [];
    const code = await main(["query", "--help"], {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: () => true },
      env: {},
    });
    expect(code).toBe(EXIT.ok);
    expect(out.join("")).toContain("--suggest");
    expect(out.join("")).toContain("--type");
  });
});
