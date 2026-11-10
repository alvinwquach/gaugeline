/**
 * The "Since vX" lock for the checks reference.
 *   pnpm since                      check docs/check-since.lock.json against the registry and the changelog
 *   pnpm since --base <ref>         also fail when a released entry differs from the same file at <ref>
 *   pnpm since --release            stamp every check without an entry with the package version
 *                                   (`pnpm version` runs this after `changeset version`)
 *   --root <dir>                    another repository layout (tests)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE_IDS } from "./lib/catalogue-ids.js";
import { checkSince, loadSinceContext, stampRelease, type SinceLock } from "./lib/check-since.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(flag("--root") ?? fileURLToPath(new URL("../", import.meta.url)));
const lockPath = join(root, "docs/check-since.lock.json");
const ctx = loadSinceContext(root);

if (args.includes("--release")) {
  // Run by `pnpm version`, after Changesets has written the new package version.
  const { lock, added } = stampRelease(ctx.lock, CATALOGUE_IDS(), ctx.current);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  process.stdout.write(`since: ${added.length} checks first shipped in ${ctx.current}\n`);
} else {
  const readJson = <T>(path: string, fallback: T): T =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  let base: SinceLock | undefined;
  const ref = flag("--base");
  if (ref !== undefined) {
    try {
      base = JSON.parse(
        execFileSync("git", ["show", `${ref}:docs/check-since.lock.json`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ) as SinceLock;
    } catch {
      process.stdout.write(
        `since: ${ref} has no docs/check-since.lock.json yet; nothing to compare.\n`,
      );
    }
  }
  const problems = checkSince({
    lock: ctx.lock,
    registered: CATALOGUE_IDS(),
    everShipped: readJson<string[]>(join(root, "docs/check-ids.lock.json"), []),
    packageVersion: ctx.current,
    knownVersions: readJson<{ version: string }[]>(join(root, "docs/changelog.data.json"), []).map(
      (e) => e.version,
    ),
    ...(base ? { base } : {}),
  });
  for (const p of problems) process.stderr.write(`since: ${p}\n`);
  if (problems.length > 0) process.exitCode = 1;
  else
    process.stdout.write(
      `since: ${Object.keys(ctx.lock).length} released checks; the rest show ${ctx.next}.\n`,
    );
}
