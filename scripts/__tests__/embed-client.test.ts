import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { contentTypeFor } from "@gaugeline/app-server";
import {
  buildManifest,
  checkBudget,
  contentType,
  DEMO_SOURCE,
  embed,
  entryFor,
  FILE_GZIP_BUDGET,
  TOTAL_GZIP_BUDGET,
  verify,
  type ManifestEntry,
} from "../embed-client.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "scripts/embed-client.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-embed-"));
  dirs.push(d);
  return d;
};

/** A small invented app build: index.html, a hashed script and a hashed stylesheet. */
function fakeApp(extra: Record<string, Buffer | string> = {}) {
  const dir = scratch();
  const files: Record<string, Buffer | string> = {
    "index.html":
      '<!doctype html><script type="module" src="./assets/index-AbCdEfGh.js"></script>\n',
    "assets/index-AbCdEfGh.js": "console.log('invented');\n",
    "assets/style-12345678.css": "body{margin:0}\n",
    ...extra,
  };
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const entry = (path: string, gzipBytes: number): ManifestEntry => ({
  path,
  type: "x",
  bytes: gzipBytes,
  gzipBytes,
  sha256: "0".repeat(64),
});

describe("embed-client: unit", () => {
  it("the size budget: under, exactly at, over in total, and one file over", () => {
    expect(TOTAL_GZIP_BUDGET).toBe(300 * 1024);
    expect(FILE_GZIP_BUDGET).toBe(200 * 1024);
    const half = TOTAL_GZIP_BUDGET / 2;
    expect(checkBudget([entry("a.js", 1000), entry("b.css", 500)]).ok).toBe(true);
    const exactly = checkBudget([entry("a.js", half), entry("b.js", half)]);
    expect([exactly.ok, exactly.total]).toEqual([true, TOTAL_GZIP_BUDGET]);
    const total = checkBudget([entry("a.js", half), entry("b.js", half), entry("c.css", 1)]);
    expect(total.ok).toBe(false);
    expect(total.problems).toEqual([
      expect.stringContaining(`${TOTAL_GZIP_BUDGET + 1} bytes gzipped`),
    ]);
    const one = checkBudget([entry("big.js", FILE_GZIP_BUDGET + 1)]);
    expect(one.ok).toBe(false);
    expect(one.problems).toEqual([expect.stringContaining("big.js is 204801 bytes gzipped")]);
    // Exactly at the per-file limit is fine.
    expect(checkBudget([entry("big.js", FILE_GZIP_BUDGET)]).ok).toBe(true);
  });

  it("the three largest files come back largest first", () => {
    const b = checkBudget([entry("d", 4), entry("a", 1), entry("c", 3), entry("b", 2)], {
      total: 5,
    });
    expect(b.largest.map((e) => e.path)).toEqual(["d", "c", "b"]);
  });

  it("a source map is a problem even when it is small", () => {
    const b = checkBudget([entry("assets/index-AbCdEfGh.js.map", 10)]);
    expect(b.ok).toBe(false);
    expect(b.problems[0]).toContain("source map");
  });

  it("the manifest: path, type, bytes, gzipBytes, sha256, sorted by path, and the hash is of the bytes", () => {
    const app = fakeApp();
    const manifest = buildManifest(app);
    expect(manifest.map((e) => e.path)).toEqual([
      "assets/index-AbCdEfGh.js",
      "assets/style-12345678.css",
      "index.html",
    ]);
    expect(Object.keys(manifest[0] ?? {})).toEqual([
      "path",
      "type",
      "bytes",
      "gzipBytes",
      "sha256",
    ]);
    const js = manifest[0];
    const body = readFileSync(join(app, "assets/index-AbCdEfGh.js"));
    expect(js).toMatchObject({
      type: "text/javascript; charset=utf-8",
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    expect(js?.gzipBytes).toBeGreaterThan(0);
  });

  it("the content-type table is the server's, extension for extension", () => {
    for (const name of [
      "a.html",
      "a.js",
      "a.mjs",
      "a.css",
      "a.json",
      "a.svg",
      "a.png",
      "a.ico",
      "a.txt",
      "a.woff",
      "a.woff2",
      "a.JS",
      "a.bin",
      "a.map",
      "noext",
      "dir.d/noext",
    ])
      expect(contentType(name), name).toBe(contentTypeFor(name));
  });
});

describe("embed-client: integration (the script)", () => {
  it("copies the build, writes the manifest, prints the report and exits 0; --check then passes", () => {
    const app = fakeApp();
    const out = join(scratch(), "client");
    const first = run(["--app", app, "--out", out]);
    expect(first.status).toBe(0);
    expect(first.out).toContain("total gzip");
    expect(verify(out).problems).toEqual([]);
    // The client's files, and the example results beside them, in path order.
    const demo = readFileSync(DEMO_SOURCE);
    expect(JSON.parse(readFileSync(join(out, "client-manifest.json"), "utf8"))).toEqual(
      [...buildManifest(app), entryFor("demo/results.json", demo)].sort((a, b) =>
        a.path < b.path ? -1 : 1,
      ),
    );
    expect(readFileSync(join(out, "demo/results.json")).equals(demo)).toBe(true);
    expect(run(["--check", "--out", out]).status).toBe(0);
  });

  it("the example results are copied from --demo, listed in the manifest and counted in the budget", () => {
    const dir = scratch();
    const file = join(dir, "results.json");
    // Random bytes do not compress: over the 200 KB limit for one file on their own.
    writeFileSync(file, randomBytes(201 * 1024).toString("base64"));
    const r = run(["--app", fakeApp(), "--out", join(scratch(), "client"), "--demo", file]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/demo\/results\.json is \d+ bytes gzipped, over the 204800-byte limit/);
    const small = join(dir, "small.json");
    writeFileSync(small, '{"demo":1}\n');
    const out = join(scratch(), "client");
    expect(run(["--app", fakeApp(), "--out", out, "--demo", small]).status).toBe(0);
    expect(readFileSync(join(out, "demo/results.json"), "utf8")).toBe('{"demo":1}\n');
    expect(verify(out).entries.map((e) => e.path)).toContain("demo/results.json");
  });

  it("an old embedded folder is replaced, not merged", () => {
    const out = join(scratch(), "client");
    embed(fakeApp({ "assets/old-87654321.js": "old" }), out);
    embed(fakeApp(), out);
    expect(buildManifest(out).map((e) => e.path)).not.toContain("assets/old-87654321.js");
  });

  it("over budget: exit 1 and the three largest files are printed", () => {
    // Random bytes do not compress: 4 files of 90 KB make 360 KB gzipped.
    const big = Object.fromEntries(
      [1, 2, 3, 4].map((i) => [`assets/chunk${i}-1234567${i}.js`, randomBytes(90 * 1024)]),
    );
    const r = run(["--app", fakeApp(big), "--out", join(scratch(), "client")]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("over budget");
    expect(r.err).toContain("the three largest files:");
    expect(r.err.split("\n").filter((l) => /^ {2}assets\/chunk/.test(l))).toHaveLength(3);
  });

  it("one file over 200 KB gzipped: exit 1, naming it", () => {
    const r = run([
      "--app",
      fakeApp({ "assets/huge-12345678.js": randomBytes(201 * 1024) }),
      "--out",
      join(scratch(), "client"),
    ]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(
      /assets\/huge-12345678\.js is \d+ bytes gzipped, over the 204800-byte limit/,
    );
  });

  it("a source map in the build: exit 1", () => {
    const r = run([
      "--app",
      fakeApp({ "assets/index-AbCdEfGh.js.map": "{}" }),
      "--out",
      join(scratch(), "client"),
    ]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("source map");
  });

  it("no app build: exit 1 saying so; --check on a folder that is not there: exit 1", () => {
    const empty = scratch();
    const r = run(["--app", empty, "--out", join(scratch(), "client")]);
    expect([r.status, r.err]).toEqual([1, expect.stringContaining("has no index.html")]);
    const c = run(["--check", "--out", join(scratch(), "nothing")]);
    expect([c.status, c.err]).toEqual([1, expect.stringContaining("does not exist")]);
  });

  it("--check catches a changed file, an extra file and a missing file", () => {
    const out = join(scratch(), "client");
    embed(fakeApp(), out);
    writeFileSync(join(out, "assets/index-AbCdEfGh.js"), "changed");
    expect(run(["--check", "--out", out]).err).toContain("assets/index-AbCdEfGh.js differs");
    writeFileSync(join(out, "extra.js"), "x");
    expect(run(["--check", "--out", out]).err).toContain(
      "extra.js is in the folder but not in the manifest",
    );
    rmSync(join(out, "assets/style-12345678.css"));
    const r = run(["--check", "--out", out]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("assets/style-12345678.css is in the manifest but not in the folder");
  });
});

describe("embed-client: two builds from the same commit", () => {
  it("produce the same file names and the same hashes", () => {
    const build = () => {
      const dist = scratch();
      execFileSync(
        "pnpm",
        ["--filter", "@gaugeline/app", "exec", "vite", "build", "--outDir", dist, "--emptyOutDir"],
        { cwd: root, stdio: "pipe", shell: process.platform === "win32" },
      );
      return buildManifest(dist);
    };
    const first = build();
    const second = build();
    expect(first.map((e) => e.path)).toEqual(second.map((e) => e.path));
    expect(first).toEqual(second);
    expect(first.some((e) => /^assets\/.+-[A-Za-z0-9_-]{8}\.js$/.test(e.path))).toBe(true);
    expect(first.some((e) => /^assets\/.+-[A-Za-z0-9_-]{8}\.css$/.test(e.path))).toBe(true);
    expect(first.some((e) => e.path.endsWith(".map"))).toBe(false);
  }, 60_000);
});
