import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Transport } from "@gaugeline/core";
import { COPPERHILL_COUNTS, NORTHFIELD_CONTENT, sanityCountsTransport } from "@gaugeline/testkit";
import { EXIT, main } from "../main.js";

/**
 * docs/query-check.md shows `npx gaugeline query ./src/app` and what it prints. The docs runner
 * (pnpm docs:examples) points every example at a fixture website, and this command reads a folder,
 * so this test runs the page's own command in the invented bakery repository
 * (packages/fixtures/repo-groq) and compares the Output block with what the CLI prints.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/query-check.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const repo = fileURLToPath(new URL("../../../fixtures/repo-groq/", import.meta.url));
const writes = fileURLToPath(new URL("../../../fixtures/repo-mutations/", import.meta.url));
const gql = fileURLToPath(new URL("../../../fixtures/repo-gql/", import.meta.url));
const clinic = fileURLToPath(new URL("../../../fixtures/repo-unused/", import.meta.url));
const introspection = readFileSync(join(gql, "sanity-introspection.json"), "utf8");

/** Sanity's two addresses, recorded: the GraphQL one answers the schema, the query one counts. */
const northfield: Transport = (url, req) =>
  url.pathname.startsWith("/v1/graphql/")
    ? Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from(introspection)]),
      })
    : sanityCountsTransport({
        types: { resource: { total: 9, defined: { summary: 0 } }, event: { total: 4 } },
      })(url, req);

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

/**
 * Each `$ [SANITY_PROJECT_ID=...] npx gaugeline query <folder>` block with the Output block after
 * it. An example with a project id is run against the invented Copperhill dataset.
 */
function examples(): Array<{ command: string; env: Record<string, string>; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; env: Record<string, string>; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    const m =
      /^\$ (SANITY_PROJECT_ID=([a-z0-9]+) )?npx gaugeline (query \S+(?: --dupes| --mutations| --unused| --suggest --type \w+| --graphql(?: --schema \S+)?)?)$/.exec(
        f.body,
      );
    if (!/title=Terminal/.test(f.info) || !m) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({
      command: m[3] ?? "",
      env: m[2] ? { SANITY_PROJECT_ID: m[2], SANITY_DATASET: "production" } : {},
      expected: next.body,
    });
  });
  return out;
}

describe("docs/query-check.md: the command it shows", () => {
  it("has the example it describes", () => {
    expect(examples().map((e) => e.command)).toEqual([
      "query ./src/app",
      "query ./src/app",
      "query ./src --suggest --type resource",
      "query . --graphql",
      "query . --graphql --schema ./schema.graphql",
      "query ./app --mutations",
      "query ./src --unused",
      "query ./src/app/menu --dupes",
    ]);
  });

  it("prints what the page says", async () => {
    for (const e of examples()) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        e.command.split(/\s+/),
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: (s) => err.push(s) },
          env: e.env,
        },
        {
          // The mutations example runs in the invented studio repository, whose schema.json is the default.
          cwd:
            e.command.includes("--graphql") || e.command.includes("--suggest")
              ? gql
              : e.command.includes("--mutations")
                ? writes
                : e.command.includes("--unused")
                  ? clinic
                  : repo,
          now: () => new Date("2026-11-10T12:00:00Z"),
          fetcher: {
            transport: e.command.includes("--graphql")
              ? northfield
              : e.command.includes("--suggest")
                ? sanityCountsTransport(NORTHFIELD_CONTENT)
                : sanityCountsTransport(COPPERHILL_COUNTS),
            timeoutMs: 5000,
          },
        },
      );
      expect(code, e.command).toBe(EXIT.ok);
      if (e.env.SANITY_PROJECT_ID) expect(err.join(""), e.command).toBe("");
      else if (
        e.command.includes("--mutations") ||
        e.command.includes("--graphql") ||
        e.command.includes("--unused")
      )
        expect(err.join(""), e.command).toBe("");
      else expect(err.join(""), e.command).toContain("SANITY_PROJECT_ID is not set");
      expect(out.join("").trimEnd(), e.command).toBe(e.expected);
    }
  });

  it("the duplicates example names the ids, and what --dupes reads", () => {
    for (const word of [
      "query-dupe-slug",
      "query-dupe-title",
      "`_id`, its `slug.current` and its `title`",
      "Viewer role",
      "ten at most",
      "never in the address",
    ])
      expect(page, word).toContain(word);
  });

  it("the mutations section names the five findings, the schema file, and the promise", () => {
    for (const word of [
      "mutation-undeclared-field",
      "mutation-missing-required",
      "mutation-ref-as-string",
      "mutation-no-drafts",
      "mutation-shared-field",
      "npx sanity schema extract",
      "--schema",
      "./schema.json",
      "cannot import the fetcher",
      "It never sends them.",
      "Larkspur Yoga Studio",
    ])
      expect(page, word).toContain(word);
  });

  it("the GraphQL section says how it asks, what it reads, and what it never sends", () => {
    for (const word of [
      "graphql-field-not-in-schema",
      "--schema ./schema.graphql",
      "never sends a `POST`",
      "GRAPHQL_TOKEN",
      "SANITY_TOKEN",
      "parsed, counted and never sent",
      "Northfield Coaching",
      "exit code 2",
    ])
      expect(page, word).toContain(word);
  });

  it("the unused-fields section says what it reads, what it will not report, and the promise", () => {
    for (const word of [
      "query-field-unused",
      "could not follow",
      "`_id`, `_type`, `_key` and `_rev`",
      "no environment variable is read at all",
      "JSON.stringify",
      "`generateMetadata`",
      "cannot import the fetcher",
      "Marlow Physiotherapy",
      "--unused",
    ])
      expect(page, word).toContain(word);
  });

  it("the page names the three reasons a query is unreadable, and what it reads", () => {
    for (const word of [
      "concatenated",
      "parse-error",
      "no-type-filter",
      "defineQuery",
      "groq",
      ".mjs",
      ".gitignore",
      "npx -p gaugeline -p typescript",
    ])
      expect(page, word).toContain(word);
  });
});

describe("docs/query-check.md: the route it scaffolds", () => {
  const COMMAND =
    '$ SANITY_PROJECT_ID=northfield npx gaugeline query --page --type resource --out "./src/app/resource/[slug]"';

  it("the command it shows writes the files it shows, and prints the output it shows", async () => {
    const all = fences();
    const at = all.findIndex((f) => f.body === COMMAND);
    expect(at, "the example command is on the page").toBeGreaterThanOrEqual(0);
    expect(all[at + 1]?.info).toMatch(/title="?Output/);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-docs-page-")));
    try {
      copyFileSync(join(gql, "schema.json"), join(dir, "schema.json"));
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        ["query", "--page", "--type", "resource", "--out", "./src/app/resource/[slug]"],
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: (s) => err.push(s) },
          env: { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" },
        },
        {
          cwd: dir,
          now: () => new Date("2026-11-10T12:00:00Z"),
          fetcher: { transport: sanityCountsTransport(NORTHFIELD_CONTENT), timeoutMs: 5000 },
        },
      );
      expect(code).toBe(EXIT.ok);
      expect(err.join("")).toBe("");
      expect(out.join("").trimEnd()).toBe(all[at + 1]?.body);
      for (const name of ["queries.ts", "types.ts", "page.tsx"]) {
        const shown = all.filter((f) =>
          new RegExp(`title="?${name.replace(".", "\\.")}"?(\\s|$)`).test(f.info),
        );
        expect(shown, name).toHaveLength(1);
        expect(
          readFileSync(join(dir, "src", "app", "resource", "[slug]", name), "utf8").trimEnd(),
        ).toBe(shown[0]?.body);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("the page says what it assumes and how the files are written", () => {
    for (const word of [
      "metadataBase",
      "@/sanity/lib/client",
      "`params` is a promise",
      "It never overwrites.",
      "All three files or none.",
      "`--force` replaces those three files, and never a folder or a link",
      "Every path is printed.",
      "runs no git command",
      "Northfield Coaching",
    ])
      expect(page, word).toContain(word);
  });
});
