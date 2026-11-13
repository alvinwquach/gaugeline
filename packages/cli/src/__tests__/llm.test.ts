/**
 * gaugeline llm (AG-20): the setup check on the command line. It reads one settings file and the one variable
 * that file names, prints whether the variable holds a usable key, and never the key. No request is made.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const options = readFileSync(join(root, "docs/options.md"), "utf8");
const page = readFileSync(join(root, "docs/model-gateway.md"), "utf8").replace(/\r\n/g, "\n");
const block = (title: string) =>
  new RegExp("```[a-z]* title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

/** Invented values, built from pieces: no key-looking literal in the repository. */
const KEY_VALUE = ["demo", "value", "A1b2C3d4E5f6G7h8I9j0"].join("-");
const SHAPED = ["sk", "live", "q".repeat(24)].join("_");
const SETTINGS = {
  provider: "example",
  keyEnv: "EXAMPLE_API_KEY",
  tiers: { fast: "small-model", strong: "large-model" },
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-llm-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const write = (name: string, v: unknown) =>
  writeFileSync(join(dir, name), typeof v === "string" ? v : JSON.stringify(v));

async function run(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetches: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    {
      cwd: dir,
      // Offline: any request at all fails the test.
      fetcher: new Proxy({} as never, {
        get: (_t, p) => () => {
          fetches.push(String(p));
          throw new Error("no request may be made");
        },
      }),
    },
  );
  expect(fetches).toEqual([]);
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline llm", () => {
  it("says the key is set, by name, and never shows it (exit 0)", async () => {
    write("gaugeline.llm.json", SETTINGS);
    const r = await run(["llm"], { EXAMPLE_API_KEY: KEY_VALUE });
    expect(r.code).toBe(0);
    expect(r.out).toContain("key: EXAMPLE_API_KEY is set (its value is never shown)");
    expect(r.out).toContain("fast: small-model");
    expect(r.out).toContain("The call runs in: this command line");
    expect(r.out + r.err).not.toContain(KEY_VALUE);
  });

  it("says the key is not set, and still exits 0: that is an answer", async () => {
    write("gaugeline.llm.json", SETTINGS);
    const r = await run(["llm"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("EXAMPLE_API_KEY is not set");
  });

  it("reads only the variable the file names: another key in the environment is not looked at", async () => {
    write("gaugeline.llm.json", SETTINGS);
    const r = await run(["llm"], { OTHER_API_KEY: KEY_VALUE });
    expect(r.out).toContain("EXAMPLE_API_KEY is not set");
    expect(r.out + r.err).not.toContain(KEY_VALUE);
  });

  it("--llm-config names another file; --json prints the status without the key", async () => {
    write("mine.json", SETTINGS);
    const r = await run(["llm", "--llm-config", "mine.json", "--json"], {
      EXAMPLE_API_KEY: KEY_VALUE,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      mode: "cli",
      provider: "example",
      tiers: SETTINGS.tiers,
      keyEnv: "EXAMPLE_API_KEY",
      keySet: true,
    });
    expect(r.out).not.toContain(KEY_VALUE);
  });

  it.each([
    ["no file", undefined],
    ["a file that is not JSON", "{"],
    ["a key as a setting", { ...SETTINGS, apiKey: KEY_VALUE }],
    ["a key where the variable name goes", { ...SETTINGS, keyEnv: SHAPED }],
    ["a host", { ...SETTINGS, baseUrl: "https://api.example.test" }],
  ])("exits 2 for %s, and never repeats a key", async (_n, content) => {
    if (content !== undefined) write("gaugeline.llm.json", content);
    const r = await run(["llm"], { EXAMPLE_API_KEY: KEY_VALUE });
    expect(r.code).toBe(2);
    for (const k of [KEY_VALUE, SHAPED]) expect(r.out + r.err).not.toContain(k);
  });

  it("takes no word on the line: the file is named with --llm-config", () => {
    expect(parseCliArgs(["llm", "settings.json"]).kind).toBe("error");
  });

  it("has a flag in the table and in --help, and docs/options.md prints the same help", async () => {
    expect(FLAGS.find((f) => f.name === "llm-config")?.commands).toEqual(["llm"]);
    const r = await run(["llm", "--help"]);
    expect(r.out.trimEnd()).toBe(HELP.llm!.trimEnd());
    expect(r.out).toContain("--llm-config <value>");
    expect(options).toContain(HELP.llm!.trimEnd());
  });
});

describe("the docs page", () => {
  it("shows the status this command prints, word for word", async () => {
    write("gaugeline.llm.json", SETTINGS);
    const r = await run(["llm"], { EXAMPLE_API_KEY: KEY_VALUE });
    expect(block("Setup")).toBe(r.out.trimEnd());
  });
});
