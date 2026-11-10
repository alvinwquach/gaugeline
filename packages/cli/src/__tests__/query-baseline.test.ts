import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeBaseline, toBaseline } from "@gaugeline/core";
import {
  COPPERHILL_BEFORE_RENAME,
  COPPERHILL_COUNTS,
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";
import { runQuery } from "../query.js";
import { nodeFs, type ScaffoldFs } from "../scaffold-write.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../fixtures/repo-groq");
const writes = resolve(here, "../../../fixtures/repo-mutations");

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["sk", "viewer", "Copperhill0123456789abcdef"].join("_");
const ENV = { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production" };
const NOW = new Date("2026-11-10T12:00:00Z");

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A copy of an invented repository to run in and change, at its real path (macOS's tmpdir is a link). */
function copyOf(source: string): string {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-baseline-")));
  made.push(sandbox);
  const dir = join(sandbox, "site");
  cpSync(source, dir, { recursive: true });
  return dir;
}

interface Ran {
  code: number;
  out: string;
  err: string;
  seen: SeenSanityRequest[];
}

async function query(
  cwd: string,
  argv: string[],
  options: { dataset?: FakeSanity; env?: Record<string, string | undefined> } = {},
): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const seen: SeenSanityRequest[] = [];
  const code = await main(
    ["query", ...argv],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: options.env ?? ENV,
    },
    {
      cwd,
      now: () => NOW,
      fetcher: {
        transport: sanityCountsTransport(options.dataset ?? COPPERHILL_BEFORE_RENAME, seen),
        timeoutMs: 5000,
      },
    },
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

/** The file as data: a baseline this test did not write is compared by what it parses to, never by its text. */
const read = (
  path: string,
): { schema: number; createdAt: string; gaps: Array<Record<string, string>> } =>
  JSON.parse(readFileSync(path, "utf8")) as never;

/** Every file and folder under a folder, as paths relative to it, in order. */
function tree(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : join(rel, e.name);
      out.push(path.split("\\").join("/"));
      if (e.isDirectory()) visit(path);
    }
  };
  visit("");
  return out.sort();
}

describe("gaugeline query --save and --against: the three steps", () => {
  it("saves on the code as it is, then names the work a field rename created, in the files to edit", async () => {
    const cwd = copyOf(repo);
    // 1. Run on the current code.
    const first = await query(cwd, [".", "--save", "before.json"]);
    expect(first.code).toBe(EXIT.ok);
    expect(first.out).toContain("12 shapes from 10 queries; 2 could not be read.");
    expect(first.out).toMatch(/Saved the baseline to before\.json: 11 gaps\./);
    expect(first.err).toBe("");
    const saved = read(join(cwd, "before.json"));
    expect(saved.schema).toBe(1);
    expect(saved.createdAt).toBe("2026-11-10T12:00:00.000Z");
    expect(saved.gaps).toHaveLength(11);
    // 2. The change: the pop-ups' date field moves to startsAt in the dataset. 3. Run again.
    const third = await query(cwd, [".", "--against", "before.json"], {
      dataset: COPPERHILL_COUNTS,
    });
    expect(third.code).toBe(EXIT.ok);
    expect(third.err).toBe("");
    expect(third.out).toMatchInlineSnapshot(`
      "Compared with before.json, saved 2026-11-10T12:00:00.000Z.

      Created by this change: 2 gaps in 2 files. These are the files to edit.

      src/app/events/page.tsx
        line 3  ✗ date doesn't exist on any popup: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.
      src/sanity/queries.ts
        line 20  ✗ date doesn't exist on any popup: 0 of 9 documents have it. The field was probably renamed, so what shows it renders empty.

      Closed by this change: none.

      11 gaps were already there and are not listed.
      "
    `);
  });

  it("with --ci exits 1 for the high gap the change created, and 0 when nothing new is high", async () => {
    const cwd = copyOf(repo);
    await query(cwd, [".", "--save", "before.json"]);
    const ci = await query(cwd, [".", "--against", "before.json", "--ci"], {
      dataset: COPPERHILL_COUNTS,
    });
    expect(ci.code).toBe(EXIT.findings);
    // The same code and the same dataset: nothing is new, so --ci passes.
    const same = await query(cwd, [".", "--against", "before.json", "--ci"]);
    expect(same.code).toBe(EXIT.ok);
    expect(same.out).toContain("Created by this change: none.");
  });

  it("gaps that were already in the baseline do not fail --ci, even the high ones", async () => {
    const cwd = copyOf(repo);
    // The baseline is taken after the rename: the two high gaps for `date` are already there.
    await query(cwd, [".", "--save", "after.json"], { dataset: COPPERHILL_COUNTS });
    expect((await query(cwd, [".", "--ci"], { dataset: COPPERHILL_COUNTS })).code).toBe(
      EXIT.findings,
    );
    const r = await query(cwd, [".", "--against", "after.json", "--ci"], {
      dataset: COPPERHILL_COUNTS,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("13 gaps were already there");
  });

  it("makes only GET requests, one for each type, as a normal run does", async () => {
    const cwd = copyOf(repo);
    const a = await query(cwd, [".", "--save", "before.json"]);
    const b = await query(cwd, [".", "--against", "before.json"]);
    for (const r of [a, b]) {
      expect(r.seen).toHaveLength(8);
      for (const s of r.seen) expect(s.method).toBe("GET");
    }
  });

  it("a query that moved inside its file, or a folder typed another way, creates nothing", async () => {
    const cwd = copyOf(repo);
    await query(cwd, [".", "--save", "before.json"]);
    const page = join(cwd, "src", "app", "events", "page.tsx");
    writeFileSync(page, `// a comment added above\n// and another\n${readFileSync(page, "utf8")}`);
    const moved = await query(cwd, [".", "--against", "before.json"]);
    expect(moved.out).toContain("Created by this change: none.");
    expect(moved.out).toContain("Closed by this change: none.");
    // The paths in the file are from where the command ran, however the folder was typed.
    const typed = await query(cwd, ["./src", "--against", "before.json"]);
    expect(typed.out).toContain("Created by this change: none.");
    await query(cwd, ["./src", "--save", "src.json"]);
    const other = await query(cwd, ["src/app/", "--against", "src.json"]);
    expect(other.out).toContain("Created by this change: none.");
    // An absolute folder is read as the same files too: a baseline saved in CI is read on a laptop.
    const absolute = await query(cwd, [join(cwd, "src"), "--against", "src.json"]);
    expect(absolute.out).toContain("Created by this change: none.");
    expect(absolute.out).toContain("Closed by this change: none.");
  });

  it("a gap in a file that was left, and a file that was renamed, say so", async () => {
    const cwd = copyOf(repo);
    await query(cwd, [".", "--save", "before.json"]);
    renameSync(
      join(cwd, "src", "app", "events", "page.tsx"),
      join(cwd, "src", "app", "events", "index.tsx"),
    );
    const r = await query(cwd, [".", "--against", "before.json"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Created by this change: 1 gap in 1 file");
    expect(r.out).toContain("src/app/events/index.tsx");
    expect(r.out).toContain("Closed by this change: 1 gap");
    expect(r.out).toContain("src/app/events/page.tsx");
    expect(r.out).toContain(
      "Looks like a renamed file, so its gaps show as closed and created: src/app/events/page.tsx is now src/app/events/index.tsx.",
    );
  });

  it("when the queries are gone altogether, every saved gap is closed", async () => {
    const cwd = copyOf(repo);
    await query(cwd, [".", "--save", "before.json"]);
    mkdirSync(join(cwd, "empty"));
    const r = await query(cwd, ["empty", "--against", "before.json"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Created by this change: none.");
    expect(r.out).toContain("Closed by this change: 11 gaps.");
    expect(r.out).not.toContain("did not make");
  });

  it("an empty baseline makes every gap created", async () => {
    const cwd = copyOf(repo);
    writeFileSync(join(cwd, "empty.json"), serializeBaseline(toBaseline([], NOW)));
    const r = await query(cwd, [".", "--against", "empty.json", "--ci"]);
    expect(r.code).toBe(EXIT.findings);
    expect(r.out).toContain("Created by this change: 11 gaps in 6 files");
    expect(r.out).toContain("Closed by this change: none.");
    expect(r.out).toContain("0 gaps were already there");
  });
});

describe("gaugeline query --save and --against: refusals, exit 2", () => {
  it("--against a file that does not exist names the path, and asks nothing", async () => {
    const cwd = copyOf(repo);
    const r = await query(cwd, [".", "--against", "nowhere/before.json"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("nowhere/before.json");
    expect(r.seen).toEqual([]);
    expect(r.out).toBe("");
  });

  it("--against something that is not a baseline, or a baseline of schema 2, is refused", async () => {
    const cwd = copyOf(repo);
    writeFileSync(join(cwd, "notes.txt"), "some notes\n");
    const notBaseline = await query(cwd, [".", "--against", "notes.txt"]);
    expect(notBaseline.code).toBe(EXIT.couldNotRun);
    expect(notBaseline.err).toContain("notes.txt is not a Gaugeline baseline");
    await query(cwd, [".", "--save", "before.json"]);
    const text = readFileSync(join(cwd, "before.json"), "utf8");
    writeFileSync(join(cwd, "future.json"), text.replace('"schema": 1', '"schema": 2'));
    const r = await query(cwd, [".", "--against", "future.json"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("future.json was written with baseline schema 2");
    expect(r.err).toContain("reads schema 1");
    expect(r.seen).toEqual([]);
  });

  it("--save and --against together are refused", async () => {
    const cwd = copyOf(repo);
    const r = await query(cwd, [".", "--save", "a.json", "--against", "b.json"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("--save and --against cannot be used together");
    expect(r.seen).toEqual([]);
    expect(existsSync(join(cwd, "a.json"))).toBe(false);
  });

  it("neither can be mixed with a run that is not the query check, or with --json", async () => {
    const cwd = copyOf(repo);
    for (const other of [
      ["--graphql"],
      ["--unused"],
      ["--dupes"],
      ["--json"],
      ["--suggest", "--type", "popup"],
      ["--totals", "popup:a=b"],
    ])
      for (const flag of ["--save", "--against"]) {
        const r = await query(cwd, [".", flag, "x.json", ...other]);
        expect(r.code, `${flag} ${other.join(" ")}`).toBe(EXIT.couldNotRun);
        expect(r.err).toContain(flag);
        expect(r.seen).toEqual([]);
      }
    expect(existsSync(join(cwd, "x.json"))).toBe(false);
  });

  it("without a project id or --mutations there are no findings to keep, so it says so", async () => {
    const cwd = copyOf(repo);
    for (const flag of ["--save", "--against"]) {
      const r = await query(cwd, [".", flag, "x.json"], { env: {} });
      expect(r.code).toBe(EXIT.couldNotRun);
      expect(r.err).toContain("SANITY_PROJECT_ID");
    }
    expect(existsSync(join(cwd, "x.json"))).toBe(false);
  });

  it("a folder with no queries is not saved as a baseline with nothing in it", async () => {
    const cwd = copyOf(repo);
    mkdirSync(join(cwd, "empty"));
    const r = await query(cwd, ["empty", "--save", "before.json"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("No GROQ queries");
    expect(existsSync(join(cwd, "before.json"))).toBe(false);
  });

  it("parses the flags: a file name each, and --force is for --page and --save", () => {
    expect(parseCliArgs(["query", ".", "--save", "before.json"])).toMatchObject({
      kind: "query",
      save: { file: "before.json", force: false },
    });
    expect(parseCliArgs(["query", ".", "--save", "before.json", "--force"])).toMatchObject({
      save: { file: "before.json", force: true },
    });
    expect(parseCliArgs(["query", ".", "--against", "before.json"])).toMatchObject({
      kind: "query",
      against: { file: "before.json" },
    });
    expect(parseCliArgs(["query", ".", "--save", " "])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["query", ".", "--force"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--force is for --page and --save"),
    });
    expect(parseCliArgs(["query", ".", "--against", "a.json", "--force"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("gaugeline query --save: the safe writer", () => {
  it("never overwrites without --force, and --force replaces only that file", async () => {
    const cwd = copyOf(repo);
    writeFileSync(join(cwd, "before.json"), "mine\n");
    writeFileSync(join(cwd, "other.json"), "keep\n");
    const refused = await query(cwd, [".", "--save", "before.json"]);
    expect(refused.code).toBe(EXIT.couldNotRun);
    expect(refused.err).toContain("already exists");
    expect(refused.err).toContain("--force");
    expect(readFileSync(join(cwd, "before.json"), "utf8")).toBe("mine\n");
    // Refused before the dataset was asked anything.
    expect(refused.seen).toEqual([]);
    const forced = await query(cwd, [".", "--save", "before.json", "--force"]);
    expect(forced.code).toBe(EXIT.ok);
    expect(read(join(cwd, "before.json")).schema).toBe(1);
    expect(readFileSync(join(cwd, "other.json"), "utf8")).toBe("keep\n");
  });

  it("writes nothing outside the folder it ran in, by a path or through a link, and no folder either", async () => {
    const cwd = copyOf(repo);
    const sandbox = dirname(cwd);
    for (const target of ["../outside.json", resolve(sandbox, "outside.json")]) {
      const r = await query(cwd, [".", "--save", target]);
      expect(r.code, target).toBe(EXIT.couldNotRun);
      expect(r.err).toContain("not a file inside the folder you ran the command in");
    }
    expect(readdirSync(sandbox)).toEqual(["site"]);
  });

  it("makes the folders it needs, prints every path it wrote, and keeps the baseline out of the output of the run", async () => {
    const cwd = copyOf(repo);
    const r = await query(cwd, [".", "--save", "baselines/q1/before.json"]);
    expect(r.code).toBe(EXIT.ok);
    expect(existsSync(join(cwd, "baselines", "q1", "before.json"))).toBe(true);
    expect(r.out).toContain("Saved the baseline to baselines/q1/before.json:");
  });

  it("is all or nothing: a write that fails leaves no file and no folder behind", async () => {
    const cwd = copyOf(repo);
    const calls: string[] = [];
    const fs: ScaffoldFs = {
      ...nodeFs,
      mkdir: (p) => {
        calls.push("mkdir");
        return nodeFs.mkdir(p);
      },
      writeFile: () => {
        calls.push("writeFile");
        return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      },
    };
    const before = tree(cwd);
    const error = await runQuery(
      { dir: ".", save: { file: "baselines/before.json", force: false } },
      { stdout: { write: () => true }, stderr: { write: () => true }, env: ENV },
      {
        cwd,
        now: NOW,
        fs,
        fetcher: {
          transport: sanityCountsTransport(COPPERHILL_BEFORE_RENAME, []),
          timeoutMs: 5000,
        },
      },
    ).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain("Nothing was written");
    expect(error?.message).toContain("EACCES");
    expect(calls).toEqual(["mkdir", "writeFile"]);
    expect(tree(cwd)).toEqual(before);
  });
});

describe("gaugeline query --save with --mutations", () => {
  it("needs no project id: the writes' gaps are kept, and found again unchanged", async () => {
    const cwd = copyOf(writes);
    const a = await query(cwd, [".", "--mutations", "--save", "before.json"], { env: {} });
    expect(a.code).toBe(EXIT.ok);
    expect(a.seen).toEqual([]);
    const saved = read(join(cwd, "before.json"));
    expect(saved.gaps.length).toBeGreaterThan(3);
    expect(new Set(saved.gaps.map((g) => g.checkId))).toContain("mutation-undeclared-field");
    const b = await query(cwd, [".", "--mutations", "--against", "before.json"], { env: {} });
    expect(b.out).toContain("Created by this change: none.");
    expect(b.out).toContain("Closed by this change: none.");
    expect(b.out).toContain(`${saved.gaps.length} gaps were already there`);
  });

  it("gaps from checks this run did not make are left out, and the run says so", async () => {
    const cwd = copyOf(writes);
    await query(cwd, [".", "--mutations", "--save", "before.json"], { env: {} });
    const b = await query(cwd, [".", "--against", "before.json"], { env: ENV });
    expect(b.out).toMatch(/\d+ gaps? in before\.json come from checks this run did not make/);
    expect(b.out).toContain("Closed by this change: none.");
  });
});

describe("gaugeline query --save: promise test, names and nothing else", () => {
  it("the file holds no token and no value from the seeded dataset", async () => {
    const cwd = copyOf(repo);
    // The dataset the run asks holds documents with ids, slugs and titles, and the token is in the environment.
    const seeded = COPPERHILL_COUNTS.documents ?? {};
    const values = new Set<string>();
    for (const docs of Object.values(seeded))
      for (const d of docs) {
        values.add(d._id);
        if (typeof d.slug === "string") values.add(d.slug);
        if (typeof d.title === "string") values.add(d.title.trim());
      }
    expect(values.size).toBeGreaterThan(8);
    const r = await query(cwd, [".", "--save", "before.json"], {
      env: { ...ENV, SANITY_TOKEN: TOKEN },
      dataset: { ...COPPERHILL_COUNTS, token: TOKEN },
    });
    expect(r.code).toBe(EXIT.ok);
    const text = readFileSync(join(cwd, "before.json"), "utf8");
    expect(text).not.toContain(TOKEN);
    expect(r.out + r.err).not.toContain(TOKEN);
    for (const v of values) expect(text, v).not.toContain(v);
    // Only the five names a gap is made of, and the schema, the time and the list.
    const parsed = read(join(cwd, "before.json"));
    expect(Object.keys(parsed)).toEqual(["schema", "createdAt", "gaps"]);
    for (const g of parsed.gaps)
      expect(Object.keys(g).sort()).toEqual(
        Object.keys(g).includes("field")
          ? ["checkId", "field", "file", "key", "type"]
          : ["checkId", "file", "key", "type"],
      );
    // No counts and no lines: the key is the same however many documents or whatever line.
    expect(text).not.toMatch(/\d+ of \d+/);
    expect(parsed.gaps.map((g) => g.key).join("\n")).not.toMatch(/\|\d+$/);
  });
});
