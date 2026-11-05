/**
 * Refuse to publish when the pushed tag and the package version disagree.
 *   pnpm exec tsx scripts/check-tag-version.ts v0.0.2
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function checkTagVersion(
  tag: string,
  version: string,
): { ok: true } | { ok: false; message: string } {
  const fromTag = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
  return fromTag === version
    ? { ok: true }
    : {
        ok: false,
        message: `Tag ${tag} says ${fromTag} but packages/cli/package.json says ${version}. Not publishing.`,
      };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const tag = process.argv[2] ?? "";
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../packages/cli/package.json", import.meta.url)), "utf8"),
  ) as { version: string };
  const result = checkTagVersion(tag, pkg.version);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Tag ${tag} matches gaugeline ${pkg.version}.\n`);
  }
}
