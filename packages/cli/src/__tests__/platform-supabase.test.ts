import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resultSchema } from "@gaugeline/core";
import {
  MCP_READ_HINTS,
  SUPABASE_RECORDED_TOOLS,
  fakeSupabase,
  type FakeSupabaseOptions,
} from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";

/**
 * `gaugeline platform` with gaugeline.platforms.json: Supabase read through its hosted MCP server in
 * read-only mode (MCP-03, ADR-0008), against testkit's fake server (no socket, no vendor, no key).
 * The project, the bar and the token are invented.
 */
const REF = "abcdefghijklmnopqrst";
// Built at run time so no key-shaped string sits in the repository (push protection).
const TOKEN = ["sbp", "_", "fake", "0123456789abcdef", "0123456789abcdef"].join("");
const NOW = new Date("2026-11-12T10:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function folder(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-platforms-"));
  dirs.push(dir);
  if (config !== undefined)
    writeFileSync(join(dir, "gaugeline.platforms.json"), JSON.stringify(config, null, 2));
  return dir;
}

async function platform(
  argv: string[],
  cwd: string,
  opts: { env?: Record<string, string>; fake?: FakeSupabaseOptions } = {},
) {
  const fake = fakeSupabase(opts.fake);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["platform", ...argv],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: opts.env ?? { SUPABASE_ACCESS_TOKEN: TOKEN },
    },
    { cwd, now: () => NOW, fetcher: { transport: fake.transport, timeoutMs: 1000 } },
  );
  return { code, out: out.join(""), err: err.join(""), sent: fake.sent };
}

const CONFIG = { supabase: { projectRef: REF } };

describe("gaugeline platform reads gaugeline.platforms.json (no new flag)", () => {
  it("parses with no flag, and still takes no address", () => {
    expect(parseCliArgs(["platform"])).toMatchObject({ kind: "platform", webhooks: false });
    expect(parseCliArgs(["platform", "example.com"])).toMatchObject({ kind: "error" });
  });

  it("without the settings file it asks for --webhooks or the file, and sends nothing", async () => {
    const r = await platform([], folder());
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("gaugeline.platforms.json");
    expect(r.sent).toEqual([]);
  });

  it("with the file and no token it names the variable, and sends nothing", async () => {
    const r = await platform([], folder(CONFIG), { env: {} });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("SUPABASE_ACCESS_TOKEN");
    expect(r.sent).toEqual([]);
  });

  it("refuses a project ref that is not an id, and a key in the file", async () => {
    for (const config of [
      { supabase: { projectRef: "abc&read_only=false" } },
      { supabase: { projectRef: REF, token: TOKEN } },
    ]) {
      const r = await platform([], folder(config));
      expect(r.code).toBe(EXIT.couldNotRun);
      expect(r.sent).toEqual([]);
      expect(r.err + r.out).not.toContain(TOKEN);
    }
  });

  it("reads the project and prints the findings; the token is printed nowhere", async () => {
    const r = await platform([], folder(CONFIG));
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(`Supabase project ${REF}, read-only through Supabase's MCP server`);
    expect(r.out).toContain("public.bookings: row-level security is off (about 214 rows).");
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(r.sent.every((s) => s.url.includes("read_only=true"))).toBe(true);
  });

  it("--json prints a schema 2 result and nothing else", async () => {
    const r = await platform(["--json"], folder(CONFIG));
    const parsed = resultSchema.safeParse(JSON.parse(r.out));
    expect(parsed.success).toBe(true);
    expect(r.out).not.toContain(TOKEN);
  });

  it("--ci exits 1 on a high finding", async () => {
    const r = await platform(["--ci"], folder(CONFIG));
    expect(r.code).toBe(EXIT.findings);
  });

  it("a server that is not read-only: could not check, in Gaugeline's words, nothing called", async () => {
    const liar = [
      ...SUPABASE_RECORDED_TOOLS,
      { name: "apply_migration", annotations: MCP_READ_HINTS, inputSchema: {} },
    ];
    const r = await platform([], folder(CONFIG), { fake: { tools: liar } });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Supabase could not be read: the server lists a tool that can write");
    expect(r.sent).toHaveLength(3);
  });
});

/**
 * docs/sources/supabase-mcp.md shows the settings file, the command and what it prints. The docs
 * runner cannot reach Supabase (and must not), so this runs the page's command against the fake
 * server and compares the Output block with what the CLI prints.
 */
describe("docs/sources/supabase-mcp.md", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../docs/sources/supabase-mcp.md", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const block = (title: RegExp): string => {
    const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
    for (let m = re.exec(page); m; m = re.exec(page)) if (title.test(m[1] ?? "")) return m[2] ?? "";
    throw new Error(`no block ${String(title)}`);
  };

  it("prints what the page says, with the page's own settings file", async () => {
    const config = JSON.parse(block(/title=gaugeline\.platforms\.json/)) as unknown;
    expect(block(/title=Terminal/)).toBe("$ npx gaugeline platform");
    const r = await platform([], folder(config));
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    expect(r.out.trimEnd()).toBe(block(/title="?Output/));
  });

  it("names the variable, the checks and what is not verified", () => {
    for (const word of [
      "SUPABASE_ACCESS_TOKEN",
      "supabase-rls-off",
      "supabase-security-advisor",
      "read_only=true",
      "uncited",
      "allowed to use",
    ])
      expect(page, word).toContain(word);
  });
});
