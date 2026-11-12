/**
 * A LOCAL STAND-IN for the N17 module (`packages/core/src/untrusted.ts`, branch 06/injection-safety),
 * which exports `markUntrusted(text, { source, maxChars })` and `wrapFindingForAgent(finding)` from
 * @gaugeline/core. N17 must merge before G31 is ready; until then this file keeps the contract so the
 * tools and their tests are written against it. `agent-text.ts` is the only file that imports it: when
 * N17 is on main, that one import changes to @gaugeline/core and this file is deleted.
 *
 * Page text is DATA. It is stripped of what can hide or rewrite it (Unicode tag characters, bidi
 * controls, ANSI escapes), zero-width characters are shown as escapes, whitespace is normalised, the
 * length is capped, and it is returned inside a field that is labelled as untrusted.
 */
import type { Finding } from "@gaugeline/core";

export interface UntrustedField {
  untrusted_page_text: string;
  /** Where on the page this came from, as the checker names it (never page text itself). */
  source: string;
  /** True when the text was cut to maxChars. */
  truncated: boolean;
}

// U+E0000 to U+E007F (tag characters), U+202A to U+202E and U+2066 to U+2069 (bidi controls).
const HIDDEN = /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069]/gu;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

export function markUntrusted(
  text: string,
  opts: { source: string; maxChars: number },
): UntrustedField {
  const cleaned = text
    .replace(ANSI, "")
    .replace(HIDDEN, "")
    .replace(ZERO_WIDTH, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.length > opts.maxChars;
  return {
    untrusted_page_text: truncated ? `${cleaned.slice(0, opts.maxChars)} [cut]` : cleaned,
    source: opts.source,
    truncated,
  };
}

export interface AgentFinding {
  checkId: string;
  severity: Finding["severity"];
  /** Everything taken from the checked site, labelled. */
  untrusted: { title: UntrustedField; evidence: UntrustedField; url: UntrustedField };
}

export function wrapFindingForAgent(finding: Finding): AgentFinding {
  return {
    checkId: finding.checkId,
    severity: finding.severity,
    untrusted: {
      title: markUntrusted(finding.title, { source: "finding title", maxChars: 120 }),
      evidence: markUntrusted(finding.evidence, { source: "finding evidence", maxChars: 300 }),
      url: markUntrusted(finding.url, { source: "finding address", maxChars: 300 }),
    },
  };
}
