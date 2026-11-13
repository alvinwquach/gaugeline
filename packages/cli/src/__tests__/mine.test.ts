/**
 * gaugeline mine (AG-15): reads a folder of review notes, writes a DRAFT of check candidates, and fails (exit 1,
 * no file) when the notes' text holds a client name, an address, an email or a phone number. No request is made.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXAMPLE_DENY_LIST,
  EXAMPLE_NOTES,
  mineFieldFindings,
  MAX_NOTE_FILE_CHARS,
} from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

// The repository keeps no address (community:check): the invented ones are put together at run time.
const AT = "@";

const FIX = fileURLToPath(new URL("../../../fixtures/field-notes/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const options = readFileSync(join(root, "docs/options.md"), "utf8");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-mine-")));
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
const DRAFT = "field-findings.draft.md";
const mine = (notes: string, ...more: string[]) => run(["mine", "--review-notes", notes, ...more]);

describe("the fixture folder is the example the core code and the docs use", () => {
  it("golden/ and deny-list.txt hold exactly the example notes", () => {
    for (const n of EXAMPLE_NOTES)
      expect(readFileSync(join(FIX, "golden", n.name), "utf8"), n.name).toBe(n.text);
    expect(readdirSync(join(FIX, "golden")).sort()).toEqual(
      EXAMPLE_NOTES.map((n) => n.name).sort(),
    );
    expect(readFileSync(join(FIX, "deny-list.txt"), "utf8")).toBe(EXAMPLE_DENY_LIST);
  });
});

describe("gaugeline mine: a draft (exit 0)", () => {
  it("writes the draft the core miner writes, and says what it did", async () => {
    const r = await mine("golden", "--deny-list", "deny-list.txt");
    expect(r.code).toBe(0);
    const expected = mineFieldFindings(EXAMPLE_NOTES, { denyList: EXAMPLE_DENY_LIST });
    if (!expected.ok) throw new Error("expected a draft");
    expect(readFileSync(join(dir, DRAFT), "utf8")).toBe(expected.markdown);
    expect(r.out).toContain("Wrote 3 candidates to field-findings.draft.md");
    expect(r.out).toContain("draft for a person to review");
    expect(r.out).toContain("3 review notes");
    expect(r.err).toBe("");
  });

  it("--out names the file, and makes its folder; the notes are left as they were", async () => {
    const before = readFileSync(join(dir, "golden", "review-clinic.md"), "utf8");
    const r = await mine("golden", "--out", "drafts/week-46.md");
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "drafts", "week-46.md"))).toBe(true);
    expect(existsSync(join(dir, DRAFT))).toBe(false);
    expect(readFileSync(join(dir, "golden", "review-clinic.md"), "utf8")).toBe(before);
    expect(readdirSync(join(dir, "golden")).sort()).toEqual(
      EXAMPLE_NOTES.map((n) => n.name).sort(),
    );
  });

  it("running it again gives the same file", async () => {
    await mine("golden");
    const first = readFileSync(join(dir, DRAFT), "utf8");
    expect((await mine("golden")).code).toBe(0);
    expect(readFileSync(join(dir, DRAFT), "utf8")).toBe(first);
  });

  it("reads folders inside the folder, takes .md, .markdown and .txt, and leaves other files and links alone", async () => {
    mkdirSync(join(dir, "mixed", "week-2"), { recursive: true });
    for (const n of EXAMPLE_NOTES) writeFileSync(join(dir, "mixed", n.name), n.text);
    writeFileSync(join(dir, "mixed", "week-2", "extra.markdown"), "- #menu-link-404 Again.\n");
    writeFileSync(join(dir, "mixed", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    writeFileSync(join(dir, "mixed", ".hidden.md"), `- #leak-tag mail a${AT}b.example\n`);
    try {
      symlinkSync(join(dir, "leaky-url", "review-url-a.md"), join(dir, "mixed", "link.md"));
    } catch {
      // A platform that cannot make a link has nothing to skip.
    }
    const r = await mine("mixed");
    expect(r.code).toBe(0);
    expect(r.out).toContain("4 review notes");
  });

  it("an untagged line that names a client is never read, so it is never a leak", async () => {
    const r = await mine("golden", "--deny-list", "deny-list.txt");
    expect(readFileSync(join(FIX, "golden", "review-pop-up-bar.md"), "utf8")).toContain(
      "Juniper Pop-up Kitchen",
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, DRAFT), "utf8")).not.toContain("Juniper");
  });

  it("a note that gives an order to an assistant is counted and ignored, never obeyed", async () => {
    const r = await mine("hostile");
    expect(r.code).toBe(0);
    const draft = readFileSync(join(dir, DRAFT), "utf8");
    expect(draft).toContain("1 tagged line that gave an order to an assistant, ignored.");
    expect(draft).not.toMatch(/publish_check|previous instructions/i);
    expect(r.out).not.toMatch(/publish_check/);
  });

  it("a quiet folder writes an honest, empty draft", async () => {
    expect((await mine("quiet")).code).toBe(0);
    expect(readFileSync(join(dir, DRAFT), "utf8")).toContain("nothing to propose");
  });
});

describe("gaugeline mine: the scrub fails the draft (exit 1, no file)", () => {
  it("a client name from the deny-list: the kind and the line, never the name", async () => {
    const r = await mine("leaky-name", "--deny-list", "deny-list.txt");
    expect(r.code).toBe(1);
    expect(r.out).toContain("The draft failed the scrub");
    expect(r.out).toContain("review-leak-a.md line 1: a client name");
    expect(r.out).toContain("review-leak-b.md line 1: a client name");
    expect(r.out + r.err).not.toMatch(/tidewater/i);
    expect(existsSync(join(dir, DRAFT))).toBe(false);
  });

  it("a web address, an email address and a phone number", async () => {
    const url = await mine("leaky-url");
    expect(url.code).toBe(1);
    expect(url.out).toContain("review-url-a.md line 1: a web address");
    expect(url.out + url.err).not.toMatch(/example|drinks/);
    const c = await mine("leaky-contact");
    expect(c.code).toBe(1);
    expect(c.out).toContain("review-contact-a.md line 1: an email address");
    expect(c.out).toContain("review-contact-c.md line 1: a phone number");
    expect(c.out + c.err).not.toMatch(/chef|7946|kitchen/);
    expect(existsSync(join(dir, DRAFT))).toBe(false);
  });

  it("an earlier draft is not touched or removed by a failing run", async () => {
    writeFileSync(join(dir, DRAFT), "an earlier draft\n");
    expect((await mine("leaky-url")).code).toBe(1);
    expect(readFileSync(join(dir, DRAFT), "utf8")).toBe("an earlier draft\n");
  });

  it.skipIf(process.platform === "win32")(
    "a hostile file name is shown as text, not as a terminal escape",
    async () => {
      mkdirSync(join(dir, "esc"));
      writeFileSync(join(dir, "esc", "a\u001b[31mred.md"), `- #leak-tag mail a${AT}b.example\n`);
      const r = await mine("esc");
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("\u001b");
    },
  );
});

describe("gaugeline mine: could not read (exit 2)", () => {
  it("a folder that is not there, or is a file", async () => {
    const a = await mine("nowhere");
    expect(a.code).toBe(2);
    expect(a.err).toContain("nowhere");
    const b = await mine("deny-list.txt");
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/folder/);
  });

  it("a folder with no notes in it", async () => {
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "empty", "photo.png"), "x");
    const r = await mine("empty");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/\.md/);
  });

  it("an oversized note is refused whole, with its name and none of its text", async () => {
    mkdirSync(join(dir, "big"));
    writeFileSync(
      join(dir, "big", "huge.md"),
      `- #menu-link-404 ${"secret-words ".repeat(MAX_NOTE_FILE_CHARS / 10)}\n`,
    );
    const r = await mine("big");
    expect(r.code).toBe(2);
    expect(r.err).toContain("huge.md");
    expect(r.err).not.toContain("secret-words");
    expect(existsSync(join(dir, DRAFT))).toBe(false);
  });

  it("a note that is not text: invalid UTF-8, or a NUL byte", async () => {
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "latin1.md"),
      Buffer.from([0x2d, 0x20, 0x23, 0x61, 0x62, 0x63, 0x20, 0xe9, 0x0a]),
    );
    const a = await mine("bin");
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/UTF-8/);
    rmSync(join(dir, "bin", "latin1.md"));
    writeFileSync(join(dir, "bin", "nul.md"), "- #menu-link-404 ok\u0000\u0001\n");
    const b = await mine("bin");
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/not plain text/);
  });

  it("too many notes", async () => {
    mkdirSync(join(dir, "many"));
    for (let i = 0; i < 201; i++) writeFileSync(join(dir, "many", `n${i}.md`), "");
    const r = await mine("many");
    expect(r.code).toBe(2);
    expect(r.err).toContain("200");
  });

  it("a deny-list that is not there, is not UTF-8 or has a name that is too short: the line, never the name", async () => {
    expect((await mine("golden", "--deny-list", "nope.txt")).code).toBe(2);
    writeFileSync(join(dir, "bad-deny.txt"), "Tidewater Bar\nab\n");
    const r = await mine("golden", "--deny-list", "bad-deny.txt");
    expect(r.code).toBe(2);
    expect(r.err).toContain("line 2");
    expect(r.err).not.toContain("Tidewater");
    writeFileSync(join(dir, "latin1-deny.txt"), Buffer.from([0xe9, 0xe9, 0xe9, 0x0a]));
    expect((await mine("golden", "--deny-list", "latin1-deny.txt")).code).toBe(2);
  });

  it("--out must be a Markdown file outside the notes, never code", async () => {
    for (const out of ["check.ts", "src/new-check.js", "golden/draft.md", "golden", "."]) {
      const r = await mine("golden", "--out", out);
      expect(r.code, out).toBe(2);
      expect(r.err, out).toMatch(/--out/);
    }
    expect(existsSync(join(dir, "check.ts"))).toBe(false);
  });

  it("no --review-notes, an empty one, a word with no flag, or a flag the command does not take", async () => {
    for (const argv of [
      ["mine"],
      ["mine", "--review-notes", ""],
      ["mine", "golden"],
      ["mine", "--review-notes", "golden", "--allow-private"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    expect((await run(["mine"])).err).toContain("--review-notes");
  });
});

describe("gaugeline mine --help and docs/options.md", () => {
  it("prints the help the options page shows, and every flag of the command is in both", async () => {
    const r = await runBin(["mine", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.mine);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The mine command"));
    for (const f of flagsFor(FLAGS, "mine")) {
      expect(HELP.mine, `--${f.name} in --help`).toContain(`--${f.name}`);
      expect(options, `--${f.name} in docs/options.md`).toContain(`\`--${f.name}`);
    }
    expect(flagsFor(FLAGS, "mine").map((f) => f.name)).toEqual(
      expect.arrayContaining(["review-notes", "deny-list", "out"]),
    );
  });
});
