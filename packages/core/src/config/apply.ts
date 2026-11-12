import type { Finding } from "../model.js";
import type { CheckMode, Suppression } from "./schema.js";

export interface SuppressionResult {
  /** Findings no active suppression covers. */
  kept: Finding[];
  /** What active suppressions muted, with the entry that did it. */
  suppressed: { finding: Finding; entry: Suppression }[];
  /** Entries past their date, reported whether or not the finding is still there. */
  expired: Suppression[];
}

/** The day, in UTC, of an injected clock: date logic never reads the real one. */
export function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

function sameAddress(entryUrl: string, findingUrl: string): boolean {
  if (entryUrl.startsWith("/")) return pathOf(findingUrl) === (entryUrl.replace(/\/+$/, "") || "/");
  try {
    return (
      new URL(entryUrl).href.replace(/\/+$/, "") === new URL(findingUrl).href.replace(/\/+$/, "")
    );
  } catch {
    return entryUrl === findingUrl;
  }
}

/**
 * Mute findings with a reason and a date. `until` is the last day a suppression applies (UTC): on the
 * next day it stops, is listed in `expired`, and its findings come back. Nothing is muted for ever.
 */
export function applySuppressions(
  findings: readonly Finding[],
  suppress: readonly Suppression[],
  now: Date,
): SuppressionResult {
  const today = dayOf(now);
  // ISO dates sort as text, so "is it over" is one string comparison.
  const active = suppress.filter((s) => s.until >= today);
  const expired = suppress.filter((s) => s.until < today);
  const kept: Finding[] = [];
  const suppressed: SuppressionResult["suppressed"] = [];
  for (const finding of findings) {
    const entry = active.find(
      (s) => s.id === finding.checkId && (s.url === undefined || sameAddress(s.url, finding.url)),
    );
    if (entry) suppressed.push({ finding, entry });
    else kept.push(finding);
  }
  return { kept, suppressed, expired: [...expired] };
}

/** Does this finding fail --ci? "block" any severity, "warn" never, otherwise only "Fix this first" (high). */
export function isBlocking(f: Finding, checks: Readonly<Record<string, CheckMode>>): boolean {
  const mode = checks[f.checkId];
  if (mode === "block") return true;
  if (mode === "warn") return false;
  return f.severity === "high";
}

/** The ids of the checks the config turns off, in the order it lists them. */
export function offIds(checks: Readonly<Record<string, CheckMode>>): string[] {
  return Object.entries(checks)
    .filter(([, mode]) => mode === "off")
    .map(([id]) => id);
}
