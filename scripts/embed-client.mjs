/**
 * Copy the built client (packages/app/dist) into the CLI package (packages/cli/dist/client) and write
 * client-manifest.json next to it: [{ path, type, bytes, gzipBytes, sha256 }], sorted by path.
 * Fails (exit 1) when the client is over its size budget.
 *
 *   node scripts/embed-client.mjs                 embed, then check the budget
 *   node scripts/embed-client.mjs --check         check what is already embedded: every file against
 *                                                 the manifest, and the budget. Writes nothing.
 *   --app <dir> and --out <dir> change the two folders (the tests use them).
 *   --demo <file> is the example results `gaugeline open --demo` starts with. They are copied to
 *   <out>/demo/results.json and listed in the manifest, so they are hashed, verified at start and
 *   counted in the budget like every other file. Default packages/app-server/demo/results.json.
 *
 * It runs after every package has been built: the CLI's tsup build empties dist/, so the client is
 * copied in last. The root `pnpm build` does that.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The whole client, gzipped, at most 300 KB; no single file over 200 KB gzipped. Proposed in G21c. */
export const TOTAL_GZIP_BUDGET = 300 * 1024;
export const FILE_GZIP_BUDGET = 200 * 1024;
export const MANIFEST_FILE = "client-manifest.json";
/** The example results: made by scripts/build-demo.ts, checked in, copied into the client folder. */
export const DEMO_SOURCE = join(root, "packages/app-server/demo/results.json");
export const DEMO_TARGET = "demo/results.json";

/** The same table as packages/app-server/src/static.ts (a test keeps them equal), minus its charset. */
const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function contentType(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 || path.lastIndexOf("/") > dot ? "" : path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : "application/octet-stream";
}

/** Every file under a folder, as "/"-separated paths relative to it, sorted. */
export function listFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) return listFiles(dir, rel);
      if (e.isFile()) return [rel];
      throw new Error(`${rel} is not a plain file or folder`);
    })
    .sort();
}

/** One manifest entry for a path and its bytes. gzip level 9, so the same bytes always measure the same. */
export function entryFor(path, body) {
  return {
    path,
    type: contentType(path),
    bytes: body.length,
    gzipBytes: gzipSync(body, { level: 9 }).length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

/** The manifest for every file under `dir` (the manifest file itself excluded). */
export function buildManifest(dir) {
  return listFiles(dir)
    .filter((p) => p !== MANIFEST_FILE)
    .map((p) => entryFor(p, readFileSync(join(dir, p))));
}

/**
 * The budget: total gzipped bytes at or under `total`, and each file at or under `file`. `largest`
 * is the three biggest files by gzipped size, for the report. A source map is a problem too: the
 * published build has none.
 */
export function checkBudget(entries, { total = TOTAL_GZIP_BUDGET, file = FILE_GZIP_BUDGET } = {}) {
  const sum = entries.reduce((n, e) => n + e.gzipBytes, 0);
  const largest = [...entries].sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 3);
  const problems = [];
  if (sum > total)
    problems.push(`the client is ${sum} bytes gzipped, over the ${total}-byte budget`);
  for (const e of entries)
    if (e.gzipBytes > file)
      problems.push(
        `${e.path} is ${e.gzipBytes} bytes gzipped, over the ${file}-byte limit for one file`,
      );
  for (const e of entries)
    if (e.path.endsWith(".map"))
      problems.push(`${e.path} is a source map: the published build has none`);
  return { ok: problems.length === 0, total: sum, largest, problems };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** The size report: every file, largest first, then the total against the budget. */
export function report(entries, budget = checkBudget(entries)) {
  const rows = [...entries].sort((a, b) => b.gzipBytes - a.gzipBytes);
  const width = Math.max(4, ...rows.map((e) => e.path.length));
  const lines = [
    `${"file".padEnd(width)}  ${"bytes".padStart(8)}  ${"gzip".padStart(8)}`,
    ...rows.map(
      (e) =>
        `${e.path.padEnd(width)}  ${String(e.bytes).padStart(8)}  ${String(e.gzipBytes).padStart(8)}`,
    ),
    `total gzip ${kb(budget.total)} of ${kb(TOTAL_GZIP_BUDGET)} (no single file over ${kb(FILE_GZIP_BUDGET)})`,
  ];
  if (!budget.ok) {
    lines.push(...budget.problems.map((p) => `over budget: ${p}`));
    lines.push("the three largest files:");
    lines.push(...budget.largest.map((e) => `  ${e.path}  ${kb(e.gzipBytes)} gzipped`));
  }
  return lines.join("\n");
}

/**
 * Copy `app` into `out`, write the manifest, and return its entries. `out` is replaced. `extra` is
 * more files for the same folder, as [{ from, to }]: the example results.
 */
export function embed(app, out, extra = []) {
  if (!existsSync(join(app, "index.html")))
    throw new Error(`${app} has no index.html: run the app's build first (pnpm build)`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const entries = [];
  for (const path of listFiles(app)) {
    const body = readFileSync(join(app, path));
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), body);
    entries.push(entryFor(path, body));
  }
  for (const { from, to } of extra) {
    const body = readFileSync(from);
    mkdirSync(dirname(join(out, to)), { recursive: true });
    writeFileSync(join(out, to), body);
    entries.push(entryFor(to, body));
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeFileSync(join(out, MANIFEST_FILE), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

/** Read an embedded folder back: its manifest, and the problems found comparing it with the files. */
export function verify(dir) {
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file))
    return { entries: [], problems: [`${file} does not exist: run pnpm build`] };
  const entries = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  const actual = buildManifest(dir);
  const listed = new Map(entries.map((e) => [e.path, e]));
  for (const a of actual) {
    const e = listed.get(a.path);
    if (!e) problems.push(`${a.path} is in the folder but not in the manifest`);
    else if (e.sha256 !== a.sha256 || e.bytes !== a.bytes)
      problems.push(`${a.path} differs from the manifest`);
  }
  for (const e of entries)
    if (!actual.some((a) => a.path === e.path))
      problems.push(`${e.path} is in the manifest but not in the folder`);
  return { entries, problems };
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const app = resolve(flag("--app") ?? join(root, "packages/app/dist"));
  const out = resolve(flag("--out") ?? join(root, "packages/cli/dist/client"));
  const demo = resolve(flag("--demo") ?? DEMO_SOURCE);
  let entries;
  if (argv.includes("--check")) {
    const checked = verify(out);
    if (checked.problems.length > 0) {
      process.stderr.write(`embed-client: ${checked.problems.join("\nembed-client: ")}\n`);
      return 1;
    }
    entries = checked.entries;
  } else {
    try {
      entries = embed(app, out, [{ from: demo, to: DEMO_TARGET }]);
    } catch (err) {
      process.stderr.write(`embed-client: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  const budget = checkBudget(entries);
  (budget.ok ? process.stdout : process.stderr).write(`${report(entries, budget)}\n`);
  return budget.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
