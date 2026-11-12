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

/** One run as the comparison sees it. */
export interface RunSide {
  findings: { checkId: string; fingerprint: string }[];
  /** Checks that did not produce an answer in this run (they threw, or could not check): their findings say nothing. */
  notRun: Iterable<string>;
}

/**
 * The difference between two runs of the same kind, counting only checks that ran in both. A finding of a
 * check that did not run tonight is not "closed" (nobody fixed anything; the check crashed), and a finding
 * of a check that did not run last time is not "opened" (it may have been there all along).
 */
export function diffRuns(previous: RunSide, current: RunSide): FingerprintDiff {
  const missedBefore = new Set(previous.notRun);
  const missedNow = new Set(current.notRun);
  const d = diffFingerprints(
    previous.findings.map((f) => f.fingerprint),
    current.findings.map((f) => f.fingerprint),
  );
  const checkOf = new Map<string, string>();
  for (const f of [...previous.findings, ...current.findings])
    checkOf.set(f.fingerprint, f.checkId);
  return {
    opened: d.opened.filter((fp) => !missedBefore.has(checkOf.get(fp)!)),
    stillOpen: d.stillOpen,
    closed: d.closed.filter((fp) => !missedNow.has(checkOf.get(fp)!)),
  };
}
