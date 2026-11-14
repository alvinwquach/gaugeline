/**
 * gaugeline house-rules (AG-17): the compiler on the command line. It reads one rules file and writes one new
 * draft file; nothing live is ever changed, nothing is overwritten, and no request is made. The docs page
 * shows the real output of the two invented fixtures.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { parseHouseConfig } from "@gaugeline/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { parseCliArgs } from "../args.js";

const FIX = fileURLToPath(new URL("../../../fixtures/house-rules/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const options = readFileSync(join(root, "docs/options.md"), "utf8");
const page = readFileSync(join(root, "docs/house-rules.md"), "utf8").replace(/\r\n/g, "\n");
const blocks = (title: string): string[] =>
  [...page.matchAll(new RegExp("```[a-z]* title=" + title + "\\n([\\s\\S]*?)\\n```", "g"))].map(
    (m) => m[1] ?? "",
  );

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-house-")));
  cpSync(FIX, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const fetches: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
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
const files = () => readdirSync(dir).sort();

describe("gaugeline house-rules: the passing fixture (exit 0)", () => {
  it("writes the draft beside the rules file and prints the review", async () => {
    const r = await run(["house-rules", "--rules", "style-guide.md"]);
    expect(r.code).toBe(0);
    expect(files()).toEqual([
      "README.md",
      "gaugeline.rules.draft.json",
      "hostile.md",
      "style-guide.md",
    ]);
    const draft = JSON.parse(readFileSync(join(dir, "gaugeline.rules.draft.json"), "utf8"));
    expect(parseHouseConfig(draft, "draft")).toEqual({
      version: 1,
      headings: { case: "sentence" },
      forbidChars: ["em-dash"],
      forbidTerms: ["cheap", "bargain"],
      buttonLabel: "Book now",
      phoneFormat: "### ### ####",
    });
    expect(r.out).toContain("5 of 7 lines became rules");
    expect(r.out).toContain("Nothing live was changed.");
  });

  it("--out names the draft; --json prints the whole draft and where it went", async () => {
    const r = await run([
      "house-rules",
      "--rules",
      "style-guide.md",
      "--out",
      "mine.draft.json",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.written).toBe("mine.draft.json");
    expect(j.totals).toEqual({ lines: 7, understood: 5, notUnderstood: 2, refused: 0 });
    expect(existsSync(join(dir, "mine.draft.json"))).toBe(true);
    expect(existsSync(join(dir, "gaugeline.rules.draft.json"))).toBe(false);
  });

  it("the docs page's example is this command's real output, and its draft is the file it writes", async () => {
    expect(page).toContain("$ npx gaugeline house-rules --rules gaugeline-house-style.md\n");
    cpSync(join(dir, "style-guide.md"), join(dir, "gaugeline-house-style.md"));
    const r = await run(["house-rules", "--rules", "gaugeline-house-style.md"]);
    expect(r.out.trimEnd()).toBe(blocks("Output")[0]);
    expect(readFileSync(join(dir, "gaugeline.rules.draft.json"), "utf8").trimEnd()).toBe(
      blocks("gaugeline.rules.draft.json")[0],
    );
    expect(blocks("gaugeline-house-style.md")[0]).toBe(
      readFileSync(join(dir, "style-guide.md"), "utf8").trimEnd(),
    );
  });
});

describe("gaugeline house-rules: the failing fixture (hostile lines), still exit 0 and nothing leaks", () => {
  it("compiles the one safe rule, refuses two lines, lists and ignores the order", async () => {
    expect(page).toContain(
      "$ npx gaugeline house-rules --rules hostile.md --out hostile.draft.json\n",
    );
    const r = await run(["house-rules", "--rules", "hostile.md", "--out", "hostile.draft.json"]);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd()).toBe(blocks("Output")[1]);
    expect(r.out).toContain("[looks like a pattern, not a plain word]");
    expect(r.out).toContain("[names a file path]");
    expect(r.out).toContain("[addressed to an assistant: ignored]");
    const draft = readFileSync(join(dir, "hostile.draft.json"), "utf8");
    expect(JSON.parse(draft)).toEqual({ version: 1, headings: { case: "sentence" } });
    expect(blocks("hostile.md")[0]).toBe(readFileSync(join(dir, "hostile.md"), "utf8").trimEnd());
    expect(draft).not.toMatch(/etc|passwd|a\+/);
  });

  it("nothing understood: nothing is written, exit 0", async () => {
    writeFileSync(join(dir, "prose.md"), "# Voice\n\nWe like to sound warm.\n");
    const r = await run(["house-rules", "--rules", "prose.md"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing was understood, so no draft was written.");
    expect(files()).not.toContain("gaugeline.rules.draft.json");
  });
});

describe("gaugeline house-rules never changes what is live and never overwrites", () => {
  it("leaves an existing gaugeline.rules.json exactly as it is", async () => {
    writeFileSync(join(dir, "gaugeline.rules.json"), '{ "version": 1 }\n');
    expect((await run(["house-rules", "--rules", "style-guide.md"])).code).toBe(0);
    expect(readFileSync(join(dir, "gaugeline.rules.json"), "utf8")).toBe('{ "version": 1 }\n');
  });

  it("refuses --out gaugeline.rules.json, and any name that does not end in .draft.json", async () => {
    for (const out of [
      "gaugeline.rules.json",
      "gaugeline.config.json",
      "x.json",
      "draft.json.bak",
    ]) {
      const r = await run(["house-rules", "--rules", "style-guide.md", "--out", out]);
      expect(r.code, out).toBe(2);
      expect(r.err).toContain("must end in .draft.json");
      expect(existsSync(join(dir, out)), out).toBe(false);
    }
  });

  it("refuses a draft that already exists and leaves it untouched", async () => {
    writeFileSync(join(dir, "gaugeline.rules.draft.json"), "mine\n");
    const r = await run(["house-rules", "--rules", "style-guide.md"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("already exists");
    expect(readFileSync(join(dir, "gaugeline.rules.draft.json"), "utf8")).toBe("mine\n");
  });

  it("running it twice: the second run is refused, never a silent overwrite", async () => {
    expect((await run(["house-rules", "--rules", "style-guide.md"])).code).toBe(0);
    expect((await run(["house-rules", "--rules", "style-guide.md"])).code).toBe(2);
  });

  it("a folder that does not exist is a plain error, not a crash", async () => {
    const r = await run(["house-rules", "--rules", "style-guide.md", "--out", "nope/x.draft.json"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Could not write nope/x.draft.json");
  });
});

describe("gaugeline house-rules: input that cannot be read is exit 2 with a plain message", () => {
  it("needs --rules, and takes no file as a word", async () => {
    const none = await run(["house-rules"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("needs the rules file");
    const word = await run(["house-rules", "style-guide.md"]);
    expect(word.code).toBe(2);
    expect(word.err).toContain("takes the file with --rules");
  });

  it("a file that is not there, a folder, a file that is not text, a file that is too big", async () => {
    mkdirSync(join(dir, "folder"));
    writeFileSync(join(dir, "binary.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    writeFileSync(join(dir, "nul.md"), "No em dashes\u0000\n");
    writeFileSync(join(dir, "big.md"), "a\n".repeat(1100));
    writeFileSync(join(dir, "huge.md"), "x".repeat(200_001));
    const cases: [string, string][] = [
      ["missing.md", "Could not read missing.md"],
      ["folder", "is not a file"],
      ["binary.md", "is not UTF-8 text"],
      ["nul.md", "holds a null byte"],
      ["big.md", "more than 1000 lines"],
      ["huge.md", "larger than 50000 characters"],
    ];
    for (const [file, message] of cases) {
      const r = await run(["house-rules", "--rules", file]);
      expect(r.code, file).toBe(2);
      expect(r.err, file).toContain(message);
    }
    expect(files()).not.toContain("gaugeline.rules.draft.json");
  });

  it("refuses a rules file over 50,000 characters even when it is under 200,000 bytes", async () => {
    writeFileSync(join(dir, "wide.md"), `${"a".repeat(50_001)}\n`);
    const r = await run(["house-rules", "--rules", "wide.md"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("longer than 50000 characters");
  });
});

describe("gaugeline house-rules --help and docs/options.md", () => {
  it("prints the help the options page shows, and every flag of the command is in both", () => {
    expect(HELP["house-rules"]).toBe(expectedOutput("options", "The house-rules command"));
    for (const f of flagsFor(FLAGS, "house-rules")) {
      expect(HELP["house-rules"], `--${f.name} in --help`).toContain(`--${f.name}`);
      expect(options, `--${f.name} in docs/options.md`).toContain(`\`--${f.name}`);
    }
    expect(flagsFor(FLAGS, "house-rules").map((f) => f.name)).toEqual(
      expect.arrayContaining(["rules", "out", "json"]),
    );
  });

  it("is a command of its own: --help parses, and a flag it does not have is refused", () => {
    expect(parseCliArgs(["house-rules", "--help"]).kind).toBe("help");
    const bad = parseCliArgs(["house-rules", "--rules", "a.md", "--owner-consent"]);
    expect(bad.kind).toBe("error");
  });
});
