/**
 * The walking skeleton: while the version is 0.0.x the CLI runs only these checks, so the first
 * published package proves install, npx and provenance with one check. Delete this file in the
 * branch that releases 0.1.0.
 */
export const SKELETON_CHECKS: readonly string[] = Object.freeze(["canonical-elsewhere"]);

/** The `only` list for a version: SKELETON_CHECKS for 0.0.x, nothing (all checks) otherwise. */
export function skeletonOnly(version: string): readonly string[] | undefined {
  return /^0\.0\.\d+(?:[-+].*)?$/.test(version) ? SKELETON_CHECKS : undefined;
}
