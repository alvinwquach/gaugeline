/**
 * "Since vX" for every check. Released checks get their version from docs/check-since.lock.json, which
 * only the release tooling writes (`pnpm version` runs `check-since.ts --release`). A check that no
 * release has stamped yet shows the NEXT version: the current package version moved by the largest
 * pending changeset. Nothing about the unreleased case is committed, so a new changeset never makes a
 * generated file stale.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangeset, type Bump } from "./gate.js";

/** check id -> the version that first shipped it. */
export type SinceLock = Record<string, string>;

const VERSION = /^\d+\.\d+\.\d+$/;
const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export function isVersion(v: string): boolean {
  return VERSION.test(v);
}

export function largestBump(bumps: readonly Bump[]): Bump {
  return bumps.reduce<Bump>((a, b) => (RANK[b] > RANK[a] ? b : a), "none");
}

/** The version Changesets would write for this bump. Nothing pending still means the next patch. */
export function nextVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = current
    .split(".")
    .map((x) => Number.parseInt(x, 10) || 0);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export interface SinceInfo {
  id: string;
  version: string;
  /** False when `version` is the next version, not yet assigned by a release. */
  released: boolean;
}

export function sinceFor(id: string, lock: SinceLock, next: string): SinceInfo {
  const own = lock[id];
  return own === undefined
    ? { id, version: next, released: false }
    : { id, version: own, released: true };
}

function sorted(lock: SinceLock): SinceLock {
  return Object.fromEntries(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Give every id with no entry the release version. An entry that exists is never touched. */
export function stampRelease(
  lock: SinceLock,
  ids: readonly string[],
  version: string,
): { lock: SinceLock; added: string[] } {
  const added = [...new Set(ids)].filter((id) => lock[id] === undefined).sort();
  return {
    lock: sorted({ ...lock, ...Object.fromEntries(added.map((id) => [id, version])) }),
    added,
  };
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export interface SinceCheckInput {
  lock: SinceLock;
  /** Ids in the registry now. */
  registered: readonly string[];
  /** Ids in docs/check-ids.lock.json: everything that has ever been registered. */
  everShipped: readonly string[];
  packageVersion: string;
  /** Versions the changelog lists. Skipped when empty. */
  knownVersions: readonly string[];
  /** The lock as the base branch has it: none of its entries may change or go. */
  base?: SinceLock;
}

export function checkSince(input: SinceCheckInput): string[] {
  const problems: string[] = [];
  const ever = new Set(input.everShipped);
  const known = new Set(input.knownVersions);
  for (const [id, version] of Object.entries(input.lock)) {
    if (!ever.has(id)) problems.push(`The since lock has "${id}", which was never a check id.`);
    if (!isVersion(version)) {
      problems.push(`Check "${id}" says ${version}, which is not a version like 1.2.3.`);
    } else {
      if (compare(version, input.packageVersion) > 0)
        problems.push(
          `Check "${id}" says ${version}, which is ahead of the package (${input.packageVersion}): only a release stamps a version.`,
        );
      if (known.size > 0 && !known.has(version))
        problems.push(`Check "${id}" says ${version}, which the changelog does not list.`);
    }
  }
  for (const id of input.registered)
    if (!ever.has(id)) problems.push(`"${id}" is registered but missing from check-ids.lock.json.`);
  for (const [id, was] of Object.entries(input.base ?? {})) {
    const now = input.lock[id];
    if (now === undefined)
      problems.push(`Check "${id}" was ${was} and was removed: a released Since never goes.`);
    else if (now !== was)
      problems.push(`Check "${id}" was ${was} and is now ${now}: a released Since never changes.`);
  }
  return problems;
}

export interface SinceContext {
  lock: SinceLock;
  /** The package version now. */
  current: string;
  bump: Bump;
  /** The version the pending changesets will make. */
  next: string;
}

export function readPendingBumps(root: string): Bump[] {
  const dir = join(root, ".changeset");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => parseChangeset(readFileSync(join(dir, f), "utf8")).bump);
}

export function readLock(root: string): SinceLock {
  const path = join(root, "docs/check-since.lock.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SinceLock) : {};
}

export function loadSinceContext(root: string): SinceContext {
  const pkg = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")) as {
    version: string;
  };
  const bump = largestBump(readPendingBumps(root));
  return { lock: readLock(root), current: pkg.version, bump, next: nextVersion(pkg.version, bump) };
}
