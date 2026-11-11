import type { Finding, Severity } from "../model.js";
import { readWrittenDate, writeDate } from "./dates.js";

/** The checks whose findings make up the Renewals section, in the report and the digest. */
export const RENEWAL_CHECK_IDS: ReadonlySet<string> = new Set([
  "domain-expires-soon",
  "domain-expired",
  "domain-status-hold",
  "certificate-expiring",
  "cert-name-mismatch",
  "token-expires-soon",
  "runtime-deprecated",
]);

export interface RenewalItem {
  checkId: string;
  severity: Severity;
  title: string;
  evidence: string;
  url: string;
  /** The day it lapses, YYYY-MM-DD. Absent for a finding with no date (a hold, a name the certificate lacks). */
  date?: string;
}

/**
 * The day a renewal finding is about, read from its evidence: "3 Dec 2026" as the renewals checks
 * write it, or "2026-12-03" as the certificate check does. Undefined when there is none.
 */
export function renewalDate(evidence: string): string | undefined {
  const written = readWrittenDate(evidence);
  if (written) return written;
  const m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(evidence);
  return m && !Number.isNaN(Date.parse(m[1] ?? "")) ? m[1] : undefined;
}

/**
 * The renewal findings, soonest first: the ones already broken (no date) lead, then by date, then by
 * severity and check id so the same findings always list the same way.
 */
export function renewalItems(
  findings: readonly Pick<Finding, "checkId" | "severity" | "title" | "evidence" | "url">[],
): RenewalItem[] {
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return findings
    .filter((f) => RENEWAL_CHECK_IDS.has(f.checkId))
    .map((f): RenewalItem => {
      const date = renewalDate(f.evidence);
      return { ...f, ...(date ? { date } : {}) };
    })
    .sort(
      (a, b) =>
        (a.date === undefined ? 0 : 1) - (b.date === undefined ? 0 : 1) ||
        (a.date ?? "").localeCompare(b.date ?? "") ||
        rank[a.severity] - rank[b.severity] ||
        a.checkId.localeCompare(b.checkId) ||
        a.evidence.localeCompare(b.evidence),
    );
}

/** "3 Dec 2026: Domain marlowe-bar.example expires 3 Dec 2026, 24 days" is long; this is the evidence, led by the date when it has one. */
export function renewalLine(item: RenewalItem): string {
  return item.date ? `${writeDate(`${item.date}T00:00:00Z`)}: ${item.evidence}` : item.evidence;
}
