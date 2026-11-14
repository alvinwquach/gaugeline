import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";
import { bin, runBin } from "./helpers/bin.js";

const repo = fileURLToPath(new URL("../../../fixtures/repo-groq/", import.meta.url));
const preload = fileURLToPath(new URL("./helpers/record-connections.cjs", import.meta.url));

async function query(argv: string[], deps: { cwd?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["query", ...argv],
    { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: {} },
    {
      ...deps,
      // Any request through the fetcher fails the test.
      fetcher: {
        transport: () => {
          throw new Error("the query command made a request");
        },
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline query: unit", () => {
  it("takes one folder and nothing else", () => {
    expect(parseCliArgs(["query", "./src"])).toMatchObject({ kind: "query", dir: "./src" });
    for (const argv of [["query"], ["query", "a", "b"]])
      expect(parseCliArgs(argv)).toMatchObject({ kind: "error" });
  });

  it("has --help, takes --ci and --json, and none of the page check's other flags", () => {
    expect(parseCliArgs(["query", "--help"])).toMatchObject({ kind: "help" });
    expect(parseCliArgs(["query", "./src", "--ci", "--json"])).toMatchObject({
      kind: "query",
      ci: true,
      json: true,
    });
    // --allow-private is for a GraphQL endpoint on this computer (--graphql); the page check's other flags are not.
    expect(parseCliArgs(["query", "./src", "--dns"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["query", "./src", "--no-open"])).toMatchObject({ kind: "error" });
  });
});

describe("gaugeline query: e2e (CLI)", () => {
  it("prints 12 shapes for fixtures/repo-groq and names both unreadable files with their lines", async () => {
    const r = await query(["."], { cwd: repo });
    expect(r.code).toBe(EXIT.ok);
    // With no SANITY_PROJECT_ID nothing is compared, and one line on stderr says so.
    expect(r.err).toContain("SANITY_PROJECT_ID is not set");
    // One block of four lines for each shape: the header is the type, then the file and line.
    expect(r.out.split("\n").filter((l) => /^\S+ {2}src\/.+:\d+$/.test(l))).toHaveLength(12);
    expect(r.out).toContain("Could not read 2 queries:");
    expect(r.out).toContain("  src/app/search/page.tsx:5  concatenated:");
    expect(r.out).toContain("  src/lib/filters.ts:4  concatenated:");
    expect(r.out.trimEnd().split("\n").pop()).toBe(
      "12 shapes from 10 queries; 2 could not be read.",
    );
  });

  it("a shape shows its type, file and line, fields, drafts and parameters", async () => {
    const r = await query(["."], { cwd: repo });
    expect(r.out).toContain(
      [
        "popup  src/app/events/page.tsx:3",
        "  fields: title, date, venue->name, venue->address.city",
        "  drafts: not left out by the filter",
        "  params: $after, $venue",
      ].join("\n"),
    );
    expect(r.out).toContain(
      [
        "order  src/app/api/orders/route.ts:4",
        "  fields: _id, total, lines[].item->name",
        "  drafts: left out by the filter",
        "  params: $email",
      ].join("\n"),
    );
  });

  it("reads a folder given relative to where it is run", async () => {
    const r = await query(["./src/app/"], { cwd: repo });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("popup  ./src/app/events/page.tsx:3");
    expect(r.out).toContain("  ./src/app/search/page.tsx:5  concatenated:");
    expect(r.out).not.toContain("sanity");
    expect(r.out.trimEnd().split("\n").pop()).toBe("4 shapes from 4 queries; 1 could not be read.");
  });

  it("exits 2 with a plain message when the folder does not exist", async () => {
    const r = await query([join(repo, "nowhere")]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("does not exist");
    expect(r.err).toContain("gaugeline query ./src");
  });

  it("an empty folder is exit 0 and says what it looks for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-query-"));
    try {
      const r = await query([dir]);
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain("No GROQ queries found under");
      expect(r.out).toContain("defineQuery(...)");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("the built bin does the same (needs pnpm build)", async () => {
    expect(existsSync(bin), "run `pnpm build` before the tests").toBe(true);
    const r = await runBin(["query", "."], {}, { cwd: repo });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("12 shapes from 10 queries; 2 could not be read.");
    expect(r.stderr).toContain("SANITY_PROJECT_ID is not set");
    const missing = await runBin(["query", join(repo, "nowhere")]);
    expect(missing.status).toBe(2);
  });
});

describe("gaugeline query: promise", () => {
  it("with the network stubbed to throw on any request it still reads and exits 0", async () => {
    const boom = () => {
      throw new Error("a request was made");
    };
    const http = await import("node:http");
    const https = await import("node:https");
    const net = await import("node:net");
    const spies = [
      vi.spyOn(http.default, "request").mockImplementation(boom),
      vi.spyOn(https.default, "request").mockImplementation(boom),
      vi.spyOn(net.default, "connect").mockImplementation(boom),
      vi.spyOn(globalThis, "fetch").mockImplementation(boom),
    ];
    try {
      const r = await query(["."], { cwd: repo });
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain("12 shapes");
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("the built bin opens no connection at all", async () => {
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
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, ["--require", preload, bin, "query", "."], {
          cwd: repo,
          env,
          stdio: "ignore",
        });
        child.on("close", (c) => resolve(c ?? -1));
      });
      expect(code).toBe(0);
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
