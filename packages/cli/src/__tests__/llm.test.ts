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
  tiers: { fast: "example-small", strong: "example-large" },
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
    expect(r.out).toContain("fast: example-small");
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

  it.each([
    ["a model id", (k: string) => ({ ...SETTINGS, tiers: { fast: k } })],
    ["the provider", (k: string) => ({ ...SETTINGS, provider: k })],
    [
      "a model id inside a longer one",
      (k: string) => ({ ...SETTINGS, tiers: { fast: `x-${k}-y` } }),
    ],
  ])("refuses the key itself in %s, and prints it nowhere, in any output mode", async (_n, put) => {
    const key = ["demo", "k9x2m7"].join("-");
    write("gaugeline.llm.json", put(key));
    for (const extra of [[], ["--json"], ["--verbose"], ["--json", "--verbose"]]) {
      const r = await run(["llm", ...extra], { EXAMPLE_API_KEY: key });
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.out + r.err).not.toContain(key);
    }
  });

  it("refuses a key in a shape nothing knows, with no variable set, and prints it nowhere", async () => {
    const key = ["demo", "value", "a1b2c3d4e5f6g7h8i9j0"].join("-");
    write("gaugeline.llm.json", { ...SETTINGS, tiers: { fast: key } });
    for (const extra of [[], ["--json"], ["--verbose"]]) {
      const r = await run(["llm", ...extra]);
      expect(r.code).toBe(2);
      expect(r.out + r.err).not.toContain(key);
    }
  });

  it.each([
    ["no shape the scanner knows", ["demo", "value", "a1b2c3d4e5f6g7h8i9j0"].join("-")],
    ["a short value", ["demo", "k9x2m7"].join("-")],
    ["a payment-key shape", SHAPED],
  ])("never prints a key used as a setting's name (%s), in any output mode", async (_n, key) => {
    write("gaugeline.llm.json", { ...SETTINGS, [key]: 1 });
    for (const extra of [[], ["--json"], ["--verbose"], ["--json", "--verbose"]]) {
      const r = await run(["llm", ...extra], { EXAMPLE_API_KEY: key });
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.out + r.err).not.toContain(key);
      expect(r.err).toMatch(
        /setting 1 is not one this file knows|holds something that looks like a key/,
      );
    }
  });

  it.each([{ mode: "managed" }, { vault: { path: "x" } }, { metered: true }])(
    "says mode 3 is parked when the file asks for it (%j), and exits 2",
    async (extra) => {
      write("gaugeline.llm.json", { ...SETTINGS, ...extra });
      const r = await run(["llm"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Mode 3 (a key Gaugeline holds for you, with metering) is parked");
    },
  );

  it.each([
    ["a UUID", "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c"],
    ["hex with dashes", "0123abcd-4567-89ef-0123-456789abcdef-01234567"],
    ["base32", "mfrggzdfmztwq2lknnwg23tpobyxe43u"],
    ["underscores", "k9x2m7_q4w8e1_r5t6y3_u0i2o7"],
  ])(
    "never prints %s pasted anywhere in the file, with the variable not set, in any output mode",
    async (_n, key) => {
      const fields = [
        { ...SETTINGS, tiers: { fast: key } },
        { ...SETTINGS, provider: key },
        { ...SETTINGS, keyEnv: key },
        { ...SETTINGS, [key]: 1 },
        { ...SETTINGS, tiers: { fast: "example-small", [key]: "x" } },
      ];
      for (const content of fields) {
        write("gaugeline.llm.json", content);
        for (const extra of [[], ["--json"], ["--verbose"], ["--json", "--verbose"]]) {
          const r = await run(["llm", ...extra]);
          expect(r.code, `${JSON.stringify(Object.keys(content))} ${extra.join(" ")}`).toBe(2);
          expect(r.out + r.err).not.toContain(key);
        }
      }
    },
  );

  it("prints a provider or a model that is not on the known list as a fixed text, with no character of it, in every mode", async () => {
    write("gaugeline.llm.json", {
      provider: "acme-ai",
      keyEnv: "OPENAI_API_KEY",
      tiers: { fast: "acme-large-2026" },
    });
    for (const extra of [[], ["--json"], ["--verbose"]]) {
      const r = await run(["llm", ...extra], { OPENAI_API_KEY: KEY_VALUE });
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain("acme-ai");
      expect(r.out + r.err).not.toContain("acme-large-2026");
      expect(r.out).toContain("[not on the known list]");
      expect(r.out + r.err).not.toContain("acm");
      expect(r.out + r.err).not.toContain(KEY_VALUE);
    }
  });

  it.each(["MYPROVIDER_API_KEY", "GH_API_KEY", "TWILIO_API_KEY", "GITHUB_TOKEN", "PATH"])(
    "refuses %s as the key variable without looking at it (only a known variable is read)",
    async (name) => {
      write("gaugeline.llm.json", { ...SETTINGS, keyEnv: name });
      const r = await run(["llm", "--json"], { [name]: KEY_VALUE });
      expect(r.code).toBe(2);
      expect(r.out + r.err).not.toContain(KEY_VALUE);
    },
  );

  it("says mode 3 is parked for tiers.mode", async () => {
    write("gaugeline.llm.json", { ...SETTINGS, tiers: { fast: "example-small", mode: "managed" } });
    const r = await run(["llm"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Mode 3 (a key Gaugeline holds for you, with metering) is parked");
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
