/**
 * Compare the public surface (packages/core/src/public-surface.ts) with public-surface.lock.json
 * and the pending changesets, under the rules in STABILITY.md.
 *   pnpm surface                  apply the rules; when they pass, update the lock file
 *   pnpm surface --check          CI: apply the rules and fail if the lock file is out of date
 *   ... --base <git-ref>          compare against the lock file at that ref (a pull request's base)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPRECATED, publicSurface, type PublicSurface } from "../packages/core/src/index.js";
import { FLAGS } from "../packages/cli/src/flags.js";
import { parseChangeset } from "./lib/gate.js";
import { bumpBetween, checkSurface, type Bump } from "./lib/surface.js";

const root = process.env.SURFACE_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const lockPath = `${root}/public-surface.lock.json`;
const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const base = baseAt >= 0 ? args[baseAt + 1] : undefined;

/** Flags by command; flags for every command ("*") are listed under each named command. */
export function flagsByCommand(): Record<string, string[]> {
  const commands = [
    ...new Set(["check", ...FLAGS.flatMap((f) => f.commands.filter((c) => c !== "*"))]),
  ];
  return Object.fromEntries(
    commands.map((c) => [
      c,
      FLAGS.filter((f) => f.commands.includes("*") || f.commands.includes(c)).map((f) => f.name),
    ]),
  );
}

const surface: PublicSurface = process.env.SURFACE_OVERRIDE
  ? (JSON.parse(readFileSync(process.env.SURFACE_OVERRIDE, "utf8")) as PublicSurface)
  : publicSurface({
      flags: flagsByCommand(),
      envVars: FLAGS.flatMap((f) => (f.env ? [f.env] : [])),
    });
const text = `${JSON.stringify(surface, null, 2)}\n`;
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
let before: PublicSurface = surface;
let baseVersion: string | undefined;
try {
  before = JSON.parse(
    base ? git("show", `${base}:public-surface.lock.json`) : readFileSync(lockPath, "utf8"),
  ) as PublicSurface;
  baseVersion = base
    ? (JSON.parse(git("show", `${base}:packages/cli/package.json`)) as { version: string }).version
    : undefined;
} catch {
  if (existsSync(lockPath)) before = JSON.parse(readFileSync(lockPath, "utf8")) as PublicSurface;
}
const version = (
  JSON.parse(readFileSync(`${root}/packages/cli/package.json`, "utf8")) as { version: string }
).version;
const changesets = existsSync(`${root}/.changeset`)
  ? readdirSync(`${root}/.changeset`)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => parseChangeset(readFileSync(`${root}/.changeset/${f}`, "utf8")))
  : [];
const order: Bump[] = ["none", "patch", "minor", "major"];
const bump: Bump =
  changesets.length > 0
    ? changesets.reduce<Bump>(
        (m, c) => (order.indexOf(c.bump) > order.indexOf(m) ? c.bump : m),
        "none",
      )
    : bumpBetween(baseVersion ?? version, version);
const result = checkSurface({
  before,
  after: surface,
  bump,
  summaries: changesets.map((c) => c.summary),
  version,
  deprecated: DEPRECATED,
});
for (const n of result.notes) process.stdout.write(`surface: ${n}\n`);
for (const p of result.problems) process.stderr.write(`surface: ${p}\n`);
if (!result.ok) process.exitCode = 1;
else if (args.includes("--check")) {
  const committed = existsSync(lockPath)
    ? readFileSync(lockPath, "utf8").replace(/\r\n/g, "\n")
    : "";
  if (committed !== text) {
    process.stderr.write(
      "surface: public-surface.lock.json is out of date. Run pnpm surface and commit it.\n",
    );
    process.exitCode = 1;
  } else process.stdout.write("surface: ok\n");
} else {
  writeFileSync(lockPath, text);
  process.stdout.write("surface: ok, public-surface.lock.json updated\n");
}
