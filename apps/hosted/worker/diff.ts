/**
 * What changed between two runs of one site. A finding's identity across nights is core's fingerprint()
 * (stored on every findings row), so the change is a Set difference in each direction.
 */
export interface FingerprintDiff {
  /** In this run and not the previous one. */
  opened: string[];
  /** In both. */
  stillOpen: string[];
  /** In the previous run and not this one. */
  closed: string[];
}

export function diffFingerprints(
  previous: Iterable<string>,
  current: Iterable<string>,
): FingerprintDiff {
  const before = new Set(previous);
  const now = new Set(current);
  const sorted = (xs: Iterable<string>) => [...xs].sort();
  return {
    opened: sorted([...now].filter((f) => !before.has(f))),
    stillOpen: sorted([...now].filter((f) => before.has(f))),
    closed: sorted([...before].filter((f) => !now.has(f))),
  };
}
