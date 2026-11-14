/**
 * What the gate Function answers, and the checks the Studio makes on it before it shows anything.
 * The reply crosses a network, so it is data: every field is checked against a fixed shape, the
 * text in it is cleaned with the shared sanitiser (N17) and capped, and anything unexpected makes
 * the whole reply unusable instead of partly trusted. Nothing here builds HTML.
 */
import { sanitise, UNTRUSTED_CAPS } from "@gaugeline/core";
import type { GateFinding, GateSeverity } from "./check.js";

/** The reply shape's version. A reply with any other value is refused. */
export const ANSWER_VERSION = 1;

/** The most findings one reply may list. More than this is refused, so a cut list is never shown as the whole. */
export const MAX_FINDINGS = 50;

/** The longest reason kept, the same cap as an evidence line. */
const REASON_CAP = UNTRUSTED_CAPS.evidence;

export type GateAnswerStatus = "clean" | "findings" | "could-not-check";

export interface GateAnswer {
  version: typeof ANSWER_VERSION;
  status: GateAnswerStatus;
  /** The page that was checked: always the address the Studio asked about. */
  url: string;
  /** When the Function read the page. Absent when the check did not reach the Function. */
  checkedAt?: string;
  /** Only the problems that hold a publish (`blockOn` and above), high first. Empty unless status is "findings". */
  findings: GateFinding[];
  /** Why the check could not run. Set only when status is "could-not-check". */
  reason?: string;
}

export type ParsedAnswer = { ok: true; answer: GateAnswer } | { ok: false; reason: string };

const STATUSES: readonly string[] = ["clean", "findings", "could-not-check"];
const SEVERITIES: readonly string[] = ["high", "medium", "low"];
const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const bad = (reason: string): ParsedAnswer => ({ ok: false, reason });
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const clean = (value: string, max: number): string => sanitise(value, max).text;

const REPLY_FIELDS = ["version", "status", "url", "checkedAt", "findings", "reason"];
const FINDING_FIELDS = ["id", "severity", "title", "evidence", "url"];
/** True when the object holds a field the agreed shape does not name. */
const hasUnknownField = (o: Record<string, unknown>, known: readonly string[]) =>
  Object.keys(o).some((k) => !known.includes(k));

function parseFinding(raw: unknown): GateFinding | undefined {
  if (!isRecord(raw) || hasUnknownField(raw, FINDING_FIELDS)) return undefined;
  const { id, severity, title, evidence, url } = raw;
  if (typeof id !== "string" || !CHECK_ID.test(id)) return undefined;
  if (typeof severity !== "string" || !SEVERITIES.includes(severity)) return undefined;
  if (typeof title !== "string" || typeof evidence !== "string" || typeof url !== "string")
    return undefined;
  return {
    id,
    severity: severity as GateSeverity,
    title: clean(title, UNTRUSTED_CAPS.title),
    evidence: clean(evidence, UNTRUSTED_CAPS.evidence),
    url: clean(url, UNTRUSTED_CAPS.evidence),
  };
}

/**
 * Checks a reply parsed from JSON. `expectedUrl` is the page the Studio asked about: a reply about
 * any other page is refused. A refusal's reason is a fixed sentence and never repeats the reply.
 */
export function parseGateAnswer(data: unknown, expectedUrl: string): ParsedAnswer {
  if (!isRecord(data)) return bad("The reply was not an object.");
  if (hasUnknownField(data, REPLY_FIELDS))
    return bad("The reply held a field this plugin does not know.");
  if (data.version !== ANSWER_VERSION)
    return bad("The reply was a version this plugin does not read.");
  const { status, url, checkedAt, findings, reason } = data;
  if (typeof status !== "string" || !STATUSES.includes(status))
    return bad("The reply had a status this plugin does not know.");
  if (url !== expectedUrl) return bad("The reply was about a different page.");
  if (
    typeof checkedAt !== "string" ||
    !TIMESTAMP.test(checkedAt) ||
    Number.isNaN(Date.parse(checkedAt))
  )
    return bad("The reply had no valid time.");
  if (!Array.isArray(findings)) return bad("The reply had no list of findings.");
  if (findings.length > MAX_FINDINGS) return bad("The reply listed too many findings.");
  const kept: GateFinding[] = [];
  for (const raw of findings) {
    const finding = parseFinding(raw);
    if (finding === undefined) return bad("A finding in the reply was not in the agreed shape.");
    kept.push(finding);
  }
  const base = { version: ANSWER_VERSION, url: expectedUrl, checkedAt } as const;
  if (status === "clean")
    return kept.length === 0
      ? { ok: true, answer: { ...base, status, findings: [] } }
      : bad("A clean reply listed findings.");
  if (status === "findings")
    return kept.length > 0
      ? { ok: true, answer: { ...base, status, findings: kept } }
      : bad("A reply of findings listed none.");
  if (typeof reason !== "string" || reason === "" || kept.length > 0)
    return bad("A could-not-check reply had no reason, or listed findings.");
  return {
    ok: true,
    answer: { ...base, status: "could-not-check", findings: [], reason: clean(reason, REASON_CAP) },
  };
}

/** An answer for a check that did not run, made on the Studio's side. Never a pass. */
export function couldNotCheck(url: string, reason: string): GateAnswer {
  return { version: ANSWER_VERSION, status: "could-not-check", url, findings: [], reason };
}
