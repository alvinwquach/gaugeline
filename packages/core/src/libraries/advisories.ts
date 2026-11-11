import list from "../data/library-advisories.json";
import { compareVersions, parseVersion } from "./version.js";

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

/** The day the list was written, so a stale list can be told from a current one. */
export const LIBRARY_ADVISORIES_WRITTEN: string = list.written;

/** An advisory that names a version, and the version that fixes it on that line. */
export interface AdvisoryMatch {
  advisory: Advisory;
  fixedIn: string | null;
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
    const range = advisory.affects.find((r) => {
      const atLeast = r.introduced === undefined ? 0 : compareVersions(version, r.introduced);
      const below = r.fixed === null ? -1 : compareVersions(version, r.fixed);
      return atLeast !== undefined && below !== undefined && atLeast >= 0 && below < 0;
    });
    if (range) out.push({ advisory, fixedIn: range.fixed });
  }
  return out;
}
