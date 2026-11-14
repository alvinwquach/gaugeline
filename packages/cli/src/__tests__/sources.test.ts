import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR } from "@gaugeline/fixtures";
import { staticSite, useCassette } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const HOST = "bucktavern.example";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function workdir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-sources-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gaugeline.sources.json"), JSON.stringify(config));
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" } as Record<string, string | undefined>,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const CONFIG = {
  sources: {
    db: {
      type: "supabase",
      queries: { eightySixed: "select name from menu_items where is_86 = true" },
    },
  },
};

describe("gaugeline.sources.json in the CLI", () => {
  it("a bad file stops the run naming the file and the field (exit 2)", async () => {
    const dir = workdir({
      sources: { db: { type: "postgres", url: "postgres://x", queries: { q: "select 1" } } },
    });
    const run = capture();
    expect(await main([`https://${HOST}/`, "--no-open"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("gaugeline.sources.json: sources.db:");
    // The message is about the file; it repeats nothing from it.
    expect(run.err()).not.toContain("postgres://x");
  });

  it("a good file adds no request and no connection while no check reads a database, and the connection string reaches no output", async () => {
    const connections: number[] = [];
    const server = createServer((socket) => {
      connections.push(1);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    const password = ["bar", "pw", "0123456789"].join("-");
    try {
      const run = capture();
      run.io.env.GAUGELINE_SUPABASE_DB_URL = `postgres://gaugeline_reader:${password}@127.0.0.1:${port}/bar?sslmode=disable`;
      const code = await main([`https://${HOST}/`, "--no-open", "--json", "--verbose"], run.io, {
        version: "0.1.0",
        cwd: workdir(CONFIG),
        fetcher: {
          transport: staticSite(
            HOST,
            `${SITES_DIR}clean`,
            useCassette("sanity-products", { mode: "replay" }),
          ),
        },
      });
      expect(code, run.err()).toBe(0);
      expect(connections).toEqual([]);
      for (const text of [run.out(), run.err()]) expect(text).not.toContain(password);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
