/**
 * gaugeline write-check (AG-16): reads one advisory or docs page saved as a local file, writes a DRAFT, and
 * fails (exit 1, no file) when a cited line holds a client name, a private address, an email or a phone number,
 * or when nothing in the file is understood. No request is made, and nothing but the draft is written.
 */
import {
  cpSync,
  existsSync,
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
  ADVISORY_GITHUB_JSON,
  ADVISORY_MARKDOWN,
  ADVISORY_OSV_JSON,
  CHECK_WRITER_DENY_LIST,
  CLIENT_NAME_MARKDOWN,
  CONTACT_MARKDOWN,
  DOCS_MARKDOWN,
  HOSTILE_MARKDOWN,
  MALFORMED_JSON,
  MAX_ADVISORY_CHARS,
  PARTLY_MARKDOWN,
  PRIVATE_URL_MARKDOWN,
  UNKNOWN_MARKDOWN,
  writeCheckDraft,
} from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const FIX = fileURLToPath(new URL("../../../fixtures/advisories/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const options = readFileSync(join(root, "docs/options.md"), "utf8");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-write-check-")));
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
const DRAFT = "check-writer.draft.md";
const write = (file: string, ...more: string[]) =>
  run(["write-check", "--from-file", file, ...more]);
const tree = (d: string): string[] =>
  readdirSync(d, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(d.length))
    .sort();

describe("the fixture folder is the example the core code and the docs use", () => {
  it("each file holds exactly the example text", () => {
    const same = (path: string, text: string) =>
      expect(readFileSync(join(FIX, path), "utf8"), path).toBe(text);
    same("golden/advisory-kiln-forms.md", ADVISORY_MARKDOWN.text);
    same("golden/advisory-pixel-gallery.json", ADVISORY_OSV_JSON.text);
    same("golden/advisory-menu-embed.txt", ADVISORY_GITHUB_JSON.text);
    same("golden/docs-booking-calendar.md", DOCS_MARKDOWN.text);
    same("hostile/advisory-kiln-forms-hostile.md", HOSTILE_MARKDOWN.text);
    same("not-understood/release-notes.md", UNKNOWN_MARKDOWN.text);
    same("partly/advisory-partly.md", PARTLY_MARKDOWN.text);
    same("leaky-name/advisory-leak-name.md", CLIENT_NAME_MARKDOWN.text);
    same("leaky-url/advisory-leak-url.md", PRIVATE_URL_MARKDOWN.text);
    same("leaky-contact/advisory-leak-contact.md", CONTACT_MARKDOWN.text);
    same("malformed/advisory-truncated.txt", MALFORMED_JSON.text);
    same("deny-list.txt", CHECK_WRITER_DENY_LIST);
  });
});

describe("gaugeline write-check: a draft (exit 0)", () => {
  it("writes the draft the core writer writes, and says what it did", async () => {
    const r = await write("golden/advisory-kiln-forms.md", "--deny-list", "deny-list.txt");
    expect(r.code).toBe(0);
    const expected = writeCheckDraft(ADVISORY_MARKDOWN, { denyList: CHECK_WRITER_DENY_LIST });
    if (!expected.ok) throw new Error("expected a draft");
    expect(readFileSync(join(dir, DRAFT), "utf8")).toBe(expected.markdown);
    expect(r.out).toContain(
      "Wrote 1 floor with a failing and a passing fixture to check-writer.draft.md",
    );
    expect(r.out).toContain("draft for a person to review");
    expect(r.out).toContain("No registry, lock, check or source file was changed");
    expect(r.err).toBe("");
  });

  it.each([
    ["golden/advisory-pixel-gallery.json", 2],
    ["golden/advisory-menu-embed.txt", 1],
    ["golden/docs-booking-calendar.md", 1],
  ])("%s", async (file, floors) => {
    const r = await write(file);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, DRAFT), "utf8").match(/^## Floor \d+:/gm)).toHaveLength(floors);
  });

  it("--out names the file and makes its folder; the advisory and everything else are left as they were", async () => {
    const before = tree(dir);
    const text = readFileSync(join(dir, "golden", "advisory-kiln-forms.md"), "utf8");
    const r = await write("golden/advisory-kiln-forms.md", "--out", "drafts/week-46.md");
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, DRAFT))).toBe(false);
    expect(readFileSync(join(dir, "golden", "advisory-kiln-forms.md"), "utf8")).toBe(text);
    // The one new file is the draft: no registry, lock, check or source file appeared or changed.
    expect(tree(dir)).toEqual([...before, `${join("/drafts", "week-46.md")}`].sort());
  });

  it("running it again gives the same file", async () => {
    await write("golden/advisory-pixel-gallery.json");
    const first = readFileSync(join(dir, DRAFT), "utf8");
    expect((await write("golden/advisory-pixel-gallery.json")).code).toBe(0);
    expect(readFileSync(join(dir, DRAFT), "utf8")).toBe(first);
  });

  it("a hostile file: its orders are counted and ignored, never obeyed or copied", async () => {
    const r = await write("hostile/advisory-kiln-forms-hostile.md");
    expect(r.code).toBe(0);
    const draft = readFileSync(join(dir, DRAFT), "utf8");
    expect(draft).toContain("2 lines that gave an order to an assistant, ignored and never copied");
    expect(draft).not.toMatch(/publish_check|ignore (all )?previous/i);
    expect(r.out + r.err).not.toMatch(/publish_check/);
  });

  it("a file read in part: the draft lists what was not understood, and says so on the terminal", async () => {
    const r = await write("partly/advisory-partly.md");
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 entries not understood, listed in it");
    expect(readFileSync(join(dir, DRAFT), "utf8")).toContain(
      "Line 10: a range with no fixed version.",
    );
  });
});

describe("gaugeline write-check: refused (exit 1, no file)", () => {
  it("a client name in a cited line: the kind and the line, never the name", async () => {
    const r = await write("leaky-name/advisory-leak-name.md", "--deny-list", "deny-list.txt");
    expect(r.code).toBe(1);
    expect(r.out).toContain("The draft failed the scrub");
    expect(r.out).toContain("line 1: a client name");
    expect(r.out + r.err).not.toMatch(/tidewater/i);
    expect(existsSync(join(dir, DRAFT))).toBe(false);
  });

  it("a private source address, an email and a phone number", async () => {
    const url = await write("leaky-url/advisory-leak-url.md");
    expect(url.code).toBe(1);
    expect(url.out).toContain("line 4: a web address that is not public");
    expect(url.out + url.err).not.toMatch(/intranet|corp/);
    const c = await write("leaky-contact/advisory-leak-contact.md");
    expect(c.code).toBe(1);
    expect(c.out).toContain("line 1: an email address");
    expect(c.out).toContain("line 1: a phone number");
    expect(c.out + c.err).not.toMatch(/chef|7946|kitchen/);
    expect(existsSync(join(dir, DRAFT))).toBe(false);
  });

  it("a page in no shape the writer reads: says so, lists, and writes nothing", async () => {
    const r = await write("not-understood/release-notes.md");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Nothing in the file is in a shape the writer reads");
    expect(r.out).toContain("It never guesses a floor");
    expect(r.out).not.toContain("bugs");
    expect(existsSync(join(dir, DRAFT))).toBe(false);
  });

  it("an earlier draft is not touched or removed by a failing run", async () => {
    writeFileSync(join(dir, DRAFT), "an earlier draft\n");
    expect((await write("leaky-url/advisory-leak-url.md")).code).toBe(1);
    expect(readFileSync(join(dir, DRAFT), "utf8")).toBe("an earlier draft\n");
  });
});

describe("gaugeline write-check: could not read (exit 2)", () => {
  it("a file that is not there, a folder, and a link", async () => {
    const a = await write("nowhere.md");
    expect(a.code).toBe(2);
    expect(a.err).toContain("nowhere.md");
    const b = await write("golden");
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/not a plain file/);
    try {
      symlinkSync(join(dir, "golden", "advisory-kiln-forms.md"), join(dir, "link.md"));
      const c = await write("link.md");
      expect(c.code).toBe(2);
      expect(c.err).toMatch(/not a plain file/);
    } catch {
      // A platform that cannot make a link has nothing to refuse.
    }
  });

  it("a file over the cap is refused whole, with its name and none of its text", async () => {
    writeFileSync(join(dir, "huge.md"), `# T\nsecret-words ${"x".repeat(MAX_ADVISORY_CHARS)}\n`);
    const r = await write("huge.md");
    expect(r.code).toBe(2);
    expect(r.err).toContain("huge.md");
    expect(r.err).not.toContain("secret-words");
    // A file whose bytes are under the byte limit but whose characters are over the cap is refused too.
    writeFileSync(join(dir, "wide.md"), `# T\n${"\u00E9".repeat(MAX_ADVISORY_CHARS)}\n`);
    expect((await write("wide.md")).code).toBe(2);
    expect(existsSync(join(dir, DRAFT))).toBe(false);
  });

  it("a file that is not text, has hidden characters, is empty, or is JSON that stops half way", async () => {
    writeFileSync(join(dir, "latin1.md"), Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
    const a = await write("latin1.md");
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/UTF-8/);
    writeFileSync(join(dir, "nul.md"), "# T\u0000\u0001\n");
    expect((await write("nul.md")).err).toMatch(/not plain text/);
    writeFileSync(join(dir, "hidden.md"), "# T\u200Bx\n");
    expect((await write("hidden.md")).err).toMatch(/hidden characters/);
    writeFileSync(join(dir, "empty.md"), "\n");
    expect((await write("empty.md")).err).toMatch(/empty/);
    const j = await write("malformed/advisory-truncated.txt");
    expect(j.code).toBe(2);
    expect(j.err).toMatch(/cannot be parsed as JSON/);
    expect(j.err).not.toContain("GHSA");
  });

  it("a deny-list that is not there, is not UTF-8 or has a name that is too short: the line, never the name", async () => {
    expect((await write("golden/advisory-kiln-forms.md", "--deny-list", "nope.txt")).code).toBe(2);
    writeFileSync(join(dir, "bad-deny.txt"), "Tidewater Bar\nab\n");
    const r = await write("golden/advisory-kiln-forms.md", "--deny-list", "bad-deny.txt");
    expect(r.code).toBe(2);
    expect(r.err).toContain("line 2");
    expect(r.err).not.toContain("Tidewater");
    writeFileSync(join(dir, "latin1-deny.txt"), Buffer.from([0xe9, 0xe9, 0xe9, 0x0a]));
    expect(
      (await write("golden/advisory-kiln-forms.md", "--deny-list", "latin1-deny.txt")).code,
    ).toBe(2);
  });

  it("--out must be a Markdown file and not the advisory itself, never code or the registry", async () => {
    for (const out of [
      "check.ts",
      "src/new-check.js",
      "library-advisories.json",
      "golden/advisory-kiln-forms.md.json",
      ".",
    ]) {
      const r = await write("golden/advisory-kiln-forms.md", "--out", out);
      expect(r.code, out).toBe(2);
      expect(r.err, out).toMatch(/--out/);
    }
    const same = await write(
      "golden/advisory-kiln-forms.md",
      "--out",
      "golden/advisory-kiln-forms.md",
    );
    expect(same.code).toBe(2);
    expect(same.err).toMatch(/not the advisory itself/);
    expect(readFileSync(join(dir, "golden", "advisory-kiln-forms.md"), "utf8")).toBe(
      ADVISORY_MARKDOWN.text,
    );
  });

  it("no --from-file, an empty one, a word with no flag, or a flag the command does not take", async () => {
    for (const argv of [
      ["write-check"],
      ["write-check", "--from-file", ""],
      ["write-check", "golden/advisory-kiln-forms.md"],
      ["write-check", "--from-file", "golden/advisory-kiln-forms.md", "--allow-private"],
      ["write-check", "--from-file", "golden/advisory-kiln-forms.md", "--review-notes", "x"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    expect((await run(["write-check"])).err).toContain("--from-file");
  });
});

describe("gaugeline write-check --help and docs/options.md", () => {
  it("prints the help the options page shows, and every flag of the command is in both", async () => {
    const r = await runBin(["write-check", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP["write-check"]);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The write-check command"));
    for (const f of flagsFor(FLAGS, "write-check")) {
      expect(HELP["write-check"], `--${f.name} in --help`).toContain(`--${f.name}`);
      expect(options, `--${f.name} in docs/options.md`).toContain(`\`--${f.name}`);
    }
    expect(flagsFor(FLAGS, "write-check").map((f) => f.name)).toEqual(
      expect.arrayContaining(["from-file", "deny-list", "out"]),
    );
  });

  it("mine keeps its own words for the flag it shares", () => {
    expect(HELP.mine).toContain("mine: a file of client names");
    expect(HELP["write-check"]).toContain("write-check: a file of client names");
  });
});
