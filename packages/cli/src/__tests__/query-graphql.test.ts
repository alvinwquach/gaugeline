import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resultSchema, type Transport } from "@gaugeline/core";
import {
  sanityCountsTransport,
  startGraphqlServer,
  type FakeSanity,
  type GraphqlServer,
} from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";

const repo = fileURLToPath(new URL("../../../fixtures/repo-gql/", import.meta.url));
const recorded: unknown = JSON.parse(readFileSync(join(repo, "sanity-introspection.json"), "utf8"));

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const GRAPHQL_TOKEN = ["gq", "viewer", "Northfield0123456789abcdef"].join("_");
const SANITY_TOKEN = ["sk", "viewer", "Northfield9876543210fedcba"].join("_");
const NOW = new Date("2026-11-10T12:00:00Z");

const DATASET: FakeSanity = {
  types: { resource: { total: 9, defined: { summary: 0 } }, event: { total: 4 } },
};

const servers: GraphqlServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
async function serve(options: Parameters<typeof startGraphqlServer>[0]): Promise<GraphqlServer> {
  const s = await startGraphqlServer(options);
  servers.push(s);
  return s;
}

async function query(
  argv: string[],
  options: { env?: Record<string, string | undefined>; transport?: Transport; cwd?: string } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["query", ...argv],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: options.env ?? {},
    },
    {
      cwd: options.cwd ?? repo,
      now: () => NOW,
      fetcher: { ...(options.transport ? { transport: options.transport } : {}), timeoutMs: 5000 },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

/** Sanity's two addresses: the GraphQL one answers the recorded schema, the query one counts. */
function sanityTransport(
  seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [],
): Transport {
  const counts = sanityCountsTransport(DATASET);
  return (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    if (url.pathname.startsWith("/v1/graphql/"))
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from(JSON.stringify(recorded))]),
      });
    return counts(url, req);
  };
}

describe("gaugeline query --graphql: a local endpoint", () => {
  it("prints the endpoint first, then what it read, then the fields the schema does not have", async () => {
    const server = await serve({ introspection: recorded });
    const r = await query([".", "--graphql", server.url, "--allow-private"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    expect(r.out.split("\n")[0]).toBe(`GraphQL  ${server.url}`);
    expect(r.out.replaceAll(server.url, "http://127.0.0.1:<port>/graphql")).toMatchInlineSnapshot(`
      "GraphQL  http://127.0.0.1:<port>/graphql
      Read 3 queries and 1 fragment in 5 files: 17 fields checked against the schema.
      Found 1 mutation and 1 subscription. They were parsed and counted, and never sent.

      Could not read 1 document:
        src/lib/dynamic.ts:5  concatenated: built from something other than a gql template (an interpolated string or call), so it cannot be read from the file

      This is not a Sanity endpoint, so the content counts were skipped: only a Sanity dataset can be counted.

      ✗ author isn't in the schema
          allResource.author · gql/resources.graphql:1
      ✗ nickname isn't in the schema
          Resource.coach.nickname · src/lib/fragments.ts:4

      2 to look at, 2 to fix first.
      "
    `);
  });

  it("--ci exits 1 on a field the schema does not have, and --json prints the schema 2 result", async () => {
    const server = await serve({ introspection: recorded });
    expect((await query([".", "--graphql", server.url, "--allow-private", "--ci"])).code).toBe(
      EXIT.findings,
    );
    const r = await query([".", "--graphql", server.url, "--allow-private", "--json"]);
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.findings.map((f) => f.checkId)).toEqual([
      "graphql-field-not-in-schema",
      "graphql-field-not-in-schema",
    ]);
    expect(result.findings[0]?.source).toEqual({ file: "gql/resources.graphql", line: 1 });
  });

  it("an address on this computer needs --allow-private", async () => {
    const server = await serve({ introspection: recorded });
    const r = await query([".", "--graphql", server.url]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(server.requests).toHaveLength(0);
  });

  it("sends GRAPHQL_TOKEN in a header and never SANITY_TOKEN to an endpoint that is not Sanity's", async () => {
    const server = await serve({ introspection: recorded, token: GRAPHQL_TOKEN });
    const env = { GRAPHQL_TOKEN, SANITY_TOKEN };
    const r = await query([".", "--graphql", server.url, "--allow-private", "--json"], { env });
    expect(r.code).toBe(EXIT.ok);
    expect(server.requests.map((q) => q.headers.authorization)).toEqual([
      `Bearer ${GRAPHQL_TOKEN}`,
    ]);
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain(GRAPHQL_TOKEN);
      expect(text).not.toContain(SANITY_TOKEN);
    }
    // Without GRAPHQL_TOKEN the Sanity token is not offered, and the server refuses.
    const refused = await query([".", "--graphql", server.url, "--allow-private"], {
      env: { SANITY_TOKEN },
    });
    expect(refused.code).toBe(EXIT.couldNotRun);
    expect(refused.err).toContain("GRAPHQL_TOKEN");
    expect(server.requests.at(-1)?.headers.authorization).toBeUndefined();
    expect(refused.out + refused.err).not.toContain(SANITY_TOKEN);
  });

  it("every request the server records is a GET with no body, and a repository with 3 mutations sends none", async () => {
    const server = await serve({ introspection: recorded });
    // The invented repository holds a mutation and a subscription; a second folder holds three mutations.
    const mutations = fileURLToPath(new URL("../../../fixtures/repo-mutations/", import.meta.url));
    await query([".", "--graphql", server.url, "--allow-private"]);
    await query([mutations, "--graphql", server.url, "--allow-private"]);
    expect(server.requests.length).toBe(2);
    for (const q of server.requests) {
      expect(q.method).toBe("GET");
      expect(q.body).toBe("");
      expect(q.url.toLowerCase()).not.toContain("mutation");
    }
  });
});

describe("gaugeline query --graphql: the endpoint will not give its schema (exit 2)", () => {
  it("introspection turned off: exit 2 with the --schema hint", async () => {
    const server = await serve({ introspection: recorded, mode: "disabled" });
    const r = await query([".", "--graphql", server.url, "--allow-private"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("introspection is probably turned off");
    expect(r.err).toContain("--schema");
  });

  it("an endpoint that answers the GET with 405: the same message, and no POST is attempted", async () => {
    const server = await serve({ introspection: recorded, mode: "get-405" });
    const r = await query([".", "--graphql", server.url, "--allow-private"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("HTTP 405");
    expect(r.err).toContain("--schema");
    expect(server.requests.map((q) => q.method)).toEqual(["GET"]);
  });
});

describe("gaugeline query --graphql: Sanity's endpoint", () => {
  const env = { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" };

  it("with no endpoint asks Sanity's GraphQL API for the project, then counts the same types", async () => {
    const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const r = await query([".", "--graphql"], { env, transport: sanityTransport(seen) });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toMatchInlineSnapshot(`
      "GraphQL  https://northfield.api.sanity.io/v1/graphql/production/default
      Read 3 queries and 1 fragment in 5 files: 17 fields checked against the schema.
      Found 1 mutation and 1 subscription. They were parsed and counted, and never sent.

      Could not read 1 document:
        src/lib/dynamic.ts:5  concatenated: built from something other than a gql template (an interpolated string or call), so it cannot be read from the file

      Counted the published documents of 2 types in the dataset: one request each, counts only.

      ✗ author isn't in the schema
          allResource.author · gql/resources.graphql:1
      ✗ nickname isn't in the schema
          Resource.coach.nickname · src/lib/fragments.ts:4
      ✗ A field your query asks for is on no document
          src/lib/queries.ts:5  summary doesn't exist on any resource: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.
      ✓ query-type-empty
      ✓ query-field-partial
      ✓ query-no-drafts-filter

      3 to look at, 3 to fix first.
      "
    `);
    // The schema is one GET, and the counts are one GET for each type.
    expect(seen.map((q) => q.method)).toEqual(["GET", "GET", "GET"]);
    expect(seen[0]?.url).toContain("/v1/graphql/production/default?query=");
    expect(seen.slice(1).every((q) => q.url.includes("/data/query/production"))).toBe(true);
  });

  it("sends SANITY_TOKEN to Sanity, in a header, and prints it nowhere", async () => {
    const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const r = await query([".", "--graphql"], {
      env: { ...env, SANITY_TOKEN },
      transport: sanityTransport(seen),
    });
    expect(r.code).toBe(EXIT.ok);
    expect(seen.every((q) => q.headers.authorization === `Bearer ${SANITY_TOKEN}`)).toBe(true);
    expect(seen.every((q) => !q.url.includes(SANITY_TOKEN))).toBe(true);
    expect(r.out + r.err).not.toContain(SANITY_TOKEN);
  });

  it("an address that names another project and dataset is the one that is counted", async () => {
    const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    await query([".", "--graphql", "https://other1.api.sanity.io/v1/graphql/staging/default"], {
      env,
      transport: (url, req) => sanityTransport(seen)(url, req),
    });
    expect(seen[0]?.url).toContain("other1.api.sanity.io/v1/graphql/staging/default");
    expect(seen[1]?.url).toContain("other1.api.sanity.io");
    expect(seen[1]?.url).toContain("/data/query/staging");
  });

  it("needs SANITY_PROJECT_ID when no endpoint is given, and says what to set", async () => {
    const r = await query([".", "--graphql"], { env: {} });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("SANITY_PROJECT_ID");
    expect(r.err).toContain("--schema");
  });

  it("says the dataset was assumed", async () => {
    const r = await query([".", "--graphql"], {
      env: { SANITY_PROJECT_ID: "northfield" },
      transport: sanityTransport(),
    });
    expect(r.err).toContain('SANITY_DATASET is not set, so the dataset "production" was assumed');
  });
});

describe("gaugeline query --graphql --schema <file>", () => {
  /** A transport that fails the test if anything asks the network. */
  const nothing: Transport = () => {
    throw new Error("a request was made");
  };

  it("reads an SDL file and asks no endpoint; with no project id it says the content was not compared", async () => {
    const r = await query([".", "--graphql", "--schema", "schema.graphql"], { transport: nothing });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.split("\n")[0]).toBe("GraphQL  schema from schema.graphql");
    expect(r.out).toContain(
      "SANITY_PROJECT_ID is not set, so the queries were not compared with your content.",
    );
    expect(r.out).toContain("author isn't in the schema");
  });

  it("reads introspection JSON too, and counts the content when the project is named", async () => {
    const counts = sanityCountsTransport(DATASET);
    const r = await query([".", "--graphql", "--schema", "sanity-introspection.json"], {
      env: { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" },
      transport: counts,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Counted the published documents of 2 types in the dataset");
    expect(r.out).toContain("summary doesn't exist on any resource");
  });

  it("a schema with no Sanity documents has nothing to count, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-gql-cli-"));
    try {
      writeFileSync(
        join(dir, "schema.graphql"),
        "type Query { things: [Thing] }\ntype Thing { a: String }\n",
      );
      writeFileSync(join(dir, "q.graphql"), "query { things { a b } }\n");
      const r = await query([".", "--graphql", "--schema", "schema.graphql"], {
        env: { SANITY_PROJECT_ID: "northfield" },
        transport: nothing,
        cwd: dir,
      });
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain("The schema has no Sanity document types");
      expect(r.out).not.toContain("Counted");
      expect(r.out).toContain("b isn't in the schema");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("a missing file is exit 2 before anything else is done", async () => {
    const r = await query([".", "--graphql", "--schema", "nope.graphql"], { transport: nothing });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("nope.graphql");
  });

  it("a file with no types in it is not a schema, and is named", async () => {
    const r = await query([".", "--graphql", "--schema", "gql/resources.graphql"], {
      transport: nothing,
    });
    expect(r.code).toBe(EXIT.couldNotRun);
    // The file is named by its resolved path, so the separators are the platform's.
    expect(r.err).toContain(`${join("gql", "resources.graphql")} has no types in it`);
  });
});

describe("gaugeline query --graphql: arguments", () => {
  it("takes an optional endpoint after the folder", () => {
    expect(parseCliArgs(["query", "./src", "--graphql"])).toMatchObject({
      kind: "query",
      graphql: {},
    });
    expect(
      parseCliArgs(["query", "./src", "--graphql", "https://example.com/graphql"]),
    ).toMatchObject({
      kind: "query",
      dir: "./src",
      graphql: { endpoint: "https://example.com/graphql" },
    });
  });

  it("refuses an endpoint that is not an address, two folders, and the flags it cannot share a run with", () => {
    expect(parseCliArgs(["query", "./src", "--graphql", "./other"])).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["query", "./src", "./other"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["query", "./src", "--graphql", "--mutations"])).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["query", "./src", "--graphql", "--dupes"])).toMatchObject({
      kind: "error",
    });
    expect(
      parseCliArgs([
        "query",
        "./src",
        "--graphql",
        "https://example.com/graphql",
        "--schema",
        "s.graphql",
      ]),
    ).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["query", "./src", "--schema", "s.graphql"])).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["query", "./src", "--graphql", "--schema", "s.graphql"])).toMatchObject({
      kind: "query",
      schema: "s.graphql",
    });
  });
});
