import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTENT_MARKER,
  NORTHFIELD_CONTENT,
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { EXIT, main } from "../main.js";
import { runPage } from "../query-page.js";
import { nodeFs, type ScaffoldFs } from "../scaffold-write.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../fixtures/repo-gql");
const ENV = { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" };
const NAMES = ["queries.ts", "types.ts", "page.tsx"];
const OUT = "./app/resource/[slug]";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * A fresh folder to run in, with Northfield's schema.json in it, inside a sandbox of its own so
 * that what is next to it (a sibling, the parent) is this test's alone. Its real path: macOS's
 * tmpdir is a link.
 */
function project(): string {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-page-")));
  made.push(sandbox);
  const dir = join(sandbox, "project");
  mkdirSync(dir);
  copyFileSync(join(repo, "schema.json"), join(dir, "schema.json"));
  return dir;
}

/** A second, empty folder that is not inside the first. */
function elsewhere(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-elsewhere-")));
  made.push(dir);
  return dir;
}

/** Every file and folder under a folder, as paths relative to it, in order. */
function tree(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : join(rel, e.name);
      out.push(path);
      if (e.isDirectory()) visit(path);
    }
  };
  visit("");
  return out.sort();
}

interface Ran {
  code: number;
  out: string;
  err: string;
  seen: SeenSanityRequest[];
}

async function page(
  argv: string[],
  cwd: string,
  options: { env?: Record<string, string | undefined>; spec?: FakeSanity } = {},
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
      now: () => new Date("2026-11-10T12:00:00Z"),
      fetcher: {
        transport: sanityCountsTransport(options.spec ?? NORTHFIELD_CONTENT, seen),
        timeoutMs: 5000,
      },
    },
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

const PAGE = ["--page", "--type", "resource"];

describe("gaugeline query --page: unit (arguments)", () => {
  it("takes --page with --type and --out, and no folder", () => {
    expect(parseCliArgs(["query", ...PAGE, "--out", OUT])).toMatchObject({
      kind: "query",
      page: { type: "resource", out: OUT, force: false },
    });
    expect(parseCliArgs(["query", ...PAGE, "--out", OUT, "--force"])).toMatchObject({
      page: { force: true },
    });
    expect(parseCliArgs(["query", ...PAGE, "--out", OUT, "--schema", "./s.json"])).toMatchObject({
      schema: "./s.json",
    });
  });

  it("--page without --type is a usage message that shows the command", () => {
    const r = parseCliArgs(["query", "--page", "--out", OUT]);
    expect(r).toMatchObject({ kind: "error" });
    expect(r.kind === "error" && r.message).toContain("--page --type resource --out");
  });

  it("--page without --out is a usage message that shows the command", () => {
    const r = parseCliArgs(["query", ...PAGE]);
    expect(r).toMatchObject({ kind: "error" });
    expect(r.kind === "error" && r.message).toContain("--out");
  });

  it("--page takes no folder: it writes where --out says", () => {
    expect(parseCliArgs(["query", "./src", ...PAGE, "--out", OUT])).toMatchObject({
      kind: "error",
    });
  });

  it("--out and --force are for --page, and --page is its own run", () => {
    expect(parseCliArgs(["query", "./src", "--out", OUT])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["query", "./src", "--force"])).toMatchObject({ kind: "error" });
    for (const other of ["--suggest", "--graphql", "--dupes", "--mutations", "--json"])
      expect(parseCliArgs(["query", ...PAGE, "--out", OUT, other])).toMatchObject({
        kind: "error",
      });
  });

  it("--out is still the snapshot's flag, and --force is still the plan's", () => {
    expect(parseCliArgs(["snapshot", "example.com", "--out", "x.json"])).toMatchObject({
      kind: "snapshot",
    });
    expect(parseCliArgs(["check", "https://example.com", "--out", "x"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("gaugeline query --page: e2e (CLI, into a folder named [slug])", () => {
  it("writes the three files, prints the summary and every path, exit 0", async () => {
    const cwd = project();
    const r = await page([...PAGE, "--out", OUT], cwd);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    expect(r.out.split("\n")).toEqual([
      "Wrote 3 files to ./app/resource/[slug] from 12 published resource documents",
      "  ./app/resource/[slug]/queries.ts",
      "  ./app/resource/[slug]/types.ts",
      "  ./app/resource/[slug]/page.tsx",
      "",
    ]);
    const folder = join(cwd, "app", "resource", "[slug]");
    expect(readdirSync(folder).sort()).toEqual([...NAMES].sort());
    const read = (name: string): string => readFileSync(join(folder, name), "utf8");
    expect(read("queries.ts")).toContain("export const resourceQuery = groq`");
    expect(read("types.ts")).toContain("export interface Resource {");
    expect(read("page.tsx")).toContain("export async function generateStaticParams()");
    for (const name of NAMES) expect(read(name)).not.toContain("\r");
  });

  it("the folder is created when missing, and a folder that exists is used", async () => {
    const cwd = project();
    mkdirSync(join(cwd, "app"), { recursive: true });
    expect((await page([...PAGE, "--out", "app/a/b"], cwd)).code).toBe(EXIT.ok);
    expect(readdirSync(join(cwd, "app", "a", "b")).sort()).toEqual([...NAMES].sort());
    mkdirSync(join(cwd, "ready"));
    expect((await page([...PAGE, "--out", "ready"], cwd)).code).toBe(EXIT.ok);
    expect(readdirSync(join(cwd, "ready")).sort()).toEqual([...NAMES].sort());
  });

  it("a path as typed with a trailing slash prints as typed, and an absolute path inside the folder works", async () => {
    const cwd = project();
    const r = await page([...PAGE, "--out", "app/one/"], cwd);
    expect(r.out.split("\n")[0]).toBe(
      "Wrote 3 files to app/one from 12 published resource documents",
    );
    expect((await page([...PAGE, "--out", join(cwd, "app", "two")], cwd)).code).toBe(EXIT.ok);
    expect(existsSync(join(cwd, "app", "two", "page.tsx"))).toBe(true);
  });

  it("a path that goes up and comes back inside the folder is allowed", async () => {
    const cwd = project();
    const r = await page([...PAGE, "--out", "a/../b"], cwd);
    expect(r.code).toBe(EXIT.ok);
    expect(existsSync(join(cwd, "b", "queries.ts"))).toBe(true);
    expect(existsSync(join(cwd, "a"))).toBe(false);
  });

  it("a folder that is not named [slug] is used as given, and the page says so on stderr", async () => {
    const cwd = project();
    const r = await page([...PAGE, "--out", "app/resource/[id]"], cwd);
    expect(r.code).toBe(EXIT.ok);
    expect(existsSync(join(cwd, "app", "resource", "[id]", "page.tsx"))).toBe(true);
    expect(r.err).toContain("params.slug");
    expect((await page([...PAGE, "--out", "app/x/[slug]", "--quiet"], cwd)).err).toBe("");
  });

  it("the files are what the same command gives again: same input, same output", async () => {
    const one = project();
    const two = project();
    await page([...PAGE, "--out", "r"], one);
    await page([...PAGE, "--out", "r"], two);
    for (const name of NAMES)
      expect(readFileSync(join(two, "r", name), "utf8")).toBe(
        readFileSync(join(one, "r", name), "utf8"),
      );
  });
});

describe("gaugeline query --page: edge cases", () => {
  it("--out above the working directory: refused, exit 2, nothing written, nothing requested", async () => {
    const cwd = project();
    const before = readdirSync(dirname(cwd));
    const r = await page([...PAGE, "--out", "../elsewhere"], cwd);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("../elsewhere");
    expect(r.err).toContain("outside");
    expect(tree(cwd)).toEqual(["schema.json"]);
    expect(existsSync(join(dirname(cwd), "elsewhere"))).toBe(false);
    expect(readdirSync(dirname(cwd))).toEqual(before);
    expect(r.seen).toEqual([]);
  });

  it("an absolute path in another folder is refused, and so is one that climbs out after going in", async () => {
    const cwd = project();
    const other = elsewhere();
    for (const out of [join(other, "app"), "a/../../up", "..", join(cwd, "..", "x")]) {
      const r = await page([...PAGE, "--out", out], cwd);
      expect(r.code, out).toBe(EXIT.couldNotRun);
      expect(r.err, out).toContain("outside");
    }
    expect(tree(other)).toEqual([]);
    expect(tree(cwd)).toEqual(["schema.json"]);
  });

  it("a link inside the folder that points outside it does not get the files", async () => {
    const cwd = project();
    const other = elsewhere();
    try {
      symlinkSync(other, join(cwd, "link"), "junction");
    } catch {
      return; // links cannot be made here (no privilege): nothing to test
    }
    const r = await page([...PAGE, "--out", "link/app"], cwd);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("outside");
    expect(tree(other)).toEqual([]);
  });

  it("a target file that already exists: refused without --force, and the other two are not written", async () => {
    const cwd = project();
    const folder = join(cwd, "app");
    mkdirSync(folder);
    writeFileSync(join(folder, "page.tsx"), "// mine\n");
    const r = await page([...PAGE, "--out", "app"], cwd);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toBe("");
    expect(r.err).toContain("page.tsx");
    expect(r.err).toContain("--force");
    expect(readdirSync(folder)).toEqual(["page.tsx"]);
    expect(readFileSync(join(folder, "page.tsx"), "utf8")).toBe("// mine\n");
    expect(r.seen).toEqual([]);
  });

  it("with --force the three files replace what is there, and nothing else in the folder is touched", async () => {
    const cwd = project();
    const folder = join(cwd, "app");
    mkdirSync(folder);
    writeFileSync(join(folder, "page.tsx"), "// mine\n");
    writeFileSync(join(folder, "notes.md"), "keep\n");
    const r = await page([...PAGE, "--out", "app", "--force"], cwd);
    expect(r.code).toBe(EXIT.ok);
    expect(readFileSync(join(folder, "page.tsx"), "utf8")).toContain("generateStaticParams");
    expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("keep\n");
    expect(readdirSync(folder).sort()).toEqual(["notes.md", ...NAMES].sort());
  });

  it("--force does not replace a folder or a link, and --out cannot be a file", async () => {
    const cwd = project();
    mkdirSync(join(cwd, "app", "page.tsx"), { recursive: true });
    const r = await page([...PAGE, "--out", "app", "--force"], cwd);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("page.tsx");
    expect(readdirSync(join(cwd, "app"))).toEqual(["page.tsx"]);
    writeFileSync(join(cwd, "afile"), "x");
    const f = await page([...PAGE, "--out", "afile"], cwd);
    expect(f.code).toBe(EXIT.couldNotRun);
    expect(f.err).toContain("afile");
    expect(readFileSync(join(cwd, "afile"), "utf8")).toBe("x");

    const other = elsewhere();
    writeFileSync(join(other, "target.txt"), "outside\n");
    const linked = project();
    mkdirSync(join(linked, "app"));
    try {
      symlinkSync(join(other, "target.txt"), join(linked, "app", "types.ts"), "file");
    } catch {
      return;
    }
    const l = await page([...PAGE, "--out", "app", "--force"], linked);
    expect(l.code).toBe(EXIT.couldNotRun);
    expect(readFileSync(join(other, "target.txt"), "utf8")).toBe("outside\n");
  });

  it("a type with no published documents: exit 2, nothing written, not even the folder", async () => {
    const cwd = project();
    const r = await page(["--page", "--type", "topic", "--out", "app/topic"], cwd);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("Nothing of type topic exists");
    expect(tree(cwd)).toEqual(["schema.json"]);
  });

  it("a type the schema does not declare, a missing project id and a missing schema: exit 2, nothing written", async () => {
    const cwd = project();
    const unknown = await page(["--page", "--type", "recipe", "--out", "r"], cwd);
    expect(unknown.code).toBe(EXIT.couldNotRun);
    expect(unknown.err).toContain('no document type named "recipe"');
    const noId = await page([...PAGE, "--out", "r"], cwd, { env: {} });
    expect(noId.code).toBe(EXIT.couldNotRun);
    expect(noId.err).toContain("SANITY_PROJECT_ID");
    const bare = join(dirname(cwd), "bare");
    mkdirSync(bare);
    const noSchema = await page([...PAGE, "--out", "r"], bare);
    expect(noSchema.code).toBe(EXIT.couldNotRun);
    expect(noSchema.err).toContain("needs the schema");
    expect(tree(cwd)).toEqual(["schema.json"]);
    expect(tree(bare)).toEqual([]);
    expect(noSchema.seen).toEqual([]);
  });

  it("--page without --type or without --out: usage message, exit 2, nothing written or requested", async () => {
    const cwd = project();
    for (const argv of [
      ["--page", "--out", "r"],
      ["--page", "--type", "resource"],
    ]) {
      const r = await page(argv, cwd);
      expect(r.code).toBe(EXIT.couldNotRun);
      expect(r.out).toBe("");
      expect(r.err).toContain("--page --type resource --out");
      expect(r.seen).toEqual([]);
    }
    expect(tree(cwd)).toEqual(["schema.json"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a read-only folder: a clear message, exit 2, no partial files left behind",
    async () => {
      const cwd = project();
      const locked = join(cwd, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      try {
        const r = await page([...PAGE, "--out", "locked/app"], cwd);
        expect(r.code).toBe(EXIT.couldNotRun);
        expect(r.err).toContain("Nothing was written");
        expect(readdirSync(locked)).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

/** A file system that does what the real one does, and tells the test every call. */
function spy(fail?: (op: string, path: string, count: number) => Error | undefined): {
  fs: ScaffoldFs;
  calls: { op: string; path: string }[];
} {
  const calls: { op: string; path: string }[] = [];
  const counts = new Map<string, number>();
  const wrap =
    <A extends unknown[], R>(op: string, fn: (path: string, ...rest: A) => Promise<R>) =>
    async (path: string, ...rest: A): Promise<R> => {
      calls.push({ op, path });
      const n = (counts.get(op) ?? 0) + 1;
      counts.set(op, n);
      const err = fail?.(op, path, n);
      if (err) throw err;
      return fn(path, ...rest);
    };
  return {
    calls,
    fs: {
      lstat: wrap("lstat", nodeFs.lstat),
      realpath: wrap("realpath", nodeFs.realpath),
      readFile: wrap("readFile", nodeFs.readFile),
      mkdir: wrap("mkdir", nodeFs.mkdir),
      writeFile: wrap("writeFile", nodeFs.writeFile),
      unlink: wrap("unlink", nodeFs.unlink),
      rmdir: wrap("rmdir", nodeFs.rmdir),
    },
  };
}

const denied = (op: string): Error =>
  Object.assign(new Error(`EACCES: permission denied, ${op}`), { code: "EACCES" });

async function runWith(
  cwd: string,
  out: string,
  fs: ScaffoldFs,
  force = false,
): Promise<{ result: unknown; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runPage(
    { page: { type: "resource", out, force } },
    {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      env: ENV,
    },
    {
      cwd,
      fs,
      fetcher: { transport: sanityCountsTransport(NORTHFIELD_CONTENT, []), timeoutMs: 5000 },
    },
  ).then(
    (o) => o,
    (e: unknown) => e,
  );
  return { result, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("gaugeline query --page: all three files or none", () => {
  it("a write that fails on the second file removes the first, and the folders this run made", async () => {
    const cwd = project();
    const { fs } = spy((op, _path, n) => (op === "writeFile" && n === 2 ? denied(op) : undefined));
    const { result, stdout } = await runWith(cwd, "app/resource/[slug]", fs);
    expect(result).toMatchObject({ message: expect.stringContaining("Nothing was written") });
    expect(String((result as Error).message)).toContain("EACCES");
    expect(stdout).toBe("");
    expect(tree(cwd)).toEqual(["schema.json"]);
  });

  it("the folders are removed whatever way mkdir spells the first one it made", async () => {
    // Windows can report a created path in another form (a short name, another case) than the one
    // that was asked for. Cleaning up must not depend on it.
    const cwd = project();
    const { fs } = spy((op, _path, n) => (op === "writeFile" && n === 2 ? denied(op) : undefined));
    const respelled: ScaffoldFs = {
      ...fs,
      mkdir: async (path) => {
        await fs.mkdir(path);
        return join(tmpdir(), "somewhere", "else");
      },
    };
    const { result } = await runWith(cwd, "app/resource/[slug]", respelled);
    expect(result).toMatchObject({ message: expect.stringContaining("Nothing was written") });
    expect(tree(cwd)).toEqual(["schema.json"]);
  });

  it("a folder that already existed is kept when the write fails", async () => {
    const cwd = project();
    mkdirSync(join(cwd, "app"), { recursive: true });
    const { fs } = spy((op, _path, n) => (op === "writeFile" && n === 2 ? denied(op) : undefined));
    await runWith(cwd, "app/resource/[slug]", fs);
    expect(tree(cwd)).toEqual(["app", "schema.json"]);
  });

  it("a folder that cannot be created leaves nothing", async () => {
    const cwd = project();
    const { fs } = spy((op) => (op === "mkdir" ? denied(op) : undefined));
    const { result } = await runWith(cwd, "app", fs);
    expect(String((result as Error).message)).toContain("Nothing was written");
    expect(tree(cwd)).toEqual(["schema.json"]);
  });

  it("with --force a failed write puts back the file it had replaced", async () => {
    const cwd = project();
    const folder = join(cwd, "app");
    mkdirSync(folder);
    writeFileSync(join(folder, "queries.ts"), "// mine\n");
    const { fs } = spy((op, _path, n) => (op === "writeFile" && n === 3 ? denied(op) : undefined));
    const { result } = await runWith(cwd, "app", fs, true);
    expect(String((result as Error).message)).toContain("Nothing was written");
    expect(readdirSync(folder)).toEqual(["queries.ts"]);
    expect(readFileSync(join(folder, "queries.ts"), "utf8")).toBe("// mine\n");
  });
});

describe("gaugeline query --page: promise test (reads only, writes only under --out)", () => {
  it("with recorded responses every request is a GET for counts, and none carries a write", async () => {
    const cwd = project();
    const r = await page([...PAGE, "--out", OUT], cwd);
    expect(r.code).toBe(EXIT.ok);
    expect(r.seen.length).toBeGreaterThan(0);
    expect(r.seen.every((s) => s.method === "GET")).toBe(true);
    for (const s of r.seen) {
      expect(new URL(s.url).pathname).toMatch(/\/data\/query\//);
      expect(s.query).toMatch(/^\{"total":count\(/);
      expect(s.query).not.toMatch(/mutate|createOrReplace|patch|delete/i);
    }
  });

  it("a file-system spy sees writes under --out and nowhere else, and the folder gains nothing else", async () => {
    const cwd = project();
    const { fs, calls } = spy();
    const { result } = await runWith(cwd, "app/resource/[slug]", fs);
    expect(result).toMatchObject({ kind: "ran" });
    const target = join(cwd, "app", "resource", "[slug]");
    const writes = calls.filter((c) => ["mkdir", "writeFile", "unlink", "rmdir"].includes(c.op));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (const w of writes) {
      const rel = relative(target, w.path);
      expect(
        rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`)),
        `${w.op} ${w.path}`,
      ).toBe(true);
    }
    expect(
      writes
        .filter((w) => w.op === "writeFile")
        .map((w) => relative(target, w.path))
        .sort(),
    ).toEqual([...NAMES].sort());
    expect(tree(cwd)).toEqual(
      [
        "app",
        join("app", "resource"),
        join("app", "resource", "[slug]"),
        ...NAMES.map((n) => join("app", "resource", "[slug]", n)),
        "schema.json",
      ].sort(),
    );
  });

  it("no document value reaches the output, the files or a request", async () => {
    const cwd = project();
    const r = await page([...PAGE, "--out", OUT], cwd);
    const written = NAMES.map((n) =>
      readFileSync(join(cwd, "app", "resource", "[slug]", n), "utf8"),
    );
    for (const text of [r.out, r.err, JSON.stringify(r.seen), ...written])
      expect(text.toLowerCase()).not.toContain(CONTENT_MARKER.toLowerCase());
  });

  it("nothing is created unless --page is given: --suggest and the plain run write no file", async () => {
    const cwd = project();
    const before = tree(cwd);
    await page([".", "--suggest", "--type", "resource"], cwd);
    await page(["."], cwd);
    expect(tree(cwd)).toEqual(before);
  });
});
