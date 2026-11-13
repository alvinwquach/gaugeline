import list from "../data/library-advisories.json";
import { compareVersions, coreOf, parseVersion } from "./version.js";

/** The npm packages whose installed version the source checks read: the ids of the `packages` list in the data file. */
export type PackageId = "zod" | "next";

/** The libraries Gaugeline recognises: the ids data/library-advisories.json is keyed by. */
export type LibraryId = "jquery" | "jquery-ui" | "lodash" | "moment" | "bootstrap" | "angularjs";

/** One stretch of versions an advisory affects: from `introduced` (default: the first) up to, not including, `fixed`. */
export interface AffectedRange {
  introduced?: string;
  /** The first version that is not affected; null when no fixed version is listed. */
  fixed: string | null;
}

/** One published advisory, from data/library-advisories.json. */
export interface Advisory {
  /** A CVE or GHSA id. */
  id: string;
  /** What it is, in under 80 characters, as a fact and not a verdict. */
  summary: string;
  affects: AffectedRange[];
  /** The page that publishes it. */
  source: string;
  /** False until someone has compared the entry with its source. */
  verified: boolean;
  /**
   * Versions the advisory's published range reaches that Gaugeline has not confirmed, or that have no fixed
   * release (packages only). A version in one is reported as not sure, never as a finding.
   */
  unconfirmed?: AffectedRange[];
  /** Why those versions are not confirmed, in Gaugeline's words. */
  unconfirmedWhy?: string;
}

interface Entry {
  id: LibraryId;
  name: string;
  advisories: Advisory[];
}

const entries = list.libraries as Entry[];

export const LIBRARY_ADVISORIES: Readonly<Record<LibraryId, readonly Advisory[]>> = Object.freeze(
  Object.fromEntries(entries.map((e) => [e.id, Object.freeze(e.advisories)])) as Record<
    LibraryId,
    readonly Advisory[]
  >,
);

/** How each library is named in a finding. */
export const LIBRARY_NAMES: Readonly<Record<LibraryId, string>> = Object.freeze(
  Object.fromEntries(entries.map((e) => [e.id, e.name])) as Record<LibraryId, string>,
);

interface PackageEntry {
  id: PackageId;
  name: string;
  /** The day the entry was compared with its advisory pages and the registry. */
  lastChecked: string;
  advisories: Advisory[];
}

const packageEntries = list.packages as PackageEntry[];

/** The advisories for the npm packages the source checks read from a lockfile, by package. */
export const PACKAGE_ADVISORIES: Readonly<Record<PackageId, readonly Advisory[]>> = Object.freeze(
  Object.fromEntries(packageEntries.map((e) => [e.id, Object.freeze(e.advisories)])) as Record<
    PackageId,
    readonly Advisory[]
  >,
);

/** How each package is named in a finding, and the day its advisories were last compared with their pages. */
export const PACKAGE_INFO: Readonly<Record<PackageId, { name: string; lastChecked: string }>> =
  Object.freeze(
    Object.fromEntries(
      packageEntries.map((e) => [e.id, { name: e.name, lastChecked: e.lastChecked }]),
    ) as Record<PackageId, { name: string; lastChecked: string }>,
  );

/** The day the list was written, so a stale list can be told from a current one. */
export const LIBRARY_ADVISORIES_WRITTEN: string = list.written;

/** An advisory that names a version, and the version that fixes it on that line. */
export interface AdvisoryMatch {
  advisory: Advisory;
  fixedIn: string | null;
}

/**
 * True when `version` is in the stretch `range` names: from `introduced` (default: the first version) up to, not
 * including, `fixed`. A pre-release of the first affected version is on that line (4.0.0-beta.3 is a 4.0.0), so it is
 * compared without its tag; against the fixed version it stays before the fix (3.5.0-beta1 is not 3.5.0). A version
 * that is not a version is in no range.
 */
export function inRange(version: string, range: AffectedRange): boolean {
  const atLeast =
    range.introduced === undefined
      ? 0
      : compareVersions(coreOf(version) ?? version, range.introduced);
  const below = range.fixed === null ? -1 : compareVersions(version, range.fixed);
  return atLeast !== undefined && below !== undefined && atLeast >= 0 && below < 0;
}

/**
 * The advisories whose affected versions include `version`, in the list's order. Each carries the fix of the
 * range the version is in (Bootstrap 3 and 4 are fixed in different versions). A version that is not a version
 * matches nothing. `advisories` is the list to read, for tests.
 */
export function advisoriesFor(
  library: LibraryId,
  version: string,
  advisories: readonly Advisory[] = LIBRARY_ADVISORIES[library],
): AdvisoryMatch[] {
  const out: AdvisoryMatch[] = [];
  if (parseVersion(version) === undefined) return out;
  for (const advisory of advisories) {
    const range = advisory.affects.find((r) => inRange(version, r));
    if (range) out.push({ advisory, fixedIn: range.fixed });
  }
  return out;
}
