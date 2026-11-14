import { resultSchema } from "@gaugeline/core";
import {
  COPPERHILL_COUNTS,
  sanityCountsTransport,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { bin } from "./helpers/bin.js";

const repo = fileURLToPath(new URL("../../../fixtures/repo-mutations/", import.meta.url));
const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const preload = fileURLToPath(new URL("./helpers/record-connections.cjs", import.meta.url));
const NOW = new Date("2026-11-10T12:00:00Z");

const made: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of made.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A folder holding these files (paths with `/`). */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-mutcli-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, ...name.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

interface Seen {
  transport: SeenSanityRequest[];
  /** Every call the fetcher's transport got, whatever it was. */
  calls: number;
}

async function query(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; throwing?: boolean } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const seen: Seen = { transport: [], calls: 0 };
  const real = sanityCountsTransport(COPPERHILL_COUNTS, seen.transport);
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
      fetcher: {
        transport: (url, req) => {
          seen.calls += 1;
          if (options.throwing === true)
            throw new Error("the query command made a request it should not have made");
          return real(url, req);
        },
        timeoutMs: 5000,
      },
    },
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

describe("gaugeline query --mutations: e2e", () => {
  it("reads the writes in the repository and prints the five findings with file and line; exit 0", async () => {
    const r = await query([".", "--mutations"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    for (const text of [
      "Read 5 writes in 5 files (1 transaction, 3 patches and 1 create)",
      "They were parsed, not run: nothing was sent.",
      "\u2717 A write sets a field no document type declares",
      "app/api/classes/[id]/status/route.ts:6  This patch writes cancelledBy",
      "\u2717 A create leaves out a field the schema requires",
      "\u2717 A reference is written as a plain string",
      "! A write edits published content directly",
      "! Two routes write the same field",
      "classSession.status is written by 2 routes: app/api/classes/[id]/status/route.ts:6, app/api/cron/reopen/route.ts:7",
      "Could not read 1 write:",
      "app/api/webhooks/sanity/route.ts:12  variable-key",
    ])
      expect(r.out, text).toContain(text);
    expect(r.out).toContain("5 to look at, 3 to fix first.");
  });

  it("with --ci it exits 1, because three of the findings are Fix this first", async () => {
    const r = await query([".", "--mutations", "--ci"]);
    expect(r.code).toBe(EXIT.findings);
  });

  it("without --mutations the same folder makes no mutation finding and reads no schema", async () => {
    const r = await query(["."]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("No GROQ queries found");
    expect(r.out).not.toContain("write");
  });

  it("runs from another folder: the default schema is the one next to the code it reads", async () => {
    const r = await query(["repo-mutations", "--mutations"], { cwd: fixtures });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("repo-mutations/app/api/classes/route.ts:6");
    expect(r.out).toContain("5 to look at, 3 to fix first.");
  });

  it("--schema names the file; ./schema.json in the folder it ran from wins over the one beside the code", async () => {
    const other = tree({ "schema.json": "[]" });
    const withFlag = await query([".", "--mutations", "--schema", join(repo, "schema.json")], {
      cwd: other,
    });
    // cwd is `other`, "." is `other`: no writes there. The point is the flag's file was read without error.
    expect(withFlag.code).toBe(EXIT.ok);
    expect(withFlag.out).toContain("No writes found");
    // ./schema.json in the working folder is an empty schema: every field is undeclared.
    const wins = await query([repo, "--mutations"], { cwd: other });
    expect(wins.code).toBe(EXIT.ok);
    expect(wins.out).toContain("no document type in the schema declares it");
    expect(wins.out).not.toContain("leaves out");
  });

  it("no schema file: exit 2, a message that names --schema, and nothing printed on stdout", async () => {
    const dir = tree({ "a.ts": "export const x = 1;\n" });
    const r = await query([".", "--mutations"], { cwd: dir });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("--schema");
    expect(r.err).toContain("schema.json");
    expect(r.seen.calls).toBe(0);
  });

  it("--schema with a file that is not there: exit 2, names --schema", async () => {
    const r = await query([".", "--mutations", "--schema", "nope.json"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("--schema");
    expect(r.err).toContain("nope.json");
  });

  it("--schema with a file that is not a schema extract: exit 2", async () => {
    const dir = tree({ "schema.json": '{"hello": 1}', "a.ts": "export const x = 1;\n" });
    const r = await query([".", "--mutations"], { cwd: dir });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("--schema");
  });

  it("a folder with no writes says so, and exits 0", async () => {
    const dir = tree({ "schema.json": "[]", "a.ts": "export const x = 1;\n" });
    const r = await query([".", "--mutations", "--ci"], { cwd: dir });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("No writes found under .");
    expect(r.out).toContain("Nothing was sent.");
  });

  it("--json prints the schema 2 result with the findings and their sources, and needs no SANITY_PROJECT_ID", async () => {
    const r = await query([".", "--mutations", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.findings.map((f) => f.checkId).sort()).toEqual([
      "mutation-missing-required",
      "mutation-no-drafts",
      "mutation-ref-as-string",
      "mutation-shared-field",
      "mutation-undeclared-field",
    ]);
    expect(result.findings.every((f) => f.source !== undefined)).toBe(true);
    expect(result.passed).toEqual([]);
  });

  it("--json without --mutations and without SANITY_PROJECT_ID is still exit 2", async () => {
    const r = await query([".", "--json"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("--mutations");
  });

  it("with SANITY_PROJECT_ID set as well, the counts and the mutation findings are one report", async () => {
    const dir = tree({
      "schema.json": readFileSync(join(repo, "schema.json"), "utf8"),
      "app/api/classes/route.ts": readFileSync(join(repo, "app/api/classes/route.ts"), "utf8"),
      "app/page.tsx":
        'import groq from "groq";\nexport const q = groq`*[_type == "menuItem" && !(_id in path("drafts.**"))]{ name }`;\n',
    });
    const r = await query([".", "--mutations"], {
      cwd: dir,
      env: { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production" },
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Counted the published documents of 1 type");
    expect(r.out).toContain("A reference is written as a plain string");
    // One GET for the one type counted, and nothing for the writes.
    expect(r.seen.transport).toHaveLength(1);
  });
});

describe("gaugeline query --mutations: the arguments", () => {
  it("--mutations and --schema are query flags, in --help and in the flag list", () => {
    expect(parseCliArgs(["query", ".", "--mutations"])).toMatchObject({
      kind: "query",
      mutations: true,
    });
    expect(parseCliArgs(["query", ".", "--mutations", "--schema", "s.json"])).toMatchObject({
      kind: "query",
      mutations: true,
      schema: "s.json",
    });
    expect(parseCliArgs(["query", "."])).toMatchObject({ kind: "query", mutations: false });
    expect(FLAGS.find((f) => f.name === "mutations")?.commands).toEqual(["query"]);
    expect(FLAGS.find((f) => f.name === "schema")?.commands).toEqual(["query"]);
    expect(HELP.query).toContain("--mutations");
    expect(HELP.query).toContain("--schema");
    expect(HELP.query).toContain("Nothing is sent");
  });

  it("--schema without --mutations is an error that says what it is for", () => {
    const parsed = parseCliArgs(["query", ".", "--schema", "s.json"]);
    expect(parsed.kind).toBe("error");
    expect(JSON.stringify(parsed)).toContain("--mutations");
  });

  it("the commands that do not have them refuse them", () => {
    expect(parseCliArgs(["check", "https://example.com", "--mutations"]).kind).toBe("error");
    expect(parseCliArgs(["check", "https://example.com", "--schema", "s.json"]).kind).toBe("error");
  });
});

describe("gaugeline query --mutations: the promise, a mutation is never sent", () => {
  it("with a transport that fails the test on any call, --mutations on the whole fixture makes none", async () => {
    for (const argv of [
      [".", "--mutations"],
      [".", "--mutations", "--ci"],
      [".", "--mutations", "--json"],
    ]) {
      const r = await query(argv, { throwing: true });
      expect(r.err).toBe("");
      expect(r.seen.calls).toBe(0);
    }
  });

  it("with the global fetch and the node:http and node:net request functions replaced by ones that throw, it makes zero calls and still passes", async () => {
    const boom = () => {
      throw new Error("a request was made");
    };
    const http = await import("node:http");
    const https = await import("node:https");
    const net = await import("node:net");
    const spies = [
      vi.spyOn(http.default, "request").mockImplementation(boom),
      vi.spyOn(http.default, "get").mockImplementation(boom),
      vi.spyOn(https.default, "request").mockImplementation(boom),
      vi.spyOn(https.default, "get").mockImplementation(boom),
      vi.spyOn(net.default, "connect").mockImplementation(boom),
      vi.spyOn(net.default, "createConnection").mockImplementation(boom),
      vi.spyOn(globalThis, "fetch").mockImplementation(boom),
    ];
    const r = await query([".", "--mutations"], { throwing: true });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("nothing was sent");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(r.seen.calls).toBe(0);
  });

  it("with a dataset read as well, every request is a GET for counts and none carries a mutation", async () => {
    const dir = tree({
      "schema.json": readFileSync(join(repo, "schema.json"), "utf8"),
      "app/api/classes/route.ts": readFileSync(join(repo, "app/api/classes/route.ts"), "utf8"),
      "app/api/cron/route.ts": readFileSync(join(repo, "app/api/cron/reopen/route.ts"), "utf8"),
      "app/page.tsx":
        'import groq from "groq";\nexport const q = groq`*[_type == "menuItem"]{ name }`;\n',
    });
    const r = await query([".", "--mutations", "--ci"], {
      cwd: dir,
      env: { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production" },
    });
    expect(r.seen.transport.length).toBeGreaterThan(0);
    for (const s of r.seen.transport) {
      expect(s.method).toBe("GET");
      expect(s.url).not.toMatch(/\/data\/mutate/);
      expect(s.query).toMatch(/^\{"total":count\(/);
      expect(`${s.url} ${s.query}`).not.toMatch(/createOrReplace|setIfMissing|"patch"|mutations/);
    }
  });

  it("the built bin opens no connection at all when it checks mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-phone-"));
    const log = join(dir, "connections.log");
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_COLOR: "1",
        GAUGELINE_RECORD_CONNECTIONS: log,
      };
      for (const k of ["CI", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"])
        delete env[k];
      delete env.SANITY_PROJECT_ID;
      const code = await new Promise<number>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--require", preload, bin, "query", ".", "--mutations"],
          {
            cwd: repo,
            env,
            stdio: "ignore",
          },
        );
        child.on("close", (c) => resolve(c ?? -1));
      });
      expect(code).toBe(0);
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
