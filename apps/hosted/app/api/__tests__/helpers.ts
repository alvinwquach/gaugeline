/** Invented uploads for the runs API tests (rule 12): two small client sites and a long list of findings. */

export interface UploadFinding {
  checkId: string;
  severity: "high" | "medium" | "low";
  title: string;
  evidence: string;
  url: string;
}

export function finding(n = 1, over: Partial<UploadFinding> = {}): UploadFinding {
  return {
    checkId: "broken-links",
    severity: "high",
    title: "Broken link on the menu page",
    evidence: `/menu links to /drinks-${n} (404)`,
    url: "https://tidewater-bar.test/menu",
    ...over,
  };
}

/** What `gaugeline <address> --json` prints (schema 2), with the findings given. */
export function result(
  findings: UploadFinding[] = [finding()],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 2,
    url: "https://tidewater-bar.test/",
    startedAt: "2026-11-12T03:00:00.000Z",
    findings,
    passed: ["canonical-missing", "robots-blocks-site"],
    failed: ["broken-links"],
    couldNotCheck: [],
    sampled: { links: { seen: 40, taken: 30, limit: 30 } },
    ...over,
  };
}

/** Findings that differ from each other, so each gets its own fingerprint. */
export function manyFindings(count: number): UploadFinding[] {
  return Array.from({ length: count }, (_, i) =>
    finding(i, {
      checkId: `check-${i % 50}`,
      severity: (["high", "medium", "low"] as const)[i % 3]!,
      url: `https://tidewater-bar.test/page-${i}`,
      evidence: `link ${i} on the page goes to /gone-${i} and answers 404`,
    }),
  );
}
